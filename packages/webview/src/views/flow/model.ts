/**
 * Pure swimlane model for a flow projection (no React, unit-testable).
 *
 *   steps/edges ──▶ DFS pre-order from the roots (edges sorted by `order`)
 *                    · column = visit index (left → right)
 *                    · back edge to a step on the DFS stack = recursion ↺
 *                    · edges from one step sharing the same `order` = multi-implementation
 *                      branch group "×N": first expanded, others collapsed by default
 *   bands = services in first-visit order (collapsible), lanes = FlowLayer rows
 *   within a band, only lanes that have steps, in LANE_ORDER.
 */

import type { CallEdge, FlowDetailData, FlowLayer, FlowStep } from "@project-atlas/core";

export const LANE_ORDER: readonly FlowLayer[] = [
  "frontend",
  "filter",
  "interceptor",
  "aspect",
  "controller",
  "service",
  "repository",
  "sql",
  "external-http",
  // Not produced by v0.1 analyzers; kept so v0.2+ data still renders.
  "middleware",
  "cache",
  "mq",
];

export interface LaneNode {
  id: string;
  /** Undefined for a collapsed-band placeholder. */
  step: FlowStep | undefined;
  label: string;
  layer: FlowLayer | undefined;
  serviceId: string;
  col: number;
  band: number;
  lane: number;
  /** Branch groups (×N) originating here, for Space toggling. */
  branchGroups: string[];
  recursive: boolean;
}

export interface LaneEdge {
  key: string;
  edge: CallEdge;
  from: string;
  to: string;
  back: boolean;
  branch?: { group: string; count: number; first: boolean };
}

export interface LaneBand {
  serviceId: string;
  name: string;
  collapsed: boolean;
  lanes: (FlowLayer | "collapsed")[];
  stepCount: number;
}

export interface SwimlaneModel {
  bands: LaneBand[];
  nodes: LaneNode[];
  edges: LaneEdge[];
  columns: number;
  /** Steps hidden behind collapsed branch groups. */
  hiddenSteps: number;
}

export function bandNodeId(serviceId: string): string {
  return `band:${serviceId}`;
}

export function buildSwimlane(
  detail: FlowDetailData,
  opts: { expandedBranches: ReadonlySet<string>; collapsedBands: ReadonlySet<string> },
): SwimlaneModel {
  const steps = new Map(detail.steps.map((s) => [s.id, s]));
  const edges = detail.edges.filter((e) => steps.has(e.from) && steps.has(e.to));
  const out = new Map<string, CallEdge[]>();
  const indeg = new Map<string, number>();
  for (const e of edges) {
    out.set(e.from, [...(out.get(e.from) ?? []), e]);
    if (e.from !== e.to) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  for (const list of out.values()) list.sort((a, b) => a.order - b.order);

  // Branch groups: same caller, same order, more than one callee.
  const branchOf = new Map<string, { group: string; count: number; first: boolean }>();
  const groupsAt = new Map<string, string[]>();
  for (const [from, list] of out) {
    const byOrder = new Map<number, CallEdge[]>();
    for (const e of list) byOrder.set(e.order, [...(byOrder.get(e.order) ?? []), e]);
    for (const [order, group] of byOrder) {
      if (group.length < 2) continue;
      const key = `${from}#${order}`;
      groupsAt.set(from, [...(groupsAt.get(from) ?? []), key]);
      group.forEach((e, i) => branchOf.set(e.id, { group: key, count: group.length, first: i === 0 }));
    }
  }
  const edgeVisible = (e: CallEdge): boolean => {
    const b = branchOf.get(e.id);
    return !b || b.first || opts.expandedBranches.has(b.group);
  };

  // DFS pre-order.
  const order = detail.flow.stepIds.filter((id) => steps.has(id));
  for (const s of detail.steps) if (!order.includes(s.id)) order.push(s.id);
  let roots = order.filter((id) => !indeg.get(id));
  if (roots.length === 0 && order[0] !== undefined) roots = [order[0]];

  const visitIndex = new Map<string, number>();
  const backEdges = new Set<string>();
  const onStack = new Set<string>();
  const visit = (id: string): void => {
    visitIndex.set(id, visitIndex.size);
    onStack.add(id);
    for (const e of out.get(id) ?? []) {
      if (!edgeVisible(e)) continue;
      if (onStack.has(e.to)) backEdges.add(e.id);
      else if (!visitIndex.has(e.to)) visit(e.to);
    }
    onStack.delete(id);
  };
  for (const r of roots) if (!visitIndex.has(r)) visit(r);

  const visited = [...visitIndex.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  const serviceName = new Map(detail.services.map((s) => [s.id, s.name]));

  // Bands in first-visit order.
  const bandOrder: string[] = [];
  for (const id of visited) {
    const svc = steps.get(id)?.serviceId ?? "";
    if (!bandOrder.includes(svc)) bandOrder.push(svc);
  }

  const bands: LaneBand[] = bandOrder.map((serviceId) => {
    const inBand = visited.filter((id) => steps.get(id)?.serviceId === serviceId);
    const collapsed = opts.collapsedBands.has(serviceId);
    const layers = new Set(inBand.map((id) => steps.get(id)?.layer));
    return {
      serviceId,
      name: serviceName.get(serviceId) ?? serviceId,
      collapsed,
      lanes: collapsed ? ["collapsed"] : LANE_ORDER.filter((l) => layers.has(l)),
      stepCount: inBand.length,
    };
  });
  const bandIdx = new Map(bands.map((b, i) => [b.serviceId, i]));

  // Nodes (collapsed bands become one placeholder at the band's first column).
  const nodes: LaneNode[] = [];
  const remap = new Map<string, string>();
  const recursiveTargets = new Set(edges.filter((e) => backEdges.has(e.id)).map((e) => e.to));
  let col = 0;
  for (const id of visited) {
    const step = steps.get(id);
    if (!step) continue;
    const b = bandIdx.get(step.serviceId) ?? 0;
    const band = bands[b];
    if (band?.collapsed) {
      const pid = bandNodeId(step.serviceId);
      remap.set(id, pid);
      if (!nodes.some((n) => n.id === pid)) {
        nodes.push({
          id: pid,
          step: undefined,
          label: band.name,
          layer: undefined,
          serviceId: step.serviceId,
          col: col++,
          band: b,
          lane: 0,
          branchGroups: [],
          recursive: false,
        });
      }
      continue;
    }
    remap.set(id, id);
    nodes.push({
      id,
      step,
      label: step.symbol.name,
      layer: step.layer,
      serviceId: step.serviceId,
      col: col++,
      band: b,
      lane: Math.max(0, band ? band.lanes.indexOf(step.layer) : 0),
      branchGroups: groupsAt.get(id) ?? [],
      recursive: recursiveTargets.has(id),
    });
  }

  const laneEdges: LaneEdge[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (!edgeVisible(e) || !visitIndex.has(e.from) || !visitIndex.has(e.to)) continue;
    const from = remap.get(e.from);
    const to = remap.get(e.to);
    if (from === undefined || to === undefined) continue;
    if (from === to && from.startsWith("band:")) continue; // internal to a collapsed band
    const key = `${from}->${to}`;
    if (from !== e.from || to !== e.to) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const branch = branchOf.get(e.id);
    laneEdges.push({ key: e.id, edge: e, from, to, back: backEdges.has(e.id), ...(branch ? { branch } : {}) });
  }

  return {
    bands,
    nodes,
    edges: laneEdges,
    columns: col,
    hiddenSteps: detail.steps.length - visited.length,
  };
}
