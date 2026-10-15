import { normalizeHttpPath, stableId } from "../model/ids.js";
import type { AtlasGraph, CallEdge, FlowLayer, FlowStep, RuntimeStats } from "../model/types.js";
import { parseMethodKey } from "./agent-config.js";
import { parseMethodSpanKey, statsQuantile, type AggregateState, type Stats } from "./aggregate.js";

/**
 * Reconcile runtime aggregates with the static graph (R2).
 *
 *   key m:svc:Class#method ─▶ method steps of that service (overloads with several matches, or an
 *                         unknown service name with candidates in several services → ambiguous)
 *       aspect advice  ─▶ the aspect steps whose target step was observed
 *   key r:svc:GET /p   ─▶ entrypoint (path variables normalised, context-path included)
 *   key d:svc:OP table ─▶ sql step under the observed mapper (or the only mapper of the
 *                         observed service method when MyBatis instrumentation is off)
 *   edge P>C           ─▶ static edge P→C          observed stats on the edge
 *                      ─▶ static path P⇝C           "runtime reachable" (gap frames)
 *                      ─▶ no path, same class, P not an aspect
 *                                                  runtime-observed edge (V7: a same-class helper the
 *                                                  static rules inline; nothing can sit in between)
 *                      ─▶ otherwise                 reachable only (an uninstrumented frame — framework
 *                                                  dispatch, unreached project code, reflection — may sit
 *                                                  in between, so no edge is drawn)
 *   chain edges (filters → interceptors → controller) are observed when both ends are.
 */

export interface RuntimeEdge {
  id: string;
  from: string;
  to: string;
  async: boolean;
  observed: RuntimeStats;
}

export interface RuntimeOverlay {
  steps: Record<string, RuntimeStats>;
  edges: Record<string, RuntimeStats>;
  entrypoints: Record<string, RuntimeStats>;
  runtimeEdges: RuntimeEdge[];
  reachability: { from: string; to: string; count: number; async: boolean }[];
  unmatched: { key: string; count: number; reason: "no-step" | "ambiguous" | "stale" }[];
  /** entrypointId → observed / instrumentable steps on its flow */
  coverage: Record<string, { observed: number; instrumentable: number }>;
  /** ServiceLink id → observed (AC#22: HTTP client→server pairs, MQ consumers, Redis stream both sides). */
  links: Record<string, RuntimeStats>;
  /** Cross-service traffic seen at runtime that no static link covers. */
  runtimeLinks: { fromService: string; toService: string; kind: "http" | "mq"; channel: string; count: number }[];
}

// Not "mq" / "external-http": those steps carry the enclosing method's symbol (a send inside
// OrderService.create), so a method span says nothing about whether the send ran.
const METHOD_LAYERS = new Set<FlowLayer>(["filter", "interceptor", "controller", "service", "repository", "cache"]);
/** Layers that produce a span when instrumented (V4); used for the V7 "every caller instrumented" test. */
const SPAN_LAYERS = new Set<FlowLayer>(["filter", "interceptor", "aspect", "controller", "service", "repository"]);
const COVERAGE_LAYERS = new Set<FlowLayer>(["filter", "interceptor", "aspect", "controller", "service", "repository", "sql"]);
const MAX_PATH_DEPTH = 8;

export function toRuntimeStats(stats: Stats): RuntimeStats {
  return {
    count: stats.count,
    p50Ms: round(statsQuantile(stats, 0.5)),
    p95Ms: round(statsQuantile(stats, 0.95)),
    errorCount: stats.err,
    lastSeen: new Date(stats.lastSeen).toISOString(),
    sampleTraceIds: [...stats.samples],
  };
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}

function mergeStats(a: RuntimeStats | undefined, b: RuntimeStats): RuntimeStats {
  if (!a) return b;
  return {
    count: a.count + b.count,
    p50Ms: Math.max(a.p50Ms, b.p50Ms),
    p95Ms: Math.max(a.p95Ms, b.p95Ms),
    errorCount: a.errorCount + b.errorCount,
    lastSeen: a.lastSeen > b.lastSeen ? a.lastSeen : b.lastSeen,
    sampleTraceIds: [...new Set([...a.sampleTraceIds, ...b.sampleTraceIds])].slice(0, 5),
  };
}

/** `@PreAuthorize` and similar annotation steps: part of the chain, never a span. */
function isMarker(step: FlowStep | undefined): boolean {
  return !!step && step.layer === "interceptor" && step.symbol.name.startsWith("@");
}

export function reconcile(graph: AtlasGraph, state: AggregateState): RuntimeOverlay {
  const overlay: RuntimeOverlay = { steps: {}, edges: {}, entrypoints: {}, runtimeEdges: [], reachability: [], unmatched: [], coverage: {}, links: {}, runtimeLinks: [] };
  const stepById = new Map(graph.steps.map((s) => [s.id, s]));
  const outgoing = new Map<string, CallEdge[]>();
  const incoming = new Map<string, CallEdge[]>();
  for (const e of graph.edges) {
    (outgoing.get(e.from) ?? outgoing.set(e.from, []).get(e.from))?.push(e);
    (incoming.get(e.to) ?? incoming.set(e.to, []).get(e.to))?.push(e);
  }
  const serviceIdByName = new Map(graph.services.map((s) => [s.name.toLowerCase(), s.id]));

  // ── Indexes ────────────────────────────────────────────────────────────────
  const methodSteps = new Map<string, FlowStep[]>();
  const aspectSteps = new Map<string, FlowStep[]>();
  const knownClasses = new Set<string>();
  for (const step of graph.steps) {
    const parsed = parseMethodKey(step.symbol.fqn);
    if (!parsed) continue;
    knownClasses.add(parsed.cls);
    const key = `${parsed.cls}#${parsed.method}`;
    if (step.layer === "aspect") (aspectSteps.get(key) ?? aspectSteps.set(key, []).get(key))?.push(step);
    else if (METHOD_LAYERS.has(step.layer) && !(step.layer === "interceptor" && step.symbol.name.startsWith("@"))) {
      (methodSteps.get(key) ?? methodSteps.set(key, []).get(key))?.push(step);
    }
  }

  const unmatched = (key: string, count: number, reason: RuntimeOverlay["unmatched"][number]["reason"]) => overlay.unmatched.push({ key, count, reason });

  /** Steps a span key stands for ([] = not mapped; undefined = ambiguous, already reported). */
  const resolved = new Map<string, FlowStep[] | undefined>();
  const resolveKey = (key: string): FlowStep[] | undefined => {
    if (resolved.has(key)) return resolved.get(key);
    let out: FlowStep[] | undefined = [];
    const parsed = parseMethodSpanKey(key);
    if (parsed) {
      const all = methodSteps.get(parsed.method) ?? [];
      const serviceId = serviceIdByName.get(parsed.svc.toLowerCase());
      // Unknown service name (OTEL_SERVICE_NAME override): only an answer confined to one service counts.
      const candidates = serviceId ? all.filter((c) => c.serviceId === serviceId) : new Set(all.map((c) => c.serviceId)).size > 1 ? undefined : all;
      if (!candidates || new Set(candidates.map((c) => c.symbol.fqn)).size > 1) out = undefined;
      else out = candidates;
    }
    resolved.set(key, out);
    return out;
  };

  // ── Nodes ──────────────────────────────────────────────────────────────────
  for (const [key, stats] of Object.entries(state.nodes)) {
    const rs = toRuntimeStats(stats);
    const parsedKey = parseMethodSpanKey(key);
    if (parsedKey) {
      const steps = resolveKey(key);
      const mk = parsedKey.method;
      if (steps === undefined) unmatched(key, stats.count, "ambiguous");
      else if (steps.length > 0) for (const s of steps) overlay.steps[s.id] = mergeStats(overlay.steps[s.id], rs);
      else if (!aspectSteps.has(mk)) unmatched(key, stats.count, knownClasses.has(mk.split("#")[0] as string) ? "no-step" : "stale");
    } else if (key.startsWith("r:")) {
      const eps = entrypointsForRouteKey(graph, key);
      if (eps === undefined) unmatched(key, stats.count, "ambiguous");
      else if (eps.length === 0) unmatched(key, stats.count, "no-step");
      for (const e of eps ?? []) overlay.entrypoints[e.id] = mergeStats(overlay.entrypoints[e.id], rs);
    }
  }
  // Aspect advice: credit the aspect steps whose target (next hop) ran.
  for (const [key, stats] of Object.entries(state.nodes)) {
    const parsedKey = parseMethodSpanKey(key);
    const serviceId = parsedKey && serviceIdByName.get(parsedKey.svc.toLowerCase());
    const steps = parsedKey ? (aspectSteps.get(parsedKey.method) ?? []).filter((s) => !serviceId || s.serviceId === serviceId) : [];
    for (const s of steps) {
      const targets = (outgoing.get(s.id) ?? []).map((e) => e.to);
      if (targets.some((t) => overlay.steps[t])) overlay.steps[s.id] = mergeStats(overlay.steps[s.id], toRuntimeStats(stats));
    }
  }

  // ── Edges ──────────────────────────────────────────────────────────────────
  /** Shortest static path from → to (edges), or undefined. */
  const staticPath = (from: string, to: string): CallEdge[] | undefined => {
    const via = new Map<string, CallEdge>();
    let frontier = [from];
    for (let depth = 0; depth < MAX_PATH_DEPTH && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const e of outgoing.get(id) ?? []) {
          if (e.to === from || via.has(e.to)) continue;
          via.set(e.to, e);
          if (e.to === to) {
            const path: CallEdge[] = [];
            for (let cur: CallEdge | undefined = e; cur; cur = cur.from === from ? undefined : via.get(cur.from)) path.unshift(cur);
            return path;
          }
          next.push(e.to);
        }
      }
      frontier = next;
    }
    return undefined;
  };
  const sqlUnder = (step: FlowStep): FlowStep[] => {
    const direct = (outgoing.get(step.id) ?? []).map((e) => stepById.get(e.to)).filter((s): s is FlowStep => s?.layer === "sql");
    if (step.layer === "repository" || direct.length > 0) return direct;
    // MyBatis instrumentation off: JDBC spans hang under the service method; only an unambiguous mapper counts.
    const mappers = (outgoing.get(step.id) ?? []).map((e) => stepById.get(e.to)).filter((s): s is FlowStep => s?.layer === "repository");
    const withSql = mappers.filter((m) => (outgoing.get(m.id) ?? []).some((e) => stepById.get(e.to)?.layer === "sql"));
    return withSql.length === 1 ? sqlUnder(withSql[0] as FlowStep) : [];
  };
  const reachKey = new Map<string, RuntimeOverlay["reachability"][number]>();

  for (const [edgeKey, stats] of Object.entries(state.edges)) {
    const gt = edgeKey.indexOf(">");
    const parentKey = edgeKey.slice(0, gt);
    const childKey = edgeKey.slice(gt + 1);
    const parents = resolveKey(parentKey);
    const rs = toRuntimeStats(stats);
    if (!parents || parents.length === 0) continue;

    if (childKey.startsWith("d:")) {
      for (const p of parents) {
        const sql = sqlUnder(p);
        if (sql.length !== 1) continue;
        const target = sql[0] as FlowStep;
        overlay.steps[target.id] = mergeStats(overlay.steps[target.id], rs);
        const viaMapper = p.layer !== "repository" ? (outgoing.get(p.id) ?? []).map((e) => stepById.get(e.to)).find((m) => m?.layer === "repository" && (outgoing.get(m.id) ?? []).some((x) => x.to === target.id)) : undefined;
        if (viaMapper) overlay.steps[viaMapper.id] = mergeStats(overlay.steps[viaMapper.id], rs);
        for (const e of incoming.get(target.id) ?? []) if (e.from === p.id || e.from === viaMapper?.id) overlay.edges[e.id] = mergeStats(overlay.edges[e.id], rs);
        if (viaMapper) for (const e of outgoing.get(p.id) ?? []) if (e.to === viaMapper.id) overlay.edges[e.id] = mergeStats(overlay.edges[e.id], rs);
      }
      continue;
    }
    const children = resolveKey(childKey);
    if (!children || children.length === 0) continue;
    for (const p of parents) {
      for (const c of children) {
        if (p.id === c.id) continue; // overload nesting (TokenService.createToken → private createToken)
        const direct = (outgoing.get(p.id) ?? []).filter((e) => e.to === c.id);
        if (direct.length > 0) {
          for (const e of direct) overlay.edges[e.id] = mergeStats(overlay.edges[e.id], rs);
          continue;
        }
        const path = staticPath(p.id, c.id);
        // Every intermediate step ran too (e.g. controller → @Before aspect → service): the path is observed.
        if (path && path.slice(0, -1).every((e) => overlay.steps[e.to] || isMarker(stepById.get(e.to)))) {
          for (const e of path) overlay.edges[e.id] = mergeStats(overlay.edges[e.id], rs);
          continue;
        }
        const viaGap = !!path;
        // S0: SysLoginService.login ⇝ selectUserByUserName runs through Spring Security and an
        // unreached UserDetailsService; only a same-class call is certain to be direct.
        const sameClass = parseMethodKey(p.symbol.fqn)?.cls === parseMethodKey(c.symbol.fqn)?.cls;
        if (!viaGap && p.layer !== "aspect" && sameClass && p.serviceId === c.serviceId && SPAN_LAYERS.has(p.layer) && SPAN_LAYERS.has(c.layer)) {
          overlay.runtimeEdges.push({ id: stableId("edge", "", `runtime|${p.id}|${c.id}`), from: p.id, to: c.id, async: !!stats.async, observed: rs });
        } else {
          const k = `${p.id}|${c.id}`;
          const r = reachKey.get(k) ?? { from: p.id, to: c.id, count: 0, async: !!stats.async };
          r.count += stats.count;
          reachKey.set(k, r);
        }
      }
    }
  }
  overlay.reachability = [...reachKey.values()];

  // Chain edges (filter → … → controller, per entrypoint): observed when both ends ran.
  for (const e of graph.edges) {
    if (!e.chain || overlay.edges[e.id]) continue;
    const to = overlay.steps[e.to];
    if (to && overlay.steps[e.from]) overlay.edges[e.id] = to;
  }

  reconcileLinks(graph, state, overlay);

  // ── Coverage per entrypoint flow ───────────────────────────────────────────
  for (const flow of graph.flows) {
    let instrumentable = 0;
    let observed = 0;
    for (const id of flow.stepIds) {
      const s = stepById.get(id);
      if (!s || !COVERAGE_LAYERS.has(s.layer)) continue;
      if (isMarker(s)) continue; // @PreAuthorize marker: no span exists
      instrumentable++;
      if (overlay.steps[id]) observed++;
    }
    if (observed > 0 || overlay.entrypoints[flow.entrypointId]) overlay.coverage[flow.entrypointId] = { observed, instrumentable };
  }
  return overlay;
}

/**
 * Cross-service confirmation (AC#22):
 *   h:A:GET peer > r:B:GET /p                    HTTP / Feign / gateway hop A → B on that entrypoint
 *   q:kafka|rabbitmq|rocketmq:consumer:B:dest   consumer of a topic / queue (context propagates)
 *   d:A:XADD key  +  d:B:XREAD(GROUP) key       Redis stream: no context, both sides on one key
 */
function reconcileLinks(graph: AtlasGraph, state: AggregateState, overlay: RuntimeOverlay): void {
  const serviceName = new Map(graph.services.map((s) => [s.id, s.name.toLowerCase()]));
  const mark = (linkId: string, stats: Stats) => (overlay.links[linkId] = mergeStats(overlay.links[linkId], toRuntimeStats(stats)));
  const extra = new Map<string, RuntimeOverlay["runtimeLinks"][number]>();
  const runtimeOnly = (fromService: string, toService: string, kind: "http" | "mq", channel: string, count: number) => {
    const k = `${fromService}|${toService}|${kind}|${channel}`;
    const e = extra.get(k) ?? { fromService, toService, kind, channel, count: 0 };
    e.count += count;
    extra.set(k, e);
  };

  // HTTP: a client span in A whose child is a server span in B.
  for (const [edgeKey, stats] of Object.entries(state.edges)) {
    const gt = edgeKey.indexOf(">");
    const parent = edgeKey.slice(0, gt);
    const child = edgeKey.slice(gt + 1);
    if (!parent.startsWith("h:") || !child.startsWith("r:")) continue;
    const from = parent.split(":")[1]?.toLowerCase() ?? "";
    const to = child.split(":")[1]?.toLowerCase() ?? "";
    if (!from || from === to) continue;
    const eps = new Set((entrypointsForRouteKey(graph, child) ?? []).map((e) => e.id));
    const links = graph.serviceLinks.filter((l) => l.toEntrypointId && eps.has(l.toEntrypointId) && serviceName.get(l.fromServiceId) === from);
    for (const l of links) mark(l.id, stats);
    if (links.length === 0) runtimeOnly(from, to, "http", child.slice(child.indexOf(":", 2) + 1), stats.count);
  }

  // Message queues: a consumer service seen on the channel, and the link's producer service seen
  // sending on it (a second producer of the same topic is not confirmed by the first one's traffic).
  const consumed = new Map<string, Map<string, Stats>>();
  const produced = new Map<string, Set<string>>();
  const consume = (channelKey: string, svc: string, stats: Stats) => {
    const bySvc = consumed.get(channelKey) ?? new Map<string, Stats>();
    bySvc.set(svc, stats);
    consumed.set(channelKey, bySvc);
  };
  for (const [key, stats] of Object.entries(state.nodes)) {
    const q = /^q:([^:]+):(consumer|producer|client|server|internal|unspecified):([^:]*):(.*)$/.exec(key);
    if (q) {
      const system = (q[1] as string).toLowerCase();
      const svc = (q[3] as string).toLowerCase();
      const channelKey = `${system}:${q[4] as string}`;
      if (q[2] === "consumer") consume(channelKey, svc, stats);
      else if (q[2] === "producer") produced.set(channelKey, (produced.get(channelKey) ?? new Set<string>()).add(svc));
      continue;
    }
    // Redis streams: XADD / XREAD(GROUP) on the same key.
    const d = /^d:([^:]*):(XADD|XREADGROUP|XREAD) (.+)$/.exec(key);
    if (d) {
      const channelKey = `redis-stream:${d[3] as string}`;
      const svc = (d[1] as string).toLowerCase();
      if (d[2] === "XADD") produced.set(channelKey, (produced.get(channelKey) ?? new Set<string>()).add(svc));
      else consume(channelKey, svc, stats);
    }
  }
  const flowByEntrypoint = new Map(graph.flows.map((f) => [f.entrypointId, f]));
  const stepById = new Map(graph.steps.map((s) => [s.id, s]));
  /** The consumer's handler step was observed. */
  const consumerRan = (entrypointId: string | undefined): boolean => {
    const flow = entrypointId ? flowByEntrypoint.get(entrypointId) : undefined;
    return (flow?.stepIds ?? []).some((id) => SPAN_LAYERS.has(stepById.get(id)?.layer as FlowLayer) && overlay.steps[id] !== undefined);
  };
  for (const [channelKey, bySvc] of consumed) {
    const colon = channelKey.indexOf(":");
    const system = channelKey.slice(0, colon);
    const dest = channelKey.slice(colon + 1);
    const producers = produced.get(channelKey) ?? new Set<string>();
    for (const [svc, stats] of bySvc) {
      const onChannel = graph.serviceLinks.filter((l) => l.kind === "mq" && serviceName.get(l.toServiceId) === svc && (l.channel === `${system}:${dest}` || l.channel === `stream:${dest}`));
      const fromSeen = onChannel.filter((l) => producers.has(serviceName.get(l.fromServiceId) ?? ""));
      // Several links between the same services on one channel (RocketMQ tags, @KafkaHandler by
      // payload type): the consumer span cannot tell them apart, only the handler that ran can.
      const siblings = (l: (typeof onChannel)[number]) => fromSeen.filter((o) => o.fromServiceId === l.fromServiceId).length;
      const confirmed = fromSeen.filter((l) => siblings(l) === 1 || consumerRan(l.toEntrypointId));
      for (const l of confirmed) mark(l.id, stats);
      // Redis streams carry no trace context: without a producer seen, nothing is claimed.
      if (onChannel.length === 0 && (system !== "redis-stream" || producers.size > 0)) {
        for (const from of producers.size > 0 ? producers : new Set(["?"])) runtimeOnly(from, svc, "mq", `${system}:${dest}`, stats.count);
      }
    }
  }
  overlay.runtimeLinks = [...extra.values()];
}

/**
 * Entrypoints a route key `r:svc:METHOD /path` stands for; undefined when the service name is
 * unknown (OTEL_SERVICE_NAME override, unknown_service:java) and the route exists in several services.
 */
export function entrypointsForRouteKey(graph: AtlasGraph, key: string): AtlasGraph["entrypoints"] | undefined {
  const m = /^r:(.*):([A-Z]+) (.*)$/.exec(key);
  if (!m) return [];
  const service = graph.services.find((s) => s.name.toLowerCase() === (m[1] as string).toLowerCase());
  const path = normalizeHttpPath(m[3] as string);
  const eps = graph.entrypoints.filter((e) => e.kind === "http" && (!service || e.serviceId === service.id) && e.path === path && (e.method === m[2] || e.method === "ANY"));
  return !service && new Set(eps.map((e) => e.serviceId)).size > 1 ? undefined : eps;
}

/** Graph with the overlay folded in (observed fields + runtime-observed edges); the input is not modified. */
export function applyOverlay(graph: AtlasGraph, overlay: RuntimeOverlay): AtlasGraph {
  const runtimeEdges: CallEdge[] = overlay.runtimeEdges.map((r) => ({ id: r.id, from: r.from, to: r.to, order: 1000, provenance: "runtime-observed", confidence: 1, rationale: r.async ? "observed at runtime (async)" : "observed at runtime", observed: r.observed }));
  return {
    ...graph,
    steps: graph.steps.map((s) => (overlay.steps[s.id] ? { ...s, observed: overlay.steps[s.id] as RuntimeStats } : s)),
    edges: [...graph.edges.map((e) => (overlay.edges[e.id] ? { ...e, observed: overlay.edges[e.id] as RuntimeStats } : e)), ...runtimeEdges],
    entrypoints: graph.entrypoints.map((e) => (overlay.entrypoints[e.id] ? { ...e, observed: overlay.entrypoints[e.id] as RuntimeStats } : e)),
    serviceLinks: graph.serviceLinks.map((l) => (overlay.links[l.id] ? { ...l, observed: overlay.links[l.id] as RuntimeStats } : l)),
  };
}
