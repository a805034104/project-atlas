import { normalizeHttpPath } from "../model/ids.js";
import type { AtlasGraph, Entrypoint, FlowStep } from "../model/types.js";
import type { RuntimeState, TraceData, TraceDetailData, TraceRow, TraceSpanView } from "../protocol.js";
import { parseMethodKey } from "./agent-config.js";
import { spanKey, type AggregateState } from "./aggregate.js";
import type { RuntimeOverlay } from "./match.js";
import type { SpanRecord } from "./span-record.js";

/**
 * Trace tab data (U1):
 *   rows        recent traces (root route → entrypoint, coverage of its flow)
 *   diff        static vs observed: observed entrypoints, runtime-only calls (drawn or reachable), unmatched keys
 *   hint        a request that needs no login, to produce the first span
 *   detail      one trace as waterfall rows matched to static steps
 */

const OFF: RuntimeState = { status: "off", spans: 0, duplicates: 0, rejected: 0, trusted: true };

/** Entrypoints a route key `r:svc:METHOD /path` stands for. */
export function entrypointsForRouteKey(graph: AtlasGraph, key: string): Entrypoint[] {
  const m = /^r:([^:]*):(\S+) (.*)$/.exec(key);
  if (!m) return [];
  const service = graph.services.find((s) => s.name.toLowerCase() === (m[1] as string).toLowerCase());
  const path = normalizeHttpPath(m[3] as string);
  return graph.entrypoints.filter((e) => e.kind === "http" && (!service || e.serviceId === service.id) && e.path === path && (e.method === m[2] || e.method === "ANY"));
}

function suggestedRequest(graph: AtlasGraph): TraceData["suggestedRequest"] {
  const gets = graph.entrypoints.filter((e) => e.kind === "http" && (e.method === "GET" || e.method === "ANY") && e.path && !e.path.includes("{}"));
  const score = (e: Entrypoint) => (/captcha/i.test(e.path ?? "") ? 0 : /(health|ping|index|version)/i.test(e.path ?? "") ? 1 : e.path === "/" ? 2 : 3);
  const best = [...gets].sort((a, b) => score(a) - score(b) || (a.path ?? "").length - (b.path ?? "").length)[0];
  if (!best || score(best) > 2) return undefined;
  const guide = graph.startup.find((g) => g.serviceId === best.serviceId) ?? graph.startup.find((g) => g.ports.length > 0);
  const port = guide?.ports[0]?.port ?? 8080;
  return { method: "GET", url: `http://localhost:${port}${best.path}` };
}

export function emptyTraceData(graph: AtlasGraph, runtime: RuntimeState = OFF): TraceData {
  const data: TraceData = {
    runtime,
    traces: [],
    diff: { observedEntrypoints: 0, totalEntrypoints: graph.entrypoints.filter((e) => e.kind === "http").length, runtimeOnly: [], unmatched: [], links: { observed: 0, total: graph.serviceLinks.length }, runtimeLinks: [] },
    services: graph.services.filter((s) => s.stack === "java-spring").map((s) => ({ id: s.id, name: s.name })),
  };
  const hint = suggestedRequest(graph);
  if (hint) data.suggestedRequest = hint;
  return data;
}

export function buildTraceData(graph: AtlasGraph, state: AggregateState, overlay: RuntimeOverlay, runtime: RuntimeState): TraceData {
  const data = emptyTraceData(graph, runtime);
  const names = new Map(graph.steps.map((s) => [s.id, s.symbol.name]));
  data.traces = state.traces.map((t) => {
    const row: TraceRow = { traceId: t.t, start: t.start, durationMs: Math.round(t.dur * 100) / 100, error: t.err, spans: t.spans, services: t.services };
    if (t.root) {
      row.rootName = t.root.name;
      const ep = entrypointsForRouteKey(graph, t.root.key)[0];
      if (ep) {
        row.entrypointId = ep.id;
        const cov = overlay.coverage[ep.id];
        if (cov) row.coverage = cov;
      }
    }
    return row;
  });
  data.diff = {
    observedEntrypoints: Object.keys(overlay.entrypoints).length,
    totalEntrypoints: data.diff.totalEntrypoints,
    runtimeOnly: [
      ...overlay.runtimeEdges.map((e) => ({ from: names.get(e.from) ?? e.from, to: names.get(e.to) ?? e.to, count: e.observed.count, async: e.async, drawn: true })),
      ...overlay.reachability.map((r) => ({ from: names.get(r.from) ?? r.from, to: names.get(r.to) ?? r.to, count: r.count, async: r.async, drawn: false })),
    ].sort((a, b) => b.count - a.count),
    unmatched: overlay.unmatched.map((u) => ({ key: u.key.replace(/^[a-z]:/, ""), count: u.count, reason: u.reason })),
    links: { observed: Object.keys(overlay.links).length, total: graph.serviceLinks.length },
    runtimeLinks: overlay.runtimeLinks,
  };
  return data;
}

/** Waterfall rows for one trace, each matched to a static step when the key is unambiguous. */
export function buildTraceDetail(graph: AtlasGraph, records: readonly SpanRecord[]): TraceDetailData | undefined {
  if (records.length === 0) return undefined;
  const byMethod = new Map<string, FlowStep[]>();
  for (const s of graph.steps) {
    const parsed = parseMethodKey(s.symbol.fqn);
    if (!parsed || (s.layer === "interceptor" && s.symbol.name.startsWith("@"))) continue;
    const key = `${parsed.cls}#${parsed.method}`;
    byMethod.set(key, [...(byMethod.get(key) ?? []), s]);
  }
  const sorted = [...records].sort((a, b) => a.start - b.start);
  const t0 = sorted[0]?.start ?? 0;
  const ends = new Map(sorted.map((r) => [r.s, r.start + r.dur]));
  let entrypointId: string | undefined;
  const spans: TraceSpanView[] = sorted.map((r) => {
    const key = spanKey(r);
    const view: TraceSpanView = {
      spanId: r.s,
      name: r.name,
      service: r.svc,
      offsetMs: Math.round((r.start - t0) * 100) / 100,
      durationMs: Math.round(r.dur * 100) / 100,
      error: r.err,
      async: !!r.p && r.start >= (ends.get(r.p) ?? Number.POSITIVE_INFINITY),
    };
    if (r.p) view.parentSpanId = r.p;
    if (key.startsWith("m:")) {
      const candidates = byMethod.get(key.slice(2)) ?? [];
      const plain = candidates.filter((c) => c.layer !== "aspect");
      const chosen = plain.length > 0 ? (new Set(plain.map((c) => c.symbol.fqn)).size === 1 ? plain[0] : undefined) : candidates[0];
      if (chosen) {
        view.stepId = chosen.id;
        view.layer = chosen.layer;
      }
    } else if (key.startsWith("d:")) view.layer = /redis|memcached|mongo|elasticsearch|cassandra/i.test(r.a.dbSystem ?? "") ? "cache" : "sql";
    else if (key.startsWith("r:")) {
      view.layer = "entrypoint";
      entrypointId ??= entrypointsForRouteKey(graph, key)[0]?.id;
    } else if (key.startsWith("q:")) view.layer = "mq";
    return view;
  });
  // SQL spans: the unique SQL step under the parent's step (mapper → <select>).
  const stepOfSpan = new Map(spans.filter((s) => s.stepId).map((s) => [s.spanId, s.stepId as string]));
  const layerOf = new Map(graph.steps.map((s) => [s.id, s.layer]));
  for (const view of spans) {
    if (view.layer !== "sql" || view.stepId || !view.parentSpanId) continue;
    const parentStep = stepOfSpan.get(view.parentSpanId);
    if (!parentStep) continue;
    const childrenOf = (id: string, layer: string) => [...new Set(graph.edges.filter((e) => e.from === id && layerOf.get(e.to) === layer).map((e) => e.to))];
    let sql = childrenOf(parentStep, "sql");
    if (sql.length === 0) {
      // MyBatis instrumentation off: JDBC under the service method; only an unambiguous mapper counts.
      const mappers = childrenOf(parentStep, "repository").filter((m) => childrenOf(m, "sql").length > 0);
      if (mappers.length === 1) sql = childrenOf(mappers[0] as string, "sql");
    }
    if (sql.length === 1) view.stepId = sql[0] as string;
  }
  return { traceId: sorted[0]?.t ?? "", start: t0, ...(entrypointId ? { entrypointId } : {}), spans };
}
