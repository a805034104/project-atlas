import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FileFacts } from "../facts/types.js";
import { decodeSource, looksBinary } from "../ingest/decode.js";
import { isParsedKind, type FileKind } from "../ingest/lang.js";
import { hashBytes, walkWorkspace, type FileEntry } from "../ingest/walker.js";
import type { Diagnostic, Root } from "../model/types.js";
import type { ParsePool } from "../parse/pool.js";
import { createLimiter } from "../llm/pipeline.js";

/** Concurrent file reads; unbounded Promise.all hits EMFILE on large repositories. */
const READ_CONCURRENCY = 64;

/**
 * Load every root into memory as facts (parsed kinds) or text (config kinds).
 *
 *   roots ─▶ walk ─▶ read + hash ─▶ facts cache hit? ─yes─▶ facts
 *                                     │no
 *                                     └▶ pool.parse ─▶ cache write ─▶ facts
 *
 * Facts are cached per (content hash, analyzer version) under
 * `<cacheDir>/facts/`; config-like text is small and always re-read.
 */

export interface LoadedFile extends FileEntry {
  hash: string;
  /** Line count (for module LOC). */
  lines: number;
  facts?: FileFacts;
  /** Text for non-parsed kinds that rules read (configs, manifests, SQL dumps, scripts). */
  text?: string;
}

export interface Workspace {
  roots: Root[];
  files: LoadedFile[];
  diagnostics: Diagnostic[];
}

const TEXT_KINDS: ReadonlySet<FileKind> = new Set<FileKind>([
  "maven-pom",
  "gradle",
  "npm-manifest",
  "yaml",
  "properties",
  "env",
  "mybatis-xml",
  "xml",
  "dockerfile",
  "compose",
  "nginx",
  "shell",
  "sql",
  "markdown",
]);

export interface LoadOptions {
  roots: Root[];
  pool: ParsePool;
  analyzerVersion: string;
  cacheDir?: string;
  exclude?: readonly string[];
  maxFileSizeKB?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

export function fileKey(rootId: string, relPath: string): string {
  return `${rootId}:${relPath}`;
}

async function readCachedFacts(cacheDir: string | undefined, key: string): Promise<FileFacts | undefined> {
  if (!cacheDir) return undefined;
  try {
    return JSON.parse(await readFile(path.join(cacheDir, "facts", key.slice(0, 2), `${key}.json`), "utf8")) as FileFacts;
  } catch {
    return undefined; // missing or corrupt cache entry: reparse
  }
}

async function writeCachedFacts(cacheDir: string | undefined, key: string, facts: FileFacts): Promise<void> {
  if (!cacheDir) return;
  const dir = path.join(cacheDir, "facts", key.slice(0, 2));
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, `${key}.json`);
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(facts));
  await rename(tmp, target);
}

export async function loadWorkspace(options: LoadOptions): Promise<Workspace> {
  const { pool, signal } = options;
  const diagnostics: Diagnostic[] = [];
  const entries: FileEntry[] = [];
  for (const root of options.roots) {
    const walked = await walkWorkspace({
      rootId: root.id,
      rootPath: root.path,
      ...(options.exclude ? { exclude: options.exclude } : {}),
      ...(options.maxFileSizeKB ? { maxFileSizeKB: options.maxFileSizeKB } : {}),
      ...(signal ? { signal } : {}),
    });
    entries.push(...walked.files);
    diagnostics.push(...walked.diagnostics);
  }

  const relevant = entries.filter((e) => isParsedKind(e.kind) || TEXT_KINDS.has(e.kind));
  const files: LoadedFile[] = new Array(relevant.length);
  let done = 0;
  let parseErrors = 0;

  const limit = createLimiter(READ_CONCURRENCY);
  await Promise.all(
    relevant.map((entry, index) => limit(async () => {
      signal?.throwIfAborted();
      const bytes = await readFile(entry.absPath);
      const hash = hashBytes(bytes);
      const loaded: LoadedFile = { ...entry, hash, lines: 0 };
      files[index] = loaded;
      if (looksBinary(bytes)) return;
      const text = decodeSource(bytes).text;
      loaded.lines = text.length === 0 ? 0 : text.split("\n").length;
      if (isParsedKind(entry.kind)) {
        const cacheKey = `${hash}-${options.analyzerVersion}`;
        let facts = await readCachedFacts(options.cacheDir, cacheKey);
        if (!facts) {
          try {
            facts = await pool.parse(entry.kind, text, entry.relPath);
            if (facts) await writeCachedFacts(options.cacheDir, cacheKey, facts);
          } catch (error) {
            parseErrors++;
            diagnostics.push({
              code: "ATLAS-E010",
              severity: "warning",
              message: (error as Error).message,
              at: { rootId: entry.rootId, file: entry.relPath },
            });
          }
        }
        if (facts) loaded.facts = facts;
      } else {
        loaded.text = text;
      }
      done++;
      options.onProgress?.(done, relevant.length);
    })),
  );

  if (parseErrors > 0) {
    diagnostics.push({ code: "ATLAS-E010", severity: "warning", message: `${parseErrors} file(s) could not be parsed` });
  }
  return { roots: options.roots, files: files.filter(Boolean), diagnostics };
}
