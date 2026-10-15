/**
 * Graph layout: ELK "layered" running in a Web Worker, with a synchronous
 * longest-path fallback used for the first paint and wherever Worker is
 * unavailable (tests, very old hosts).
 *
 * The worker script is bundled as a string and started from a blob: URL —
 * VS Code webviews cannot load a Worker from a vscode-resource URL.
 * Host CSP must allow `worker-src blob:`.
 */

import { useEffect, useMemo, useState } from "react";
import ELK from "elkjs/lib/elk-api.js";
import type { ELK as ElkApi } from "elkjs/lib/elk-api.js";
import elkWorkerSource from "elkjs/lib/elk-worker.min.js?raw";

export interface LayoutNode {
  id: string;
  width: number;
  height: number;
}

export interface LayoutEdge {
  id: string;
  from: string;
  to: string;
}

export type Positions = Record<string, { x: number; y: number }>;

const H_GAP = 60;
const V_GAP = 24;

/** Longest-path layering (cycle-safe), left → right. Deterministic. */
export function layeredFallback(nodes: LayoutNode[], edges: LayoutEdge[]): Positions {
  const ids = new Set(nodes.map((n) => n.id));
  const out = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const n of nodes) {
    out.set(n.id, []);
    indeg.set(n.id, 0);
  }
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
    out.get(e.from)?.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  // Kahn's algorithm; nodes left over (cycles) are appended in input order.
  const rank = new Map<string, number>();
  const queue = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  for (const id of queue) rank.set(id, 0);
  const remaining = new Map(indeg);
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const to of out.get(id) ?? []) {
      rank.set(to, Math.max(rank.get(to) ?? 0, (rank.get(id) ?? 0) + 1));
      const left = (remaining.get(to) ?? 1) - 1;
      remaining.set(to, left);
      if (left === 0) queue.push(to);
    }
  }
  for (const n of nodes) if (!rank.has(n.id)) rank.set(n.id, 0);

  const columns = new Map<number, LayoutNode[]>();
  for (const n of nodes) {
    const r = rank.get(n.id) ?? 0;
    const col = columns.get(r) ?? [];
    col.push(n);
    columns.set(r, col);
  }
  const positions: Positions = {};
  let x = 0;
  for (const r of [...columns.keys()].sort((a, b) => a - b)) {
    const col = columns.get(r) ?? [];
    let y = 0;
    let width = 0;
    for (const n of col) {
      positions[n.id] = { x, y };
      y += n.height + V_GAP;
      width = Math.max(width, n.width);
    }
    x += width + H_GAP;
  }
  return positions;
}

let elk: ElkApi | null | undefined;

function getElk(): ElkApi | null {
  if (elk !== undefined) return elk;
  if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL.createObjectURL !== "function") {
    elk = null;
    return elk;
  }
  try {
    const url = URL.createObjectURL(new Blob([elkWorkerSource], { type: "text/javascript" }));
    elk = new ELK({ workerUrl: url, workerFactory: () => new Worker(url) });
  } catch {
    elk = null;
  }
  return elk;
}

export async function elkLayout(nodes: LayoutNode[], edges: LayoutEdge[]): Promise<Positions> {
  const engine = getElk();
  if (!engine) throw new Error("ELK worker unavailable");
  const ids = new Set(nodes.map((n) => n.id));
  const result = await engine.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": "60",
      "elk.spacing.nodeNode": "24",
      "elk.edgeRouting": "SPLINES",
    },
    children: nodes.map((n) => ({ id: n.id, width: n.width, height: n.height })),
    edges: edges
      .filter((e) => ids.has(e.from) && ids.has(e.to))
      .map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  });
  const positions: Positions = {};
  for (const c of result.children ?? []) positions[c.id] = { x: c.x ?? 0, y: c.y ?? 0 };
  return positions;
}

/** Fallback positions immediately, ELK positions once the worker answers. */
export function useLayout(nodes: LayoutNode[], edges: LayoutEdge[]): { positions: Positions; engine: "elk" | "fallback" } {
  const key = useMemo(
    () => nodes.map((n) => n.id).join("|") + "#" + edges.map((e) => `${e.from}>${e.to}`).join("|"),
    [nodes, edges],
  );
  const fallback = useMemo(() => layeredFallback(nodes, edges), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const [elkResult, setElkResult] = useState<{ key: string; positions: Positions } | undefined>();
  useEffect(() => {
    let cancelled = false;
    elkLayout(nodes, edges).then(
      (positions) => {
        if (!cancelled) setElkResult({ key, positions });
      },
      (err: unknown) => {
        // Keep the fallback layout. Only report real ELK failures, not "no Worker" (tests).
        if (getElk() !== null) console.warn("[atlas] ELK layout failed; using fallback layout", err);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return elkResult?.key === key ? { positions: elkResult.positions, engine: "elk" } : { positions: fallback, engine: "fallback" };
}
