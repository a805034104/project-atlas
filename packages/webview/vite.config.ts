import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Production build: ONE classic script (dist/webview.js) + ONE stylesheet
 * (dist/webview.css), fixed names, no code splitting, so the extension host can
 * reference them as fixed webview URIs under a nonce-based CSP.
 *
 * The ELK layout worker source is inlined as a string (?raw) and started from a
 * blob: URL at runtime, because VS Code webviews cannot construct a Worker from
 * a vscode-resource URL (cross-origin). The host CSP therefore needs
 * `worker-src blob:`.
 *
 * `npm run dev` serves index.dev.html with the RuoYi mock host (src/dev).
 */
export default defineConfig({
  plugins: [react()],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    cssCodeSplit: false,
    lib: {
      entry: "src/main.tsx",
      name: "ProjectAtlasWebview",
      formats: ["iife"],
      fileName: () => "webview.js",
      cssFileName: "webview",
    },
  },
});
