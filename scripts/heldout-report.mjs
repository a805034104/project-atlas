// Robustness report on held-out repositories (no AI): timing, services, entrypoints,
// flows that reach a data layer, cross-service links, unresolved calls, diagnostics.
//   node scripts/heldout-report.mjs <dir>[,<dir2>] ...
import { analyzeWorkspace } from "../packages/core/dist/index.js";

for (const arg of process.argv.slice(2)) {
  const roots = arg.split(",").map((p) => ({ path: p }));
  const started = Date.now();
  try {
    const { graph } = await analyzeWorkspace({ roots, history: false });
    const steps = new Map(graph.steps.map((s) => [s.id, s]));
    const http = graph.entrypoints.filter((e) => e.kind === "http");
    const flows = new Map(graph.flows.map((f) => [f.entrypointId, f]));
    const reachesData = http.filter((e) => (flows.get(e.id)?.stepIds ?? []).some((id) => ["repository", "sql"].includes(steps.get(id)?.layer ?? ""))).length;
    const reachesService = http.filter((e) => (flows.get(e.id)?.stepIds ?? []).some((id) => steps.get(id)?.layer === "service")).length;
    const byCode = {};
    for (const d of graph.diagnostics) byCode[d.code] = (byCode[d.code] ?? 0) + 1;
    const unresolvedReasons = {};
    for (const u of graph.unresolvedCalls) unresolvedReasons[u.reason] = (unresolvedReasons[u.reason] ?? 0) + 1;
    console.log(JSON.stringify({
      roots: arg,
      ms: Date.now() - started,
      services: graph.services.map((s) => `${s.name}:${s.kind}`),
      modules: graph.modules.length,
      http: http.length,
      routes: graph.entrypoints.filter((e) => e.kind === "frontend-route").length,
      flowsReachService: `${reachesService}/${http.length}`,
      flowsReachData: `${reachesData}/${http.length}`,
      links: graph.serviceLinks.reduce((acc, l) => ({ ...acc, [l.kind]: (acc[l.kind] ?? 0) + 1 }), {}),
      unresolved: unresolvedReasons,
      unresolvedSamples: graph.unresolvedCalls.slice(0, 5).map((u) => u.expression),
      diagnostics: byCode,
    }, null, 1));
  } catch (error) {
    console.log(JSON.stringify({ roots: arg, crashed: String(error?.stack ?? error).slice(0, 600) }));
  }
}
