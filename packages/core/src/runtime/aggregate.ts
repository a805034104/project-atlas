import { sketchAdd, sketchQuantile, type Sketch } from "./sketch.js";
import type { SpanRecord } from "./span-record.js";

/**
 * Incremental runtime aggregates, independent of raw-span retention.
 *
 *   SpanRecord ─▶ canonical key (m: method | r: route | d: db | q: queue system:kind:service:destination |
 *                               h: http client | n: name)
 *              ─▶ node stats            count / errors / sketch / last seen / sample traces
 *   parent ⨝ child (window, either order) ─▶ edge stats "parentKey>childKey" (+ async when the
 *              child on another thread that starts after the parent ended)
 *   roots ─▶ recent trace summaries (trace list)
 *
 * Keys never contain step ids: they are re-resolved against the current graph
 * on every view, so stats survive re-analysis and raw-span eviction.
 */

export interface Stats {
  count: number;
  err: number;
  /** epoch ms */
  lastSeen: number;
  sketch: Sketch;
  /** Most recent trace ids (newest first, ≤ 5). */
  samples: string[];
}

export interface EdgeStats extends Stats {
  async?: boolean;
}

export interface TraceSummary {
  t: string;
  start: number;
  dur: number;
  err: boolean;
  spans: number;
  services: string[];
  root?: { name: string; key: string; svc: string };
}

export interface AggregateState {
  version: number;
  nodes: Record<string, Stats>;
  edges: Record<string, EdgeStats>;
  /** Newest first. */
  traces: TraceSummary[];
  total: number;
  duplicates: number;
  /** Spans whose key arrived after the key limit (a route per tenant, dynamic topics…): counted, not kept. */
  overflow?: number;
}

const MAX_SAMPLES = 5;
/** Distinct keys kept (a few thousand in real services); bounds memory and aggregates.json. */
const MAX_NODE_KEYS = 20_000;
const MAX_EDGE_KEYS = 50_000;
const MAX_TRACES = 200;
/** Parent/child join window: at 200 spans/s, 20 000 spans is ~100 s (children usually arrive within a second). */
const MAX_RECENT_SPANS = 20_000;
const MAX_WAITING = 10_000;

export function spanKey(r: SpanRecord): string {
  const a = r.a;
  // The service is part of the key: a class shared by several services (common modules) is a
  // different step in each of them.
  if (a.cls && a.fn) return `m:${r.svc}:${a.cls}#${a.fn}`;
  if (r.kind === "server" && a.route) return `r:${r.svc}:${a.method ?? "ANY"} ${a.route}`;
  if (a.dbSystem) return `d:${r.svc}:${a.dbOp ?? "?"} ${a.dbTable ?? "?"}`;
  if (a.msgSystem && a.msgDest) return `q:${a.msgSystem}:${r.kind}:${r.svc}:${a.msgDest}`;
  if (r.kind === "client" && a.method) return `h:${r.svc}:${a.method} ${a.peer ?? ""}`;
  return `n:${r.svc}:${r.name}`;
}

export function emptyAggregates(): AggregateState {
  return { version: AGGREGATES_VERSION, nodes: {}, edges: {}, traces: [], total: 0, duplicates: 0 };
}

/** v2: method keys carry the service (`m:svc:Class#method`). Older files are discarded. */
export const AGGREGATES_VERSION = 2;

/** `m:svc:Class#method` → service + `Class#method` (service names may contain ':'). */
export function parseMethodSpanKey(key: string): { svc: string; method: string } | undefined {
  if (!key.startsWith("m:")) return undefined;
  const at = key.lastIndexOf(":");
  if (at < 2) return undefined;
  return { svc: key.slice(2, at), method: key.slice(at + 1) };
}

export function statsQuantile(stats: Stats | undefined, q: number): number {
  return stats ? sketchQuantile(stats.sketch, q) : 0;
}

function touch(stats: Stats, r: SpanRecord, durMs: number, err: boolean): void {
  stats.count++;
  if (err) stats.err++;
  stats.lastSeen = Math.max(stats.lastSeen, r.start + r.dur);
  sketchAdd(stats.sketch, durMs);
  if (stats.samples[0] !== r.t) {
    stats.samples.unshift(r.t);
    if (stats.samples.length > MAX_SAMPLES) stats.samples.length = MAX_SAMPLES;
  }
}

interface Seen {
  key: string;
  start: number;
  end: number;
  thread?: string;
}

export class Aggregator {
  readonly state: AggregateState;
  private readonly recent = new Map<string, Seen>();
  private readonly waiting = new Map<string, { seen: Seen; r: SpanRecord }[]>();
  private waitingCount = 0;
  private readonly traceIndex = new Map<string, TraceSummary>();
  private nodeKeys: number;
  private edgeKeys: number;

  constructor(state: AggregateState = emptyAggregates()) {
    this.state = state;
    for (const t of state.traces) this.traceIndex.set(t.t, t);
    this.nodeKeys = Object.keys(state.nodes).length;
    this.edgeKeys = Object.keys(state.edges).length;
  }

  /** Forget everything (user cleared the traces): state, join windows and trace index. */
  reset(): void {
    Object.assign(this.state, emptyAggregates());
    this.recent.clear();
    this.waiting.clear();
    this.waitingCount = 0;
    this.traceIndex.clear();
    this.nodeKeys = 0;
    this.edgeKeys = 0;
  }

  /** Fold a batch in; returns the records that were new (duplicates from exporter retries are skipped). */
  add(records: readonly SpanRecord[]): SpanRecord[] {
    const fresh: SpanRecord[] = [];
    for (const r of records) {
      const id = `${r.t}:${r.s}`;
      if (this.recent.has(id)) {
        this.state.duplicates++;
        continue;
      }
      fresh.push(r);
      this.state.total++;
      const key = spanKey(r);
      const seen: Seen = { key, start: r.start, end: r.start + r.dur, ...(r.a.thread ? { thread: r.a.thread } : {}) };
      this.remember(id, seen);
      let node = this.state.nodes[key];
      if (!node && this.nodeKeys < MAX_NODE_KEYS) {
        node = this.state.nodes[key] = { count: 0, err: 0, lastSeen: 0, sketch: {}, samples: [] };
        this.nodeKeys++;
      }
      if (node) touch(node, r, r.dur, r.err);
      else this.state.overflow = (this.state.overflow ?? 0) + 1;

      if (r.p) {
        const parentId = `${r.t}:${r.p}`;
        const parent = this.recent.get(parentId);
        if (parent) this.edge(parent, seen, r);
        else this.wait(parentId, seen, r);
      }
      const children = this.waiting.get(id);
      if (children) {
        this.waiting.delete(id);
        this.waitingCount -= children.length;
        for (const c of children) this.edge(seen, c.seen, c.r);
      }
      this.trace(r, key);
    }
    this.state.traces = [...this.traceIndex.values()].sort((a, b) => b.start - a.start).slice(0, MAX_TRACES);
    if (this.traceIndex.size > MAX_TRACES * 4) {
      const keep = new Set(this.state.traces.map((t) => t.t));
      for (const id of this.traceIndex.keys()) if (!keep.has(id)) this.traceIndex.delete(id);
    }
    return fresh;
  }

  private remember(id: string, seen: Seen): void {
    this.recent.set(id, seen);
    if (this.recent.size > MAX_RECENT_SPANS) {
      const oldest = this.recent.keys().next().value;
      if (oldest !== undefined) this.recent.delete(oldest);
    }
  }

  private wait(parentId: string, seen: Seen, r: SpanRecord): void {
    const list = this.waiting.get(parentId) ?? [];
    list.push({ seen, r });
    this.waiting.set(parentId, list);
    this.waitingCount++;
    while (this.waitingCount > MAX_WAITING) {
      const oldest = this.waiting.keys().next().value;
      if (oldest === undefined) break;
      this.waitingCount -= this.waiting.get(oldest)?.length ?? 0;
      this.waiting.delete(oldest);
    }
  }

  private edge(parent: Seen, child: Seen, r: SpanRecord): void {
    const key = `${parent.key}>${child.key}`;
    let stats = this.state.edges[key];
    if (!stats) {
      if (this.edgeKeys >= MAX_EDGE_KEYS) return;
      stats = this.state.edges[key] = { count: 0, err: 0, lastSeen: 0, sketch: {}, samples: [] };
      this.edgeKeys++;
    }
    touch(stats, r, r.dur, r.err);
    const otherThread = parent.thread !== undefined && child.thread !== undefined && parent.thread !== child.thread;
    // V7: async = handed to another thread AND not awaited (submit(..).get() stays synchronous).
    if (otherThread && child.start >= parent.end) stats.async = true;
  }

  private trace(r: SpanRecord, key: string): void {
    let t = this.traceIndex.get(r.t);
    if (!t) {
      t = { t: r.t, start: r.start, dur: r.dur, err: false, spans: 0, services: [] };
      this.traceIndex.set(r.t, t);
    }
    t.spans++;
    if (!t.services.includes(r.svc)) t.services.push(r.svc);
    if (r.err) t.err = true;
    const end = Math.max(t.start + t.dur, r.start + r.dur);
    t.start = Math.min(t.start, r.start);
    t.dur = end - t.start;
    if (!r.p) t.root = { name: r.name, key, svc: r.svc };
  }
}
