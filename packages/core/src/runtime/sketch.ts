/**
 * Log-bucket quantile sketch (DDSketch-style, relative accuracy ±2%).
 *
 *   value v (ms) ─▶ bucket ⌈log_γ v⌉, γ = (1+α)/(1−α) ─▶ count
 *
 * Mergeable, JSON-serialisable, bounded: ~350 buckets cover 1 µs … 1 h.
 */

const ALPHA = 0.02;
const GAMMA = (1 + ALPHA) / (1 - ALPHA);
const LOG_GAMMA = Math.log(GAMMA);
const MIN_VALUE = 0.001;

export type Sketch = Record<string, number>;

export function sketchAdd(sketch: Sketch, valueMs: number): void {
  const key = valueMs <= MIN_VALUE ? "z" : String(Math.ceil(Math.log(valueMs) / LOG_GAMMA));
  sketch[key] = (sketch[key] ?? 0) + 1;
}

export function sketchMerge(into: Sketch, from: Sketch): void {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
}

/** Quantile q ∈ [0, 1]; 0 for an empty sketch. */
export function sketchQuantile(sketch: Sketch, q: number): number {
  const entries = Object.entries(sketch).map(([k, n]) => ({ idx: k === "z" ? Number.NEGATIVE_INFINITY : Number(k), n }));
  const total = entries.reduce((s, e) => s + e.n, 0);
  if (total === 0) return 0;
  entries.sort((a, b) => a.idx - b.idx);
  const rank = q * (total - 1);
  let seen = 0;
  for (const e of entries) {
    seen += e.n;
    if (seen > rank) return e.idx === Number.NEGATIVE_INFINITY ? 0 : (2 * GAMMA ** e.idx) / (GAMMA + 1);
  }
  const last = entries[entries.length - 1] as { idx: number };
  return (2 * GAMMA ** last.idx) / (GAMMA + 1);
}
