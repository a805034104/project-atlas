import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Root, SourceRef } from "../model/types.js";
import type { SourceSnippet } from "../protocol.js";
import { atlasHome } from "../runtime/session.js";

/**
 * Source access for the source panel / "open in editor", confined to the analyzed roots.
 *
 *   ref (rootId, file) ─▶ root ─▶ realpath(root), realpath(target) ─▶ inside root? ─▶ not under
 *   ~/.project-atlas (keys, tokens) ─▶ read ±context lines (size and binary caps)
 *
 * realpath on both sides: a symlink inside the repository must not reach outside it.
 *
 * `bounds` are directories the host itself knows (the imported folder, its clones). Roots come
 * from the stored graph, which a repository can ship in its own .atlas folder, so a root only
 * counts when it lies inside a bound. Inside a bound the ProjectAtlas home is fine (git imports
 * are checked out there); everywhere else it is refused.
 */

const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** true when `child` is `parent` or inside it (both already resolved). */
export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  if (relative === "") return true;
  return !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

/** Absolute, symlink-free path of `ref` when it stays inside its root; undefined otherwise. */
export async function resolveInRoot(roots: readonly Pick<Root, "id" | "path">[], ref: Pick<SourceRef, "rootId" | "file">, homeDir?: string, bounds?: readonly string[]): Promise<string | undefined> {
  const root = roots.find((r) => r.id === ref.rootId);
  if (!root || ref.file.includes("\0")) return undefined;
  try {
    const realRoot = await realpath(root.path);
    const target = await realpath(path.resolve(realRoot, ref.file));
    if (!isInside(realRoot, target)) return undefined;
    const home = await realpath(atlasHome(homeDir)).catch(() => path.resolve(atlasHome(homeDir)));
    if (bounds) {
      const realBounds = await Promise.all(bounds.map((b) => realpath(b).catch(() => undefined)));
      const bound = realBounds.find((b) => b !== undefined && isInside(b, realRoot) && isInside(b, target));
      if (!bound) return undefined;
      if (isInside(home, target) && !isInside(home, bound)) return undefined;
      return target;
    }
    if (isInside(home, target)) return undefined;
    return target;
  } catch {
    return undefined;
  }
}

/** Lines around `ref.line` (or the start of the file), for the web source panel. */
export async function readSnippet(roots: readonly Pick<Root, "id" | "path">[], ref: SourceRef, context = 20, homeDir?: string, bounds?: readonly string[]): Promise<SourceSnippet> {
  const target = await resolveInRoot(roots, ref, homeDir, bounds);
  // One answer for "missing" and "outside": the page must not learn which paths exist.
  if (!target) return { ref, startLine: 1, lines: [], error: "not-found" };
  const info = await stat(target);
  if (!info.isFile()) return { ref, startLine: 1, lines: [], error: "not-found" };
  if (info.size > MAX_FILE_BYTES) return { ref, absolutePath: target, startLine: 1, lines: [], error: "too-large" };
  const handle = await open(target, "r");
  let buffer: Buffer;
  try {
    buffer = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (buffer.subarray(0, 8000).includes(0)) return { ref, absolutePath: target, startLine: 1, lines: [], error: "binary" };
  const all = buffer.toString("utf8").split(/\r?\n/);
  const line = Math.min(Math.max(1, ref.line ?? 1), all.length);
  const start = Math.max(1, line - context);
  const end = Math.min(all.length, line + context);
  return { ref, absolutePath: target, startLine: start, lines: all.slice(start - 1, end) };
}
