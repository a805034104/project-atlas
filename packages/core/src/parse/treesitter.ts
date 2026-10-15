import { createRequire } from "node:module";
import path from "node:path";
import { Language, Parser } from "web-tree-sitter";

/**
 * Grammar loading. web-tree-sitter looks for its runtime wasm next to the JS
 * bundle by default, which breaks once the extension is bundled, so every
 * path is explicit (`wasmDir` when packaged, node_modules resolution in dev).
 * One instance per thread: a WASM module cannot be shared across workers.
 */

export type GrammarId = "java" | "javascript" | "typescript" | "tsx";

const GRAMMAR_FILES: Record<GrammarId, { pkg: string; file: string }> = {
  java: { pkg: "tree-sitter-java", file: "tree-sitter-java.wasm" },
  javascript: { pkg: "tree-sitter-javascript", file: "tree-sitter-javascript.wasm" },
  typescript: { pkg: "tree-sitter-typescript", file: "tree-sitter-typescript.wasm" },
  tsx: { pkg: "tree-sitter-typescript", file: "tree-sitter-tsx.wasm" },
};

export interface ParserSet {
  parser: Parser;
  languages: Record<GrammarId, Language>;
}

const require = createRequire(import.meta.url);

function grammarPath(id: GrammarId, wasmDir: string | undefined): string {
  const { pkg, file } = GRAMMAR_FILES[id];
  if (wasmDir) return path.join(wasmDir, file);
  return path.join(path.dirname(require.resolve(`${pkg}/package.json`)), file);
}

function runtimePath(wasmDir: string | undefined): string {
  return wasmDir ? path.join(wasmDir, "web-tree-sitter.wasm") : require.resolve("web-tree-sitter/web-tree-sitter.wasm");
}

let initialized: Promise<void> | undefined;

export async function loadParsers(wasmDir?: string): Promise<ParserSet> {
  initialized ??= Parser.init({ locateFile: () => runtimePath(wasmDir) });
  await initialized;
  const ids = Object.keys(GRAMMAR_FILES) as GrammarId[];
  const loaded = await Promise.all(ids.map((id) => Language.load(grammarPath(id, wasmDir))));
  const languages = Object.fromEntries(ids.map((id, i) => [id, loaded[i]])) as Record<GrammarId, Language>;
  return { parser: new Parser(), languages };
}

export function grammarFiles(): string[] {
  return ["web-tree-sitter.wasm", ...Object.values(GRAMMAR_FILES).map((g) => g.file)];
}

export function grammarSourcePaths(): Record<string, string> {
  const out: Record<string, string> = { "web-tree-sitter.wasm": runtimePath(undefined) };
  for (const id of Object.keys(GRAMMAR_FILES) as GrammarId[]) out[GRAMMAR_FILES[id].file] = grammarPath(id, undefined);
  return out;
}
