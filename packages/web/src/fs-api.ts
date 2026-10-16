import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Folder picker for the import dialog: directory names only (never file names or contents),
 * with a marker on folders that look like projects. Hidden and dependency folders are skipped.
 */

export interface DirListing {
  path: string;
  parent?: string;
  dirs: { name: string; path: string; project: boolean }[];
  /** Quick roots: home and, on Windows, existing drive letters. */
  roots: { label: string; path: string }[];
}

const SKIP = new Set(["node_modules", "target", "dist", "build", "$RECYCLE.BIN", "System Volume Information"]);
const PROJECT_MARKERS = ["pom.xml", "package.json", "build.gradle", "build.gradle.kts", ".git", "settings.gradle"];

export async function listDirs(input: string | undefined): Promise<DirListing> {
  const target = input && path.isAbsolute(input) && !/^(\\\\|\/\/)/.test(input) ? path.resolve(input) : homedir();
  const entries = await readdir(target, { withFileTypes: true }).catch(() => []);
  const dirs: DirListing["dirs"] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || SKIP.has(e.name)) continue;
    const full = path.join(target, e.name);
    const children = await readdir(full).catch(() => [] as string[]);
    dirs.push({ name: e.name, path: full, project: PROJECT_MARKERS.some((m) => children.includes(m)) });
    if (dirs.length >= 500) break;
  }
  dirs.sort((a, b) => Number(b.project) - Number(a.project) || a.name.localeCompare(b.name));
  const parent = path.dirname(target);
  return { path: target, ...(parent !== target ? { parent } : {}), dirs, roots: await quickRoots() };
}

async function quickRoots(): Promise<DirListing["roots"]> {
  const roots = [{ label: "~", path: homedir() }];
  if (process.platform === "win32") {
    for (const letter of "CDEFGHIJ") {
      const drive = `${letter}:\\`;
      if (await stat(drive).then(() => true, () => false)) roots.push({ label: `${letter}:`, path: drive });
    }
  } else {
    roots.push({ label: "/", path: "/" });
  }
  return roots;
}
