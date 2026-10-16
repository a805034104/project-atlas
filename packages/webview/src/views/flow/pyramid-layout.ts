/**
 * Top-down "pyramid" layout for a flow (pure, deterministic, unit-tested; no layout worker).
 *
 *   SwimlaneModel (DFS order, branch groups, back edges, collapsed services)
 *     ─▶ call tree: parent(n) = the caller with the highest visit index below n's (the DFS tree edge)
 *     ─▶ aspects with one callee become a side-car pill on that callee (not a row of their own)
 *     ─▶ more than FANOUT_LIMIT children: the first FANOUT_SHOW, then one "+N" node (expand in place)
 *     ─▶ tidy tree: every subtree gets the width it needs, a parent is centred over its children
 *        row = depth (entry on top), so wide fan-outs spread downward like a pyramid
 *   links: tree edges as elbows; other calls (shared callees) as curves; recursion as a loop on the
 *   right; edge labels at the child end, hidden when a caller has more than LABEL_LIMIT children.
 */

import type { CallEdge, FlowLayer } from "@project-atlas/core";
import type { LaneEdge, LaneNode, SwimlaneModel } from "./model.js";

export const NODE_W = 200;
export const NODE_H = 44;
export const ROW_GAP = 56;
export const SIBLING_GAP = 24;
export const SIDECAR_W = 156;
export const SIDECAR_GAP = 24;
export const RAIL_W = 88;
export const PAD = 24;
export const FRAME_PAD = 12;
export const FRAME_TITLE = 22;
export const FANOUT_LIMIT = 6;
export const FANOUT_SHOW = 5;
export const LABEL_LIMIT = 4;

export interface PyramidNode {
  id: string;
  x: number;
  y: number;
  depth: number;
  /** The model node (absent for a "+N more" node). */
  node?: LaneNode;
  /** Aspect advising this node, drawn as a pill on its right. */
  sidecar?: LaneNode;
  /** "+N more" node standing for hidden children of `parent`. */
  more?: { parent: string; count: number };
}

export interface PyramidLink {
  key: string;
  /** The edge this link stands for (for an aspect-collapsed hop: the caller → aspect edge). */
  edge: LaneEdge;
  from: string;
  to: string;
  kind: "tree" | "cross" | "back";
  path: string;
  labelX: number;
  labelY: number;
  showLabel: boolean;
}

export interface PyramidFrame {
  serviceId: string;
  name: string;
  stepCount: number;
  collapsed: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PyramidLayout {
  nodes: PyramidNode[];
  links: PyramidLink[];
  frames: PyramidFrame[];
  /** Layers present on each row, for the left rail. */
  rows: { y: number; layers: FlowLayer[] }[];
  width: number;
  height: number;
}

const moreId = (parent: string) => `more:${parent}`;
/** First row: below the top padding and room for a service frame's title. */
const TOP = PAD + FRAME_PAD + FRAME_TITLE;

export function buildPyramid(model: SwimlaneModel, opts: { expandedFanout: ReadonlySet<string> }): PyramidLayout {
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const forward = model.edges.filter((e) => !e.back && e.from !== e.to);
  const incoming = new Map<string, LaneEdge[]>();
  const outgoing = new Map<string, LaneEdge[]>();
  for (const e of forward) {
    incoming.set(e.to, [...(incoming.get(e.to) ?? []), e]);
    outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), e]);
  }

  // Call tree from the DFS order: the tree edge into n comes from its latest-visited caller.
  const treeEdge = new Map<string, LaneEdge>();
  for (const n of model.nodes) {
    const callers = (incoming.get(n.id) ?? []).filter((e) => (byId.get(e.from)?.col ?? Infinity) < n.col);
    const best = callers.sort((a, b) => (byId.get(b.from)?.col ?? 0) - (byId.get(a.from)?.col ?? 0))[0];
    if (best) treeEdge.set(n.id, best);
  }

  // Aspects with exactly one callee become that callee's side-car.
  const sidecarOf = new Map<string, LaneNode>(); // callee id → aspect node
  const absorbed = new Map<string, string>(); // aspect id → callee id
  for (const n of model.nodes) {
    if (n.layer !== "aspect") continue;
    const out = outgoing.get(n.id) ?? [];
    const callee = out[0]?.to;
    if (out.length !== 1 || callee === undefined || sidecarOf.has(callee) || treeEdge.get(callee)?.from !== n.id || !treeEdge.has(n.id)) continue;
    sidecarOf.set(callee, n);
    absorbed.set(n.id, callee);
  }

  // Tree children (aspects skipped: the callee hangs from the aspect's caller).
  const parentOf = new Map<string, { parent: string; edge: LaneEdge }>();
  for (const [child, e] of treeEdge) {
    if (absorbed.has(child)) continue;
    let from = e.from;
    let via = e;
    if (absorbed.has(from)) {
      const up = treeEdge.get(from);
      if (!up) continue;
      via = up;
      from = up.from;
    }
    parentOf.set(child, { parent: from, edge: via });
  }
  const children = new Map<string, string[]>();
  const visible = model.nodes.filter((n) => !absorbed.has(n.id));
  for (const n of visible) {
    const p = parentOf.get(n.id);
    if (p) children.set(p.parent, [...(children.get(p.parent) ?? []), n.id]);
  }
  for (const list of children.values()) list.sort((a, b) => (byId.get(a)?.col ?? 0) - (byId.get(b)?.col ?? 0));
  const roots = visible.filter((n) => !parentOf.has(n.id)).map((n) => n.id);

  // Fan-out: keep the first FANOUT_SHOW, replace the rest by one "+N" node unless expanded.
  const hidden = new Set<string>();
  const moreCount = new Map<string, number>();
  for (const [parent, list] of children) {
    if (list.length <= FANOUT_LIMIT || opts.expandedFanout.has(parent)) continue;
    const rest = list.slice(FANOUT_SHOW);
    const stack = [...rest];
    while (stack.length) {
      const id = stack.pop() as string;
      if (hidden.has(id)) continue;
      hidden.add(id);
      stack.push(...(children.get(id) ?? []));
    }
    children.set(parent, [...list.slice(0, FANOUT_SHOW), moreId(parent)]);
    moreCount.set(parent, rest.length);
  }

  // Tidy tree: subtree widths, then positions.
  // A side-car reserves room on both sides so the node itself stays centred over its parent
  // (a straight trunk); the pill hangs on the right.
  const ownWidth = (id: string) => (sidecarOf.has(id) ? NODE_W + 2 * (SIDECAR_GAP + SIDECAR_W) : NODE_W);
  const widthCache = new Map<string, number>();
  const subtreeWidth = (id: string, seen = new Set<string>()): number => {
    const cached = widthCache.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return ownWidth(id);
    seen.add(id);
    const kids = children.get(id) ?? [];
    const kidsWidth = kids.reduce((sum, k, i) => sum + subtreeWidth(k, seen) + (i > 0 ? SIBLING_GAP : 0), 0);
    const w = Math.max(ownWidth(id), kidsWidth);
    widthCache.set(id, w);
    return w;
  };
  const placed = new Map<string, PyramidNode>();
  const place = (id: string, left: number, depth: number) => {
    if (placed.has(id)) return;
    const w = subtreeWidth(id);
    const kids = children.get(id) ?? [];
    const kidsWidth = kids.reduce((sum, k, i) => sum + subtreeWidth(k) + (i > 0 ? SIBLING_GAP : 0), 0);
    const centre = left + w / 2;
    const y = TOP + depth * (NODE_H + ROW_GAP);
    const parent = id.startsWith("more:") ? id.slice(5) : undefined;
    const node = byId.get(id);
    const sidecar = sidecarOf.get(id);
    placed.set(id, {
      id,
      x: centre - NODE_W / 2,
      y,
      depth,
      ...(node ? { node } : {}),
      ...(sidecar ? { sidecar } : {}),
      ...(parent !== undefined ? { more: { parent, count: moreCount.get(parent) ?? 0 } } : {}),
    });
    let cursor = left + (w - kidsWidth) / 2;
    for (const k of kids) {
      place(k, cursor, depth + 1);
      cursor += subtreeWidth(k) + SIBLING_GAP;
    }
  };
  let cursor = PAD + RAIL_W;
  for (const r of roots) {
    if (hidden.has(r)) continue;
    place(r, cursor, 0);
    cursor += subtreeWidth(r) + SIBLING_GAP * 2;
  }

  const nodes = [...placed.values()];
  const width = Math.max(PAD * 2 + RAIL_W + NODE_W, ...nodes.map((n) => n.x + (n.sidecar ? NODE_W + SIDECAR_GAP + SIDECAR_W : NODE_W) + PAD));
  const maxDepth = Math.max(0, ...nodes.map((n) => n.depth));
  const height = TOP + (maxDepth + 1) * NODE_H + maxDepth * ROW_GAP + FRAME_PAD + PAD;

  // Links.
  const links: PyramidLink[] = [];
  const childCount = (id: string) => (children.get(id) ?? []).length;
  const anchor = (id: string) => placed.get(id) ?? (absorbed.has(id) ? placed.get(absorbed.get(id) as string) : undefined);
  const treeKeys = new Set<string>();
  for (const [child, { parent, edge }] of parentOf) {
    const a = placed.get(parent);
    const b = placed.get(child);
    if (!a || !b) continue;
    treeKeys.add(edge.key);
    const x1 = a.x + NODE_W / 2;
    const y1 = a.y + NODE_H;
    const x2 = b.x + NODE_W / 2;
    const y2 = b.y;
    const mid = y1 + ROW_GAP / 2;
    // One callee: label just under the caller (clear of the callee's frame title);
    // several: beside each callee's own line.
    const single = childCount(parent) === 1;
    links.push({ key: edge.key, edge, from: parent, to: child, kind: "tree", path: `M${x1},${y1} V${mid} H${x2} V${y2}`, labelX: single ? x1 : x2, labelY: single ? y1 + 12 : (mid + y2) / 2, showLabel: childCount(parent) <= LABEL_LIMIT });
  }
  for (const [parent, count] of moreCount) {
    const a = placed.get(parent);
    const b = placed.get(moreId(parent));
    if (!a || !b || count === 0) continue;
    const x1 = a.x + NODE_W / 2;
    const y1 = a.y + NODE_H;
    const x2 = b.x + NODE_W / 2;
    const mid = y1 + ROW_GAP / 2;
    const first = outgoing.get(parent)?.[0];
    if (first) links.push({ key: `more:${parent}`, edge: first, from: parent, to: moreId(parent), kind: "tree", path: `M${x1},${y1} V${mid} H${x2} V${b.y}`, labelX: x2, labelY: (mid + b.y) / 2, showLabel: false });
  }
  for (const e of model.edges) {
    if (treeKeys.has(e.key)) continue;
    if (absorbed.has(e.from) && absorbed.get(e.from) === e.to) continue; // aspect → its callee: the side-car connector
    if (absorbed.has(e.to) && parentOf.get(absorbed.get(e.to) as string)?.edge.key === e.key) continue;
    const a = anchor(e.from);
    const b = anchor(e.to);
    if (!a || !b || hidden.has(a.id) || hidden.has(b.id)) continue;
    if (e.back || e.from === e.to) {
      // Recursion: out of the caller's right side, up and into the callee's right side.
      const x1 = a.x + NODE_W;
      const y1 = a.y + NODE_H / 2;
      const x2 = b.x + NODE_W;
      const y2 = b.y + NODE_H / 2;
      const out = Math.max(x1, x2) + (a.sidecar || b.sidecar ? SIDECAR_GAP + SIDECAR_W : 0) + 28;
      links.push({ key: e.key, edge: e, from: a.id, to: b.id, kind: "back", path: `M${x1},${y1} H${out} V${y2} H${x2}`, labelX: out, labelY: (y1 + y2) / 2, showLabel: true });
      continue;
    }
    // Shared callee reached a second time: a curve from the caller's bottom to the callee's top.
    const x1 = a.x + NODE_W / 2;
    const y1 = a.y + NODE_H;
    const x2 = b.x + NODE_W / 2;
    const y2 = b.y;
    const dy = Math.max(30, Math.abs(y2 - y1) / 2);
    links.push({ key: e.key, edge: e, from: a.id, to: b.id, kind: "cross", path: `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}`, labelX: (x1 + x2) / 2, labelY: (y1 + y2) / 2, showLabel: childCount(a.id) <= LABEL_LIMIT });
  }

  // Service frames: the box around each service's nodes.
  const frames: PyramidFrame[] = [];
  for (const band of model.bands) {
    const mine = nodes.filter((n) => n.node?.serviceId === band.serviceId || (n.more && byId.get(n.more.parent)?.serviceId === band.serviceId));
    if (mine.length === 0) continue;
    const x0 = Math.min(...mine.map((n) => n.x)) - FRAME_PAD;
    const y0 = Math.min(...mine.map((n) => n.y)) - FRAME_PAD - FRAME_TITLE;
    const x1 = Math.max(...mine.map((n) => n.x + (n.sidecar ? NODE_W + SIDECAR_GAP + SIDECAR_W : NODE_W))) + FRAME_PAD;
    const y1 = Math.max(...mine.map((n) => n.y + NODE_H)) + FRAME_PAD;
    frames.push({ serviceId: band.serviceId, name: band.name, stepCount: band.stepCount, collapsed: band.collapsed, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }

  // Left rail: the layers on each row.
  const rows: PyramidLayout["rows"] = [];
  for (let d = 0; d <= maxDepth; d++) {
    const layers: FlowLayer[] = [];
    for (const n of nodes.filter((x) => x.depth === d)) {
      for (const l of [n.node?.layer, n.sidecar?.layer]) if (l && !layers.includes(l)) layers.push(l);
    }
    rows.push({ y: TOP + d * (NODE_H + ROW_GAP), layers });
  }

  return { nodes, links, frames, rows, width, height };
}

/** `SysUserServiceImpl.selectUserList` → `SysUserSer…selectUserList` (keep both ends). */
export function middleTruncate(text: string, max = 26): string {
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) * 0.45);
  const tail = max - 1 - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

export type { CallEdge };
