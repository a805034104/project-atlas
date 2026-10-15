import {
  type AggregateState,
  cmp,
  compareEntrypoints,
  createRefFormatter,
  entrypointLabel,
  entrypointsForRouteKey,
  findEntrypoints,
  flowStepLines,
  MAX_FLOW_DEPTH,
  type Entrypoint,
  type EntrypointKind,
  type GraphView,
  type RefFormatter,
} from "@project-atlas/core";

/**
 * The five read-only MCP tools (spec T2) as pure functions over a GraphView.
 * Each returns compact, deterministic text for the model plus the same facts
 * as structured JSON. Bad input → ToolInputError (reported as a tool error).
 *
 *   list_services ─┐
 *   list_entrypoints ─┤
 *   get_flow ─────────┼─▶ GraphView (loaded from .atlas/graph) ─▶ { text, data }
 *   find_symbol ──────┤
 *   get_module_history┘
 */

export interface ToolOutput<T extends Record<string, unknown> = Record<string, unknown>> {
  text: string;
  data: T;
}

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export const DEFAULT_ENTRYPOINT_LIMIT = 100;
export const DEFAULT_SYMBOL_LIMIT = 20;
export const DEFAULT_COMMIT_LIMIT = 20;
const MAX_FLOWS_PER_SYMBOL = 10;

function serviceNames(view: GraphView): Map<string, string> {
  return new Map(view.graph.services.map((s) => [s.id, s.name]));
}

function entrypointJson(e: Entrypoint, service: string, fmt: RefFormatter) {
  return {
    id: e.id,
    label: entrypointLabel(e),
    kind: e.kind,
    ...(e.method ? { method: e.method } : {}),
    ...(e.path !== undefined ? { path: e.path } : {}),
    service,
    handler: e.handler.name,
    location: fmt(e.handler),
  };
}

// ── list_services ────────────────────────────────────────────────────────────

export function listServices(view: GraphView): ToolOutput {
  const g = view.graph;
  const fmt = createRefFormatter(g);
  const services = [...g.services]
    .sort((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id))
    .map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      stack: s.stack,
      path: fmt({ rootId: s.rootId, file: s.path }).replace(/\/$/, "") || ".",
      entrypoints: g.entrypoints.filter((e) => e.serviceId === s.id).length,
      modules: g.modules.filter((m) => m.serviceId === s.id).length,
    }));
  const names = serviceNames(view);
  const links = new Map<string, number>();
  for (const l of g.serviceLinks) {
    const key = `${names.get(l.fromServiceId) ?? l.fromServiceId} → ${names.get(l.toServiceId) ?? l.toServiceId} (${l.kind})`;
    links.set(key, (links.get(key) ?? 0) + 1);
  }
  const linkList = [...links.entries()].sort((a, b) => cmp(a[0], b[0])).map(([link, count]) => ({ link, count }));
  const text = [
    `${g.project.name}: ${services.length} service(s), analyzed ${g.project.analyzedAt}`,
    ...services.map((s) => `- ${s.name} [${s.kind}, ${s.stack}] ${s.path} — ${s.entrypoints} entrypoint(s), ${s.modules} module(s)`),
    ...(linkList.length > 0 ? ["Cross-service links:", ...linkList.map((l) => `- ${l.link} ×${l.count}`)] : []),
  ].join("\n");
  return { text, data: { project: g.project.name, analyzedAt: g.project.analyzedAt, services, links: linkList } };
}

// ── list_entrypoints ─────────────────────────────────────────────────────────

export interface ListEntrypointsArgs {
  service?: string | undefined;
  kind?: EntrypointKind | undefined;
  method?: string | undefined;
  pathContains?: string | undefined;
  limit?: number | undefined;
}

export function listEntrypoints(view: GraphView, args: ListEntrypointsArgs = {}): ToolOutput {
  const g = view.graph;
  const fmt = createRefFormatter(g);
  const names = serviceNames(view);
  let serviceIds: Set<string> | undefined;
  if (args.service) {
    const wanted = args.service.toLowerCase();
    serviceIds = new Set(g.services.filter((s) => s.id === args.service || s.name.toLowerCase() === wanted).map((s) => s.id));
    if (serviceIds.size === 0) throw new ToolInputError(`Unknown service "${args.service}". Known services: ${[...names.values()].sort(cmp).join(", ")}`);
  }
  const method = args.method?.toUpperCase();
  const needle = args.pathContains?.toLowerCase();
  const limit = args.limit ?? DEFAULT_ENTRYPOINT_LIMIT;
  const matched = g.entrypoints
    .filter(
      (e) =>
        (!serviceIds || serviceIds.has(e.serviceId)) &&
        (!args.kind || e.kind === args.kind) &&
        (!method || e.method === method) &&
        (!needle || (e.path ?? e.handler.name).toLowerCase().includes(needle)),
    )
    .sort(compareEntrypoints);
  const shown = matched.slice(0, limit);
  const entrypoints = shown.map((e) => entrypointJson(e, names.get(e.serviceId) ?? e.serviceId, fmt));
  const text = [
    `${matched.length} entrypoint(s) match${matched.length > shown.length ? `; showing ${shown.length} (raise limit or narrow filters)` : ""}`,
    ...entrypoints.map((e) => `- ${e.label} [${e.service}] → ${e.handler} (${e.location}) id=${e.id}`),
  ].join("\n");
  return { text, data: { total: matched.length, returned: shown.length, entrypoints } };
}

// ── get_flow ─────────────────────────────────────────────────────────────────

export interface GetFlowArgs {
  entrypoint: string;
  depth?: number | undefined;
}

export function getFlow(view: GraphView, args: GetFlowArgs): ToolOutput {
  const g = view.graph;
  const names = serviceNames(view);
  const matches = findEntrypoints(g, args.entrypoint);
  if (matches.length === 0) {
    throw new ToolInputError(`No entrypoint matches "${args.entrypoint}". Use list_entrypoints (e.g. pathContains) to find the label or id; labels look like "GET /system/user/list".`);
  }
  if (matches.length > 1) {
    throw new ToolInputError(
      `"${args.entrypoint}" matches ${matches.length} entrypoints; pass one id:\n${matches.map((e) => `- ${e.id} ${entrypointLabel(e)} [${names.get(e.serviceId) ?? e.serviceId}]`).join("\n")}`,
    );
  }
  const entrypoint = matches[0] as Entrypoint;
  const depth = args.depth === undefined ? undefined : Math.min(Math.max(1, args.depth), MAX_FLOW_DEPTH);
  const detail = view.flowDetail(entrypoint.id, depth);
  if (!detail) throw new ToolInputError(`Entrypoint ${entrypointLabel(entrypoint)} has no stored flow; re-run the analysis.`);
  const fmt = createRefFormatter(g);
  const service = names.get(entrypoint.serviceId) ?? entrypoint.serviceId;
  const lines = flowStepLines(detail, fmt);
  const text = [
    `${entrypointLabel(entrypoint)} [${service}] → ${entrypoint.handler.name} (${fmt(entrypoint.handler)})`,
    ...lines.map((l, i) => `${i + 1}. ${l}`),
    ...(detail.steps.length === 0 ? ["(no call-graph steps recorded)"] : []),
    ...(detail.flow.truncated ? [`(cut at depth ${depth ?? "default"}; call again with a larger depth, max ${MAX_FLOW_DEPTH})`] : []),
    ...(detail.unresolvedCalls.length > 0 ? ["Unresolved calls (no edge generated):", ...detail.unresolvedCalls.map((u) => `- ${u.expression} ${u.reason} (${fmt(u.at)})`)] : []),
  ].join("\n");
  return {
    text,
    data: {
      entrypoint: entrypointJson(entrypoint, service, fmt),
      truncated: detail.flow.truncated,
      steps: detail.steps.map((s, i) => ({
        index: i + 1,
        id: s.id,
        layer: s.layer,
        symbol: s.symbol.name,
        fqn: s.symbol.fqn,
        location: fmt(s.symbol),
        service: names.get(s.serviceId) ?? s.serviceId,
        ...(s.observed ? { observed: { count: s.observed.count, p50Ms: s.observed.p50Ms, p95Ms: s.observed.p95Ms, errors: s.observed.errorCount, lastSeen: s.observed.lastSeen } } : {}),
      })),
      unresolvedCalls: detail.unresolvedCalls.map((u) => ({ expression: u.expression, reason: u.reason, location: fmt(u.at) })),
    },
  };
}

// ── find_symbol ──────────────────────────────────────────────────────────────

export interface FindSymbolArgs {
  query: string;
  limit?: number | undefined;
}

export function findSymbol(view: GraphView, args: FindSymbolArgs): ToolOutput {
  const g = view.graph;
  const q = args.query.trim().toLowerCase();
  if (!q) throw new ToolInputError("query must not be empty.");
  const fmt = createRefFormatter(g);
  const names = serviceNames(view);
  const limit = args.limit ?? DEFAULT_SYMBOL_LIMIT;
  const matched = g.steps
    .filter((s) => s.symbol.name.toLowerCase().includes(q) || s.symbol.fqn.toLowerCase().includes(q))
    .sort((a, b) => cmp(a.symbol.name, b.symbol.name) || cmp(fmt(a.symbol), fmt(b.symbol)) || cmp(a.id, b.id));
  const shown = matched.slice(0, limit);
  const wanted = new Set(shown.map((s) => s.id));
  const entrypoints = new Map(g.entrypoints.map((e) => [e.id, e]));
  const flowsOf = new Map<string, Entrypoint[]>();
  for (const f of g.flows) {
    const ep = entrypoints.get(f.entrypointId);
    if (!ep) continue;
    for (const id of f.stepIds) if (wanted.has(id)) flowsOf.set(id, [...(flowsOf.get(id) ?? []), ep]);
  }
  const steps = shown.map((s) => {
    const flows = (flowsOf.get(s.id) ?? []).sort(compareEntrypoints);
    return {
      id: s.id,
      layer: s.layer,
      symbol: s.symbol.name,
      fqn: s.symbol.fqn,
      location: fmt(s.symbol),
      service: names.get(s.serviceId) ?? s.serviceId,
      flowCount: flows.length,
      flows: flows.slice(0, MAX_FLOWS_PER_SYMBOL).map((e) => entrypointLabel(e)),
    };
  });
  const text = [
    `${matched.length} step(s) match "${args.query}"${matched.length > shown.length ? `; showing ${shown.length}` : ""}`,
    ...steps.map((s) => {
      const flows = s.flowCount === 0 ? "in no stored flow" : `in ${s.flowCount} flow(s): ${s.flows.join(", ")}${s.flowCount > s.flows.length ? ", …" : ""}`;
      return `- ${s.layer} · ${s.symbol} (${s.location}) [${s.service}] ${flows}`;
    }),
  ].join("\n");
  return { text, data: { total: matched.length, returned: shown.length, steps } };
}

// ── get_module_history ───────────────────────────────────────────────────────

export interface GetModuleHistoryArgs {
  module: string;
  limit?: number | undefined;
}

export function getModuleHistory(view: GraphView, args: GetModuleHistoryArgs): ToolOutput {
  const g = view.graph;
  const names = serviceNames(view);
  const byId = g.modules.filter((m) => m.id === args.module);
  const byName = byId.length > 0 ? byId : g.modules.filter((m) => m.name === args.module);
  const matches = byName.length > 0 ? byName : g.modules.filter((m) => m.name.toLowerCase() === args.module.toLowerCase());
  if (matches.length === 0) {
    throw new ToolInputError(`Unknown module "${args.module}". Known modules: ${[...new Set(g.modules.map((m) => m.name))].sort(cmp).join(", ")}`);
  }
  if (matches.length > 1) {
    throw new ToolInputError(`"${args.module}" matches ${matches.length} modules; pass one id:\n${matches.map((m) => `- ${m.id} ${m.name} [${names.get(m.serviceId) ?? m.serviceId}] ${m.path}`).join("\n")}`);
  }
  const module = matches[0] as (typeof g.modules)[number];
  const history = g.history.find((h) => h.moduleId === module.id);
  const limit = args.limit ?? DEFAULT_COMMIT_LIMIT;
  const commits = [...(history?.commits ?? [])].sort((a, b) => cmp(b.authorTime, a.authorTime) || cmp(a.sha, b.sha));
  const shown = commits.slice(0, limit).map((c) => ({
    sha: c.sha,
    authorTime: c.authorTime,
    author: c.author,
    message: c.message.split("\n")[0] ?? "",
    added: c.added,
    deleted: c.deleted,
    files: c.files.length,
  }));
  const commits90d = view.commits90d()[module.id] ?? 0;
  const note = !history ? "no history recorded (analysis ran with history disabled?)" : history.degraded === "shallow" ? "shallow clone: history is incomplete" : history.degraded === "no-git" ? "not a git repository" : undefined;
  const text = [
    `${module.name} [${names.get(module.serviceId) ?? module.serviceId}] ${module.path || "."} — ${commits.length} commit(s) recorded, ${commits90d} in the 90 days before ${g.project.analyzedAt.slice(0, 10)}`,
    ...(note ? [`(${note})`] : []),
    ...(history?.aiSummary ? [`Summary: ${history.aiSummary}`] : []),
    ...shown.map((c) => `- ${c.authorTime.slice(0, 10)} ${c.sha.slice(0, 8)} ${c.author}: ${c.message} (+${c.added}/-${c.deleted}, ${c.files} file(s))`),
    ...(commits.length > shown.length ? [`… ${commits.length - shown.length} older commit(s); raise limit to see them`] : []),
  ].join("\n");
  return {
    text,
    data: {
      module: { id: module.id, name: module.name, path: module.path, service: names.get(module.serviceId) ?? module.serviceId },
      total: commits.length,
      returned: shown.length,
      commits90d,
      ...(history?.degraded ? { degraded: history.degraded } : {}),
      ...(history?.aiSummary ? { aiSummary: history.aiSummary } : {}),
      commits: shown,
    },
  };
}

export interface ListTracesArgs {
  entrypoint?: string | undefined;
  since?: string | undefined;
  limit?: number | undefined;
  errorsOnly?: boolean | undefined;
}

/** Recent traced requests: aggregate facts only (route, duration, status, span count), never span attributes (AC#24). */
export function listTraces(view: GraphView, aggregates: AggregateState, args: ListTracesArgs = {}): ToolOutput {
  const since = args.since ? Date.parse(args.since) : undefined;
  if (args.since && Number.isNaN(since)) throw new ToolInputError(`"since" must be an ISO-8601 time, got "${args.since}".`);
  const wanted = args.entrypoint ? new Set(findEntrypoints(view.graph, args.entrypoint).map((e) => e.id)) : undefined;
  if (wanted && wanted.size === 0) throw new ToolInputError(`No entrypoint matches "${args.entrypoint}".`);
  const limit = Math.min(Math.max(1, args.limit ?? 20), 200);
  const rows = aggregates.traces
    .filter((t) => (since === undefined || t.start >= since) && (!args.errorsOnly || t.err))
    // Match through the root's route key (service + method + normalized route), never by label text.
    .filter((t) => !wanted || (t.root !== undefined && (entrypointsForRouteKey(view.graph, t.root.key) ?? []).some((e) => wanted.has(e.id))))
    .slice(0, limit)
    .map((t) => ({ traceId: t.t, start: new Date(t.start).toISOString(), durationMs: Math.round(t.dur * 100) / 100, error: t.err, spans: t.spans, services: t.services, root: t.root?.name ?? null }));
  const text =
    rows.length === 0
      ? aggregates.total === 0
        ? "No runtime traces recorded. Run `project-atlas trace -- <start command>` (or Atlas: Launch with Tracing in VS Code) and send a request."
        : "No traces match."
      : rows.map((r) => `${r.start} ${r.root ?? "(no root span)"} ${r.durationMs} ms${r.error ? " ERROR" : ""} · ${r.spans} spans · ${r.services.join(",")} · ${r.traceId}`).join("\n");
  return { text, data: { total: aggregates.traces.length, returned: rows.length, traces: rows } };
}
