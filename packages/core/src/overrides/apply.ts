import type { GraphBuilder } from "../graph/builder.js";
import type { Diagnostic, Entrypoint, FlowStep } from "../model/types.js";
import { antMatch } from "../rules/ant.js";
import type { AtlasOverrides, EdgeRef } from "./atlas-yaml.js";

/**
 * Apply edge add/remove and entrypoint ignores to the global graph before
 * flows are projected. Edge endpoints match a step id, its symbol name
 * (`SysUserController.list`) or its fully-qualified symbol.
 */

function matches(step: FlowStep, ref: string): boolean {
  return step.id === ref || step.symbol.name === ref || step.symbol.fqn === ref || step.symbol.fqn.startsWith(`${ref}(`);
}

function findSteps(graph: GraphBuilder, ref: string): FlowStep[] {
  return [...graph.steps.values()].filter((s) => matches(s, ref));
}

export function entrypointLabel(e: Entrypoint): string {
  if (e.kind === "http") return `${e.method ?? "ANY"} ${e.path ?? ""}`;
  if (e.kind === "frontend-route") return `ROUTE ${e.path ?? ""}`;
  return `${e.kind.toUpperCase()} ${e.handler.name}`;
}

export function isIgnoredEntrypoint(e: Entrypoint, patterns: readonly string[]): boolean {
  const label = entrypointLabel(e);
  return patterns.some((p) => {
    const [method, path] = p.includes(" ") ? (p.split(/\s+/, 2) as [string, string]) : ["*", p];
    if (method !== "*" && method.toUpperCase() !== label.split(" ")[0]) return false;
    return antMatch(path, e.path ?? e.handler.file);
  });
}

export function applyEdgeOverrides(graph: GraphBuilder, edges: AtlasOverrides["edges"]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const unmatched = (kind: string, e: EdgeRef) =>
    diagnostics.push({ code: "ATLAS-W021", severity: "warning", message: `atlas.yaml edges.${kind}: no step matches ${e.from} → ${e.to}` });

  for (const e of edges.remove) {
    const from = new Set(findSteps(graph, e.from).map((s) => s.id));
    const to = new Set(findSteps(graph, e.to).map((s) => s.id));
    let removed = 0;
    for (const [id, edge] of graph.edges) {
      if (from.has(edge.from) && to.has(edge.to)) {
        graph.edges.delete(id);
        graph.removeCallEdge(edge);
        removed++;
      }
    }
    if (removed === 0) unmatched("remove", e);
  }
  for (const e of edges.add) {
    const from = findSteps(graph, e.from);
    const to = findSteps(graph, e.to);
    if (from.length === 0 || to.length === 0) {
      unmatched("add", e);
      continue;
    }
    for (const f of from) for (const t of to) graph.edge(f.id, t.id, { provenance: "framework-rule", rationale: `atlas.yaml${e.note ? `: ${e.note}` : ""}` });
  }
  return diagnostics;
}
