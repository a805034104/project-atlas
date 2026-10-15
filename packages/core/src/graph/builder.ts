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
    const stepIds = new Set<string>(chainStepIds);
    const edgeIds = new Set<string>(chainEdgeIds);
    let truncated = false;
    const visit = (stepId: string, level: number, path: Set<string>): void => {
      stepIds.add(stepId);
      for (const edge of [...this.outgoing(stepId)].sort((a, b) => a.order - b.order)) {
        edgeIds.add(edge.id);
        if (path.has(edge.to)) continue; // recursion: keep the back edge, stop descending
        if (level + 1 >= depth) {
          truncated = true;
          stepIds.add(edge.to);
          continue;
        }
        path.add(edge.to);
        visit(edge.to, level + 1, path);
        path.delete(edge.to);
      }
    };
    visit(handlerStepId, 0, new Set([handlerStepId]));
    const flow: Flow = { entrypointId, stepIds: [...stepIds], edgeIds: [...edgeIds], truncated };
    this.flows.push(flow);
    return flow;
  }
}
