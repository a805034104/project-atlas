import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { emptyAggregates, type AggregateState } from "./aggregate.js";
import type { SpanRecord } from "./span-record.js";

/**
 * `.atlas/traces/`:
 *   spans-<epochMs>.jsonl   raw SpanRecords, one per line, appended whole-line; rotated by count
 *   aggregates.json         AggregateState (written atomically: tmp + rename)
 *
 * Retention drops whole segments: older than maxAgeMs, then oldest first while
 * the total exceeds maxSpans. Aggregates are never derived from raw segments,
 * so eviction does not lose statistics.
 */

export interface TraceStoreOptions {
  maxSpans?: number;
  maxAgeMs?: number;
  segmentSpans?: number;
  now?: () => number;
}

interface Segment {
  file: string;
  created: number;
  lines: number;
}

const SEGMENT = /^spans-(\d+)(?:-(\d+))?\.jsonl$/;

async function retry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 4 || !(code === "EBUSY" || code === "EPERM" || code === "EACCES")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

export class TraceStore {
  private segments: Segment[] | undefined;
  private readonly maxSpans: number;
  private readonly maxAgeMs: number;
  private readonly segmentSpans: number;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly dir: string,
    options: TraceStoreOptions = {},
  ) {
    this.maxSpans = options.maxSpans ?? 100_000;
    this.maxAgeMs = options.maxAgeMs ?? 7 * 24 * 3600 * 1000;
    this.segmentSpans = options.segmentSpans ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  /** Serialise all writes (append, rotate, retention, aggregates) through one queue. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async load(): Promise<Segment[]> {
    if (this.segments) return this.segments;
    await mkdir(this.dir, { recursive: true });
    const names = (await readdir(this.dir)).filter((n) => SEGMENT.test(n)).sort((a, b) => segmentOrder(a) - segmentOrder(b));
    const segments: Segment[] = [];
    for (const name of names) {
      const text = await readFile(path.join(this.dir, name), "utf8").catch(() => "");
      segments.push({ file: name, created: Number(SEGMENT.exec(name)?.[1] ?? 0), lines: countLines(text) });
    }
    this.segments = segments;
    return segments;
  }

  append(records: readonly SpanRecord[]): Promise<void> {
    if (records.length === 0) return Promise.resolve();
    return this.serial(async () => {
      const segments = await this.load();
      let rest = [...records];
      while (rest.length > 0) {
        let current = segments[segments.length - 1];
        if (!current || current.lines >= this.segmentSpans) {
          const created = this.now();
          const taken = new Set(segments.map((s) => s.file));
          let file = `spans-${created}.jsonl`;
          for (let i = 1; taken.has(file); i++) file = `spans-${created}-${i}.jsonl`;
          current = { file, created, lines: 0 };
          segments.push(current);
        }
        const room = this.segmentSpans - current.lines;
        const chunk = rest.slice(0, room);
        rest = rest.slice(room);
        await appendFile(path.join(this.dir, current.file), chunk.map((r) => `${JSON.stringify(r)}\n`).join(""));
        current.lines += chunk.length;
      }
      await this.retain(segments);
    });
  }

  private async retain(segments: Segment[]): Promise<void> {
    const cutoff = this.now() - this.maxAgeMs;
    const remove = (s: Segment) => retry(() => rm(path.join(this.dir, s.file), { force: true }));
    // Never drop the segment being written to.
    while (segments.length > 1) {
      const oldest = segments[0] as Segment;
      const total = segments.reduce((n, s) => n + s.lines, 0);
      const expired = await stat(path.join(this.dir, oldest.file)).then((st) => st.mtimeMs < cutoff, () => true);
      if (!expired && total <= this.maxSpans) break;
      await remove(oldest);
      segments.shift();
    }
  }

  async count(): Promise<number> {
    return (await this.load()).reduce((n, s) => n + s.lines, 0);
  }

  /** All stored records, oldest first. A torn last line (crash mid-write) is skipped. */
  async *records(): AsyncGenerator<SpanRecord> {
    const segments = [...(await this.load())];
    for (const s of segments) {
      const text = await readFile(path.join(this.dir, s.file), "utf8").catch(() => "");
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          yield JSON.parse(line) as SpanRecord;
        } catch {
          // torn or foreign line
        }
      }
    }
  }

  async loadAggregates(): Promise<AggregateState> {
    try {
      const parsed = JSON.parse(await readFile(path.join(this.dir, "aggregates.json"), "utf8")) as AggregateState;
      return parsed.version === 1 ? parsed : emptyAggregates();
    } catch {
      return emptyAggregates();
    }
  }

  saveAggregates(state: AggregateState): Promise<void> {
    return this.serial(async () => {
      await mkdir(this.dir, { recursive: true });
      const target = path.join(this.dir, "aggregates.json");
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify(state));
      await retry(() => rename(tmp, target));
    });
  }

  /** Remove every stored span and aggregate (user action "clear traces"). */
  clear(): Promise<void> {
    return this.serial(async () => {
      const segments = await this.load();
      for (const s of segments) await retry(() => rm(path.join(this.dir, s.file), { force: true }));
      segments.length = 0;
      await retry(() => rm(path.join(this.dir, "aggregates.json"), { force: true }));
    });
  }
}

function segmentOrder(name: string): number {
  const m = SEGMENT.exec(name);
  return Number(m?.[1] ?? 0) * 1000 + Number(m?.[2] ?? 0);
}

function countLines(text: string): number {
  let n = 0;
  for (const line of text.split("\n")) if (line.trim()) n++;
  return n;
}
