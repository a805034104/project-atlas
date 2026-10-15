// Bundle the extension host (CJS), the parse worker, the tree-sitter wasm files
// and the prebuilt webview into packages/vscode/dist.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const production = process.argv.includes("--production");
const dist = path.join(here, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(path.join(dist, "wasm"), { recursive: true });

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
  // `import.meta.url` is unused in the bundle (wasmDir/workerPath are passed explicitly).
  define: { "import.meta.url": "undefined" },
};

await build({ ...common, entryPoints: [path.join(here, "src/extension.ts")], outfile: path.join(dist, "extension.js"), external: ["vscode"] });
await build({ ...common, entryPoints: [path.join(here, "../core/src/parse/worker.ts")], outfile: path.join(dist, "worker.js") });

const require = createRequire(path.join(here, "../core/package.json"));
const grammars = {
  "web-tree-sitter.wasm": require.resolve("web-tree-sitter/web-tree-sitter.wasm"),
  "tree-sitter-java.wasm": path.join(path.dirname(require.resolve("tree-sitter-java/package.json")), "tree-sitter-java.wasm"),
  "tree-sitter-javascript.wasm": path.join(path.dirname(require.resolve("tree-sitter-javascript/package.json")), "tree-sitter-javascript.wasm"),
  "tree-sitter-typescript.wasm": path.join(path.dirname(require.resolve("tree-sitter-typescript/package.json")), "tree-sitter-typescript.wasm"),
  "tree-sitter-tsx.wasm": path.join(path.dirname(require.resolve("tree-sitter-typescript/package.json")), "tree-sitter-tsx.wasm"),
};
for (const [name, source] of Object.entries(grammars)) cpSync(source, path.join(dist, "wasm", name));

const webviewDist = path.join(here, "../webview/dist");
if (!existsSync(path.join(webviewDist, "webview.js"))) {
  console.error("packages/webview/dist missing: run `npm run build -w @project-atlas/webview` first");
  process.exit(1);
}
cpSync(webviewDist, path.join(dist, "webview"), { recursive: true });
console.log(`built ${production ? "production" : "dev"} extension into ${dist}`);
