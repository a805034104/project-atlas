// U1 gate — the v0.2 state-matrix rows of the webview in the four VS Code theme kinds
// (Dark Modern, Light Modern, Dark High Contrast, Light High Contrast), from the dev harness
// (packages/webview: mock host + emulated theme variables) in headless Chrome / Edge.
//
//   node scripts/theme-shots.mjs [outDir]      (default docs/screenshots/v0.3)
// Env: CHROME (path to chrome.exe / msedge.exe / chromium).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.resolve(repo, process.argv[2] ?? "docs/screenshots/v0.3");
const PORT = 5199;
const browsers = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);
const browser = browsers.find((b) => existsSync(b));
if (!browser) {
  console.log("theme shots skipped: no Chrome / Edge found (set CHROME)");
  process.exit(0);
}

const THEMES = ["dark", "light", "hc-dark", "hc-light"];
const EP = encodeURIComponent("ep:GET /system/user/list");
/** [file, title, query] — one row of the state matrix each. */
const SCENES = [
  ["flow-observed", "Flow: aggregated runtime overlay (count · p95, runtime-observed edge, error label)", `tab=flow&node=${EP}&observed=1`],
  ["trace-receiving", "Trace: receiving, list + waterfall, dropped count (partial)", "tab=trace&runtime=receiving"],
  ["trace-off", "Trace: never started (empty, primary actions)", "tab=trace&runtime=off"],
  ["trace-waiting", "Trace: waiting for the first request (loading)", "tab=trace&runtime=waiting"],
  ["trace-downloading", "Trace: downloading the agent (loading, MB and source)", "tab=trace&runtime=downloading"],
  ["trace-error", "Trace: receiver failed (error)", "tab=trace&runtime=error"],
  ["trace-history", "Trace: application exited, statistics kept (stale)", "tab=trace&runtime=history"],
  ["trace-restricted", "Trace: Restricted Mode (untrusted workspace)", "tab=trace&runtime=restricted"],
];

async function until(fn, ms, label) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      if (await fn()) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timeout waiting for ${label}`);
}

const webview = path.join(repo, "packages/webview");
const vite = spawn(process.execPath, [path.join(repo, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], { cwd: webview, stdio: "ignore" });
try {
  await until(async () => (await fetch(`http://127.0.0.1:${PORT}/index.dev.html`)).ok, 60_000, "vite dev server");
  mkdirSync(out, { recursive: true });
  const rows = [];
  for (const [file, title, query] of SCENES.filter(([f]) => !process.env.ONLY || f === process.env.ONLY)) {
    const cells = [];
    for (const theme of THEMES) {
      const png = path.join(out, `${file}.${theme}.png`);
      const url = `http://127.0.0.1:${PORT}/index.dev.html?bare=1&status=done&locale=zh-cn&theme=${theme}&${query}`;
      execFileSync(browser, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--window-size=1440,900", "--virtual-time-budget=20000", `--screenshot=${png}`, url], { stdio: "ignore", timeout: 60_000 });
      if (!existsSync(png) || statSync(png).size < 5_000) throw new Error(`no screenshot for ${file} / ${theme}`);
      cells.push(`<td><a href="${file}.${theme}.png"><img src="${file}.${theme}.png" alt="${file} ${theme}" width="360"></a></td>`);
      console.log(`  ✓ ${file}.${theme}.png (${Math.round(statSync(png).size / 1024)} KB)`);
    }
    rows.push(`<tr><th>${title}</th>${cells.join("")}</tr>`);
  }
  writeFileSync(
    path.join(out, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>ProjectAtlas v0.2 · theme matrix</title>
<style>body{font:13px system-ui;margin:16px}th{text-align:left;vertical-align:top;max-width:220px;padding:6px}td{padding:4px}img{border:1px solid #888}</style>
<table><tr><th></th>${THEMES.map((t) => `<th>${t}</th>`).join("")}</tr>${rows.join("\n")}</table>\n`,
  );
  console.log(`theme shots: ${SCENES.length} scenes × ${THEMES.length} themes → ${path.relative(repo, out)}`);
} finally {
  vite.kill();
}
