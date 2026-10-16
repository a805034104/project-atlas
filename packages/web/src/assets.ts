import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { grammarSourcePaths } from "@project-atlas/core";

/**
 * Where the page bundle, the tree-sitter wasm files and the parse worker come from.
 *
 *   single-file build (Node SEA): embedded assets ─▶ <home>/app/<version>/ (sha256-checked; the
 *     worker and wasm need real files) ─▶ reused on later launches
 *   source checkout: packages/webview/dist + packages/web/static + core's dist/parse/worker.js
 *
 * The worker path is always explicit: without it the parse pool silently runs single-threaded.
 */

export interface Assets {
  /** webview.js, webview.css, web-theme.css, favicon.svg */
  assetsDir: string;
  wasmDir?: string;
  workerPath?: string;
  mode: "sea" | "source";
}

/** Names embedded in the single-file build (see build-sea.mjs). */
export const EMBEDDED = ["webview.js", "webview.css", "web-theme.css", "favicon.svg", "worker.js", "web-tree-sitter.wasm", "tree-sitter-java.wasm", "tree-sitter-javascript.wasm", "tree-sitter-typescript.wasm", "tree-sitter-tsx.wasm"] as const;

interface SeaApi {
  isSea(): boolean;
  getAsset(key: string): ArrayBuffer;
}

async function seaApi(): Promise<SeaApi | undefined> {
  try {
    const sea = (await import("node:sea")) as unknown as SeaApi;
    return sea.isSea() ? sea : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveAssets(home: string, version: string, here: string): Promise<Assets> {
  const sea = await seaApi();
  if (sea) return unpack(sea, path.join(home, "app", version));
  // Source checkout: here = packages/web/dist
  const repoPackages = path.resolve(here, "..", "..");
  const webviewDist = path.join(repoPackages, "webview", "dist");
  const staticDir = path.join(repoPackages, "web", "static");
  const assetsDir = path.join(repoPackages, "web", ".assets");
  await mkdir(assetsDir, { recursive: true });
  for (const [name, from] of [["webview.js", webviewDist], ["webview.css", webviewDist], ["web-theme.css", staticDir], ["favicon.svg", staticDir]] as const) {
    const source = path.join(from, name);
    if (!existsSync(source)) throw new Error(`missing ${source}: run \`npm run build\` first`);
    await writeFile(path.join(assetsDir, name), await readFile(source));
  }
  const require = createRequire(import.meta.url);
  const coreDist = path.dirname(require.resolve("@project-atlas/core"));
  const grammars = grammarSourcePaths();
  return { assetsDir, wasmDir: await collectWasm(assetsDir, grammars), workerPath: path.join(coreDist, "parse", "worker.js"), mode: "source" };
}

/** The grammars live in several node_modules folders; the parser wants one directory. */
async function collectWasm(base: string, grammars: Record<string, string>): Promise<string> {
  const dir = path.join(base, "wasm");
  await mkdir(dir, { recursive: true });
  for (const [name, source] of Object.entries(grammars)) await writeFile(path.join(dir, name), await readFile(source));
  return dir;
}

async function unpack(sea: SeaApi, dir: string): Promise<Assets> {
  await mkdir(path.join(dir, "wasm"), { recursive: true });
  for (const name of EMBEDDED) {
    const data = Buffer.from(sea.getAsset(name));
    const target = name.endsWith(".wasm") ? path.join(dir, "wasm", name) : path.join(dir, name);
    const expected = createHash("sha256").update(data).digest("hex");
    const current = await readFile(target).then((b) => createHash("sha256").update(b).digest("hex"), () => undefined);
    if (current === expected) continue;
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, target);
  }
  return { assetsDir: dir, wasmDir: path.join(dir, "wasm"), workerPath: path.join(dir, "worker.js"), mode: "sea" };
}
