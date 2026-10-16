// Single-file build of the web app (Node SEA): one executable per OS, no Node.js needed.
//
//   esbuild: src/sea-entry.ts ─▶ sea/main.cjs   core parse worker ─▶ sea/worker.cjs (.cjs: a "type": "module" package.json above the data folder must not matter)
//   assets: webview bundle, web theme, favicon, tree-sitter wasm (unpacked to ~/.project-atlas/app/<version>
//           on first launch, sha256-checked: the worker and wasm need real files)
//   node --experimental-sea-config ─▶ blob ─▶ copy of this node binary ─▶ postject
//   macOS: drop the signature before injection, ad-hoc sign after (or the kernel kills it)
//
//   node packages/web/build-sea.mjs [--out <dir>]     (run `npm run build` first)
//   → <out>/project-atlas-<platform>-<arch>[.exe] and a .sha256 file next to it
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const outArg = process.argv.indexOf("--out");
const out = path.resolve(outArg > 0 ? process.argv[outArg + 1] : path.join(repo, "dist-release"));
const work = path.join(here, "sea");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(out, { recursive: true });

const version = JSON.parse(readFileSync(path.join(here, "package.json"), "utf8")).version;
const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  minify: true,
  logLevel: "warning",
  // CJS has no import.meta: web-tree-sitter and core read it at load time.
  banner: { js: 'const __atlasImportMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
  define: { "import.meta.url": "__atlasImportMetaUrl", "process.env.ATLAS_SEA": '"1"' },
};
await build({ ...common, entryPoints: [path.join(here, "src", "sea-entry.ts")], outfile: path.join(work, "main.cjs") });
await build({ ...common, entryPoints: [path.join(repo, "packages", "core", "src", "parse", "worker.ts")], outfile: path.join(work, "worker.cjs") });

const require = createRequire(path.join(repo, "packages", "core", "package.json"));
const pkgDir = (name) => path.dirname(require.resolve(`${name}/package.json`));
const assets = {
  "webview.js": path.join(repo, "packages", "webview", "dist", "webview.js"),
  "webview.css": path.join(repo, "packages", "webview", "dist", "webview.css"),
  "web-theme.css": path.join(here, "static", "web-theme.css"),
  "favicon.svg": path.join(here, "static", "favicon.svg"),
  "worker.cjs": path.join(work, "worker.cjs"),
  "web-tree-sitter.wasm": require.resolve("web-tree-sitter/web-tree-sitter.wasm"),
  "tree-sitter-java.wasm": path.join(pkgDir("tree-sitter-java"), "tree-sitter-java.wasm"),
  "tree-sitter-javascript.wasm": path.join(pkgDir("tree-sitter-javascript"), "tree-sitter-javascript.wasm"),
  "tree-sitter-typescript.wasm": path.join(pkgDir("tree-sitter-typescript"), "tree-sitter-typescript.wasm"),
  "tree-sitter-tsx.wasm": path.join(pkgDir("tree-sitter-typescript"), "tree-sitter-tsx.wasm"),
};
for (const [name, file] of Object.entries(assets)) if (!existsSync(file)) throw new Error(`missing ${name}: ${file} (run \`npm run build\` first)`);

const config = path.join(work, "sea-config.json");
const blob = path.join(work, "sea-prep.blob");
writeFileSync(config, JSON.stringify({ main: path.join(work, "main.cjs"), output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, assets }, null, 2));
execFileSync(process.execPath, ["--experimental-sea-config", config], { stdio: "inherit" });

const platform = process.platform === "win32" ? "win" : process.platform === "darwin" ? "macos" : process.platform;
const exe = path.join(out, `project-atlas-${platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`);
rmSync(exe, { force: true });
copyFileSync(process.execPath, exe);
if (process.platform === "darwin") execFileSync("codesign", ["--remove-signature", exe], { stdio: "inherit" });
const postject = path.join(path.dirname(createRequire(import.meta.url).resolve("postject/package.json")), "dist", "cli.js");
execFileSync(process.execPath, [postject, exe, "NODE_SEA_BLOB", blob, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2", ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : [])], { stdio: "inherit" });
if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", exe], { stdio: "inherit" });

const sha = createHash("sha256").update(readFileSync(exe)).digest("hex");
writeFileSync(`${exe}.sha256`, `${sha}  ${path.basename(exe)}\n`);
console.log(`built ${exe} (${version}, ${(readFileSync(exe).length / 1e6).toFixed(1)} MB, sha256 ${sha})`);
