import { parentPort, workerData } from "node:worker_threads";
import { extractFacts, type ParsedKind } from "./extract.js";
import { loadParsers, type ParserSet } from "./treesitter.js";

/** Worker entry: one ParserSet per thread, parse requests answered in order. */

export interface ParseRequest {
  id: number;
  kind: ParsedKind;
  text: string;
  relPath: string;
}

export type ParseResponse =
  | { id: number; ok: true; facts: ReturnType<typeof extractFacts> }
  | { id: number; ok: false; error: string };

const wasmDir = (workerData as { wasmDir?: string } | undefined)?.wasmDir;
let parsers: Promise<ParserSet> | undefined;

parentPort?.on("message", async (request: ParseRequest) => {
  try {
    parsers ??= loadParsers(wasmDir);
    const set = await parsers;
    const facts = extractFacts(set, request.kind, request.text, request.relPath);
    parentPort?.postMessage({ id: request.id, ok: true, facts } satisfies ParseResponse);
  } catch (error) {
    parentPort?.postMessage({ id: request.id, ok: false, error: (error as Error).message } satisfies ParseResponse);
  }
});
