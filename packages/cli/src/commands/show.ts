import path from "node:path";
import { applyOverlay, createRefFormatter, entrypointLabel, findEntrypoints, flowStepLines, GraphView, loadStoredGraph, reconcile, TraceStore } from "@project-atlas/core";
import type { ShowCommand } from "../args.js";
import { CliError, EXIT_OK, EXIT_USAGE, storeError } from "../errors.js";
import type { CliIo } from "../io.js";

/**
 * `project-atlas show <entrypoint>` — print one request flow from a saved graph.
 *
 *   --dir (.atlas) ─▶ loadStoredGraph ─▶ findEntrypoints (id | label | path)
 *     ─▶ GraphView.flowDetail(depth) ─▶ numbered `layer · Symbol (file:line)` | JSON
 */

export async function showCommand(cmd: ShowCommand, io: CliIo): Promise<number> {
  const dir = path.resolve(io.cwd, cmd.dir ?? ".atlas");
  const loaded = await loadStoredGraph(dir);
  if (loaded.status === "missing") throw storeError(dir, "graph/meta.json does not exist.");
  if (loaded.status === "rebuild") throw storeError(dir, `The stored graph cannot be read (${loaded.reason}).`);
  // Runtime observations (project-atlas trace) are folded in when present.
  const aggregates = await new TraceStore(path.join(dir, "traces")).loadAggregates();
  const graph = aggregates.total > 0 ? applyOverlay(loaded.graph, reconcile(loaded.graph, aggregates)) : loaded.graph;

  const matches = findEntrypoints(graph, cmd.entrypoint);
  const serviceName = new Map(graph.services.map((s) => [s.id, s.name]));
  if (matches.length !== 1) {
    const candidates =
      matches.length > 1
        ? matches.map((e) => `${e.id}  ${entrypointLabel(e)}  (${serviceName.get(e.serviceId) ?? e.serviceId})`)
        : graph.entrypoints
            .filter((e) => entrypointLabel(e).toLowerCase().includes(cmd.entrypoint.toLowerCase().split(/\s+/).pop() ?? ""))
            .slice(0, 10)
            .map((e) => entrypointLabel(e));
    throw new CliError(
      {
        code: "ATLAS-E063",
        problem: matches.length > 1 ? `"${cmd.entrypoint}" matches ${matches.length} entrypoints.` : `No entrypoint matches "${cmd.entrypoint}".`,
        cause: candidates.length > 0 ? `Candidates:\n    ${candidates.join("\n    ")}` : "Labels look like `GET /system/user/list`; ids are 16-character strings.",
        fix: matches.length > 1 ? "Pass the entrypoint id instead of the label." : "Check the method and path, or pass an entrypoint id.",
      },
      EXIT_USAGE,
    );
  }
  const entrypoint = matches[0];
  const detail = entrypoint ? new GraphView(graph).flowDetail(entrypoint.id, cmd.depth) : undefined;
  if (!entrypoint || !detail) throw storeError(dir, `The flow for "${cmd.entrypoint}" is missing from the store (re-run the analysis).`);

  if (cmd.json) {
    io.stdout(`${JSON.stringify(detail, null, 2)}\n`);
    return EXIT_OK;
  }
  const fmt = createRefFormatter(graph);
  const lines = [
    `${entrypointLabel(entrypoint)}  [${serviceName.get(entrypoint.serviceId) ?? entrypoint.serviceId}]`,
    `handler: ${entrypoint.handler.name} (${fmt(entrypoint.handler)})`,
    ...(entrypoint.observed ? [`observed: ${entrypoint.observed.count} request(s), p50 ${entrypoint.observed.p50Ms} ms, p95 ${entrypoint.observed.p95Ms} ms, ${entrypoint.observed.errorCount} error(s)`] : []),
    "",
    ...flowStepLines(detail, fmt).map((l, i) => `${String(i + 1).padStart(3)}. ${l}`),
  ];
  if (detail.steps.length === 0) lines.push("  (no call-graph steps recorded)");
  if (detail.flow.truncated) lines.push("", `  … cut at depth ${cmd.depth ?? "default"}; use --depth <n> (max 40) for more`);
  if (detail.unresolvedCalls.length > 0) {
    lines.push("", `Unresolved calls (${detail.unresolvedCalls.length}):`);
    for (const u of detail.unresolvedCalls) lines.push(`  - ${u.expression}  ${u.reason}  (${fmt(u.at)})`);
  }
  io.stdout(`${lines.join("\n")}\n`);
  return EXIT_OK;
}
