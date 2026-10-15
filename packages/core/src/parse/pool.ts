import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { FileFacts } from "../facts/types.js";
import { extractFacts, type ParsedKind } from "./extract.js";
import { loadParsers, type ParserSet } from "./treesitter.js";
import type { ParseRequest, ParseResponse } from "./worker.js";

/**
 * Parse pool. Keeps CPU-heavy parsing off the extension host thread.
 *
 *   parse(kind, text) ─▶ queue ─▶ idle worker? ─▶ postMessage ─▶ facts
 *                                    └─ none ─▶ wait
 *
 * size 0 (or running from TypeScript sources, e.g. under vitest) parses
 * inline on the calling thread with the same extractor.
 */

export interface ParsePool {
  parse(kind: ParsedKind, text: string, relPath: string): Promise<FileFacts | undefined>;
  close(): Promise<void>;
}

export interface PoolOptions {
  size?: number;
  wasmDir?: string;
  /** Bundled worker script (packaged extension); defaults to ./worker.js next to this module. */
  workerPath?: string;
}

export function defaultPoolSize(): number {
  return Math.max(1, Math.min(4, availableParallelism() - 1));
}

export async function createParsePool(options: PoolOptions = {}): Promise<ParsePool> {
  const moduleUrl: string = import.meta.url ?? "";
  const runningFromSource = moduleUrl.endsWith(".ts");
  const workerPath = options.workerPath ? path.resolve(options.workerPath) : moduleUrl ? fileURLToPath(new URL("./worker.js", moduleUrl)) : undefined;
  const size = runningFromSource || !workerPath ? 0 : (options.size ?? defaultPoolSize());
  if (size === 0 || !workerPath) return inlinePool(await loadParsers(options.wasmDir));
  return workerPool(workerPath, size, options.wasmDir);
}

function inlinePool(set: ParserSet): ParsePool {
  return {
    parse: async (kind, text, relPath) => extractFacts(set, kind, text, relPath),
    close: async () => {},
  };
}

interface Pending {
  request: ParseRequest;
  resolve: (facts: FileFacts | undefined) => void;
  reject: (error: Error) => void;
}

function workerPool(workerPath: string, size: number, wasmDir: string | undefined): ParsePool {
  const queue: Pending[] = [];
  const idle: Worker[] = [];
  const busy = new Map<Worker, Pending>();
  let nextId = 0;
  let closed = false;

  const spawn = (): Worker => {
    const worker = new Worker(workerPath, { workerData: { wasmDir } });
    worker.on("message", (response: ParseResponse) => {
      const pending = busy.get(worker);
      busy.delete(worker);
      if (pending) {
        if (response.ok) pending.resolve(response.facts);
        else pending.reject(new Error(`parse failed for ${pending.request.relPath}: ${response.error}`));
      }
      idle.push(worker);
      pump();
    });
    worker.on("error", (error) => {
      // A crashed worker fails only its in-flight file; a fresh worker replaces it.
      const pending = busy.get(worker);
      busy.delete(worker);
      pending?.reject(new Error(`parse worker crashed on ${pending.request.relPath}: ${error.message}`));
      if (!closed) {
        idle.push(spawn());
        pump();
      }
    });
    return worker;
  };

  const pump = (): void => {
    while (idle.length > 0 && queue.length > 0) {
      const worker = idle.pop() as Worker;
      const pending = queue.shift() as Pending;
      busy.set(worker, pending);
      worker.postMessage(pending.request);
    }
  };

  for (let i = 0; i < size; i++) idle.push(spawn());

  return {
    parse: (kind, text, relPath) =>
      new Promise((resolve, reject) => {
        if (closed) {
          reject(new Error("parse pool is closed"));
          return;
        }
        queue.push({ request: { id: nextId++, kind, text, relPath }, resolve, reject });
        pump();
      }),
    close: async () => {
      closed = true;
      for (const pending of queue.splice(0)) pending.reject(new Error("parse pool closed"));
      await Promise.all([...idle, ...busy.keys()].map((w) => w.terminate()));
    },
  };
}
