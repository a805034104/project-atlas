import { edgeKey, stableId } from "../model/ids.js";
import type { CallEdge, Entrypoint, Flow, FlowLayer, FlowStep, Provenance, SymbolRef, UnresolvedCall } from "../model/types.js";

/**
 * Global call graph shared by all rule sets.
 *
 *   step(service, layer, key, symbol) ─▶ id (stable, deduplicated)
 *   edge(from, to, provenance, …)     ─▶ id (deduplicated; `discriminator` keeps
 *                                         per-entrypoint chain edges apart)
 *   flow(entrypoint, chain, startStep) ─▶ projection: chain edges + DFS over call
 *                                         edges (depth-limited, cycle-safe)
 */

export interface EdgeOptions {
  provenance: Provenance;
  order?: number;
  confidence?: number;
  rationale?: string;
  /** Distinguishes otherwise-identical edges (per-entrypoint chains, branches). */
  discriminator?: string;
}

export const DEFAULT_FLOW_DEPTH = 12;

export class GraphBuilder {
  readonly steps = new Map<string, FlowStep>();
  readonly edges = new Map<string, CallEdge>();
  readonly entrypoints = new Map<string, Entrypoint>();
  readonly unresolved: UnresolvedCall[] = [];
  readonly flows: Flow[] = [];
  /** Call edges only (no chain edges), by source step. */
  private readonly callEdgesFrom = new Map<string, CallEdge[]>();

  step(serviceId: string, serviceName: string, layer: FlowLayer, canonicalKey: string, symbol: SymbolRef): string {
    const id = stableId("step", serviceName, `${layer}|${canonicalKey}`);
    if (!this.steps.has(id)) this.steps.set(id, { id, serviceId, layer, symbol });
    return id;
  }

  edge(from: string, to: string, options: EdgeOptions): string {
    const id = stableId("edge", "", edgeKey(from, to, options.discriminator ?? ""));
    if (!this.edges.has(id)) {
      const edge: CallEdge = {
        id,
        from,
        to,
        order: options.order ?? 0,
        provenance: options.provenance,
        confidence: options.confidence ?? (options.provenance === "ai-inferred" ? 0.5 : 1),
      };
      if (options.rationale) edge.rationale = options.rationale;
      if (options.discriminator?.startsWith("chain:")) edge.chain = true;
      this.edges.set(id, edge);
      if (!options.discriminator?.startsWith("chain:")) {
        const list = this.callEdgesFrom.get(from) ?? [];
        list.push(edge);
        this.callEdgesFrom.set(from, list);
      }
    }
    return id;
  }

  /** Edges added as part of an entrypoint's middleware chain must use this discriminator. */
  static chainDiscriminator(entrypointId: string): string {
    return `chain:${entrypointId}`;
  }

  addEntrypoint(entrypoint: Entrypoint): void {
    if (!this.entrypoints.has(entrypoint.id)) this.entrypoints.set(entrypoint.id, entrypoint);
  }

  removeCallEdge(edge: CallEdge): void {
    const list = this.callEdgesFrom.get(edge.from);
    if (list) this.callEdgesFrom.set(edge.from, list.filter((e) => e.id !== edge.id));
  }

  outgoing(stepId: string): readonly CallEdge[] {
    return this.callEdgesFrom.get(stepId) ?? [];
  }

  /**
   * Project the flow of one entrypoint: the explicit chain (filters, interceptors,
   * aspects…) followed by a DFS over call edges from `handlerStepId`.
   */
  projectFlow(entrypointId: string, chainStepIds: readonly string[], chainEdgeIds: readonly string[], handlerStepId: string, depth = DEFAULT_FLOW_DEPTH): Flow {
    const { stepIds, edgeIds, truncated } = projectDfs((id) => this.outgoing(id), handlerStepId, depth);
    const flow: Flow = { entrypointId, stepIds: [...new Set([...chainStepIds, ...stepIds])], edgeIds: [...new Set([...chainEdgeIds, ...edgeIds])], truncated };
    this.flows.push(flow);
    return flow;
  }

}

/**
 * Depth-limited DFS over call edges shared by GraphBuilder and GraphView.
 * Each step is expanded at most once per (shallowest) level, so diamond-shaped
 * call graphs stay linear instead of enumerating every path. Back edges into the
 * current path are kept (recursion marker) but not followed.
 */
export function projectDfs(
  outgoing: (stepId: string) => readonly CallEdge[],
  start: string,
  depth: number,
): { stepIds: string[]; edgeIds: string[]; truncated: boolean } {
  const stepIds = new Set<string>([start]);
  const edgeIds = new Set<string>();
  const bestLevel = new Map<string, number>([[start, 0]]);
  let truncated = false;
  const visit = (stepId: string, level: number, path: Set<string>): void => {
    for (const edge of [...outgoing(stepId)].sort((a, b) => a.order - b.order)) {
      edgeIds.add(edge.id);
      stepIds.add(edge.to);
      if (path.has(edge.to)) continue;
      if (level + 1 >= depth) {
        truncated = true;
        continue;
      }
      const seen = bestLevel.get(edge.to);
      if (seen !== undefined && seen <= level + 1) continue;
      bestLevel.set(edge.to, level + 1);
      path.add(edge.to);
      visit(edge.to, level + 1, path);
      path.delete(edge.to);
    }
  };
  visit(start, 0, new Set([start]));
  return { stepIds: [...stepIds], edgeIds: [...edgeIds], truncated };
}
