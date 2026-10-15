import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import type { Diagnostic } from "../model/types.js";
import { classifyFile, type FileKind } from "./lang.js";

/**
 * Workspace walk.
 *
 *   root ─▶ readdir ─▶ ignore? (defaults + .gitignore per dir + .atlasignore + extra)
 *            │            └─ skip
 *            ├─ symlinked dir ─▶ skip (+ diagnostic; avoids loops and escapes)
 *            ├─ dir ─▶ recurse
 *            └─ file ─▶ too big? ─▶ skip (+ diagnostic) ─▶ FileEntry
 */

export interface FileEntry {
  rootId: string;
  /** Relative to the root, forward slashes. */
  relPath: string;
  absPath: string;
  size: number;
  kind: FileKind;
}

export interface WalkOptions {
  rootId: string;
  rootPath: string;
  /** Extra gitignore-syntax patterns (setting `atlas.analysis.exclude`). */
  exclude?: readonly string[];
  maxFileSizeKB?: number;
  signal?: AbortSignal;
}

export interface WalkResult {
  files: FileEntry[];
  diagnostics: Diagnostic[];
}

export const DEFAULT_EXCLUDES: readonly string[] = [
  ".git/",
  ".svn/",
  ".hg/",
  ".atlas/",
  ".idea/",
  ".vscode/",
  "node_modules/",
  "bower_components/",
  "target/",
  "build/",
  "dist/",
  "out/",
  "coverage/",
  ".gradle/",
  ".mvn/",
  "venv/",
  ".venv/",
  "__pycache__/",
  "*.min.js",
  "*.min.css",
  "*.map",
  "*.class",
  "*.jar",
  "*.war",
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.gif",
  "*.ico",
  "*.svg",
  "*.woff",
  "*.woff2",
  "*.ttf",
  "*.eot",
  "*.pdf",
  "*.zip",
  "*.gz",
  "*.lock",
  "package-lock.json",
];

interface Matcher {
  /** Directory (relative to root, "" for root) whose patterns these are. */
  base: string;
  ig: Ignore;
}

async function readIgnoreFile(absPath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(absPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isIgnored(matchers: readonly Matcher[], relPath: string, isDir: boolean): boolean {
  for (const { base, ig } of matchers) {
    if (base && !relPath.startsWith(`${base}/`)) continue;
    const local = base ? relPath.slice(base.length + 1) : relPath;
    if (ig.ignores(isDir ? `${local}/` : local)) return true;
  }
  return false;
}

export async function walkWorkspace(options: WalkOptions): Promise<WalkResult> {
  const { rootId, rootPath, signal } = options;
  const maxBytes = (options.maxFileSizeKB ?? 2048) * 1024;
  const files: FileEntry[] = [];
  const diagnostics: Diagnostic[] = [];

  const rootMatcher = ignore().add([...DEFAULT_EXCLUDES]);
  if (options.exclude) rootMatcher.add([...options.exclude]);
  const atlasIgnore = await readIgnoreFile(path.join(rootPath, ".atlasignore"));
  if (atlasIgnore) rootMatcher.add(atlasIgnore);
  const baseMatchers: Matcher[] = [{ base: "", ig: rootMatcher }];

  async function visit(dirRel: string, matchers: Matcher[]): Promise<void> {
    signal?.throwIfAborted();
    const dirAbs = dirRel ? path.join(rootPath, dirRel) : rootPath;
    let scoped = matchers;
    const gitignore = await readIgnoreFile(path.join(dirAbs, ".gitignore"));
    if (gitignore) scoped = [...matchers, { base: dirRel, ig: ignore().add(gitignore) }];

    let entries;
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch (error) {
      diagnostics.push({
        code: "ATLAS-W002",
        severity: "warning",
        message: `Cannot read directory ${dirRel || "."}: ${(error as Error).message}`,
      });
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        diagnostics.push({
          code: "ATLAS-I003",
          severity: "info",
          message: `Skipped symbolic link ${rel}`,
          at: { rootId, file: rel },
        });
        continue;
      }
      if (entry.isDirectory()) {
        if (!isIgnored(scoped, rel, true)) await visit(rel, scoped);
        continue;
      }
      if (!entry.isFile() || isIgnored(scoped, rel, false)) continue;
      const absPath = path.join(dirAbs, entry.name);
      const { size } = await fs.stat(absPath);
      if (size > maxBytes) {
        diagnostics.push({
          code: "ATLAS-W003",
          severity: "warning",
          message: `Skipped ${rel}: ${Math.round(size / 1024)} KB exceeds atlas.analysis.maxFileSizeKB`,
          at: { rootId, file: rel },
        });
        continue;
      }
      files.push({ rootId, relPath: rel, absPath, size, kind: classifyFile(rel) });
    }
  }

  await visit("", baseMatchers);
  return { files, diagnostics };
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
