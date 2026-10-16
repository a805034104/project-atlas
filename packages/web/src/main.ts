import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atlasHome, createParsePool } from "@project-atlas/core";
import { resolveAssets } from "./assets.js";
import { acquireInstanceLock, findLiveInstance } from "./instance.js";
import { openBrowser } from "./open-browser.js";
import { ProjectRegistry } from "./projects.js";
import { startServer } from "./server.js";
import { SettingsStore } from "./store.js";
import { VERSION } from "./version.js";

/**
 * `project-atlas` (single-file build) / `project-atlas serve` / `node packages/web/dist/main.js`
 *
 *   another instance alive? ─▶ open the browser there (fresh one-time code) ─▶ exit
 *   else: lock ─▶ assets ─▶ settings + projects ─▶ 127.0.0.1:<port> ─▶ web.json ─▶ browser
 *   exits on Ctrl-C / closing the console window, or after 30 idle minutes with no page open
 *   and nothing in flight.
 */

export interface MainOptions {
  port?: number;
  open?: boolean;
  home?: string;
  /** Print parse-pool facts and exit (packaged-build smoke test). */
  selfTest?: boolean;
  here?: string;
  log?: (line: string) => void;
}

const IDLE_EXIT_MS = 30 * 60_000;

export function parseArgs(argv: readonly string[]): MainOptions {
  const options: MainOptions = { open: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-open") options.open = false;
    else if (arg === "--self-test") options.selfTest = true;
    else if (arg === "--port") options.port = Number(argv[++i]);
    else if (arg === "--home") options.home = argv[++i] as string;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(`ProjectAtlas ${VERSION}\n  project-atlas [--port <n>] [--no-open] [--home <dir>]\n  Opens http://127.0.0.1:<port> in your browser; only this computer can connect.\n`);
      process.exit(0);
    }
  }
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) throw new Error(`invalid --port ${options.port}`);
  return options;
}

export async function main(options: MainOptions): Promise<{ url: string; close(): Promise<void> } | undefined> {
  const home = atlasHome(options.home);
  const logDir = path.join(home, "logs");
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const logFile = path.join(logDir, `web-${new Date().toISOString().slice(0, 10)}.log`);
  const log = options.log ?? ((line: string) => appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`));
  const here = options.here ?? (typeof __filename === "string" ? path.dirname(__filename) : path.dirname(fileURLToPath(import.meta.url)));
  const zh = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith("zh");
  const say = (zhText: string, en: string) => process.stdout.write(`${zh ? zhText : en}\n`);
  // Keys, the unpacked parser worker and the instance secret live in the home: outside the user's
  // own profile, other accounts on the machine may be able to read or replace them.
  const rel = path.relative(path.resolve(homedir()), path.resolve(home));
  if (rel.startsWith("..") || path.isAbsolute(rel)) say(`警告：数据目录 ${home} 不在你的用户目录下，同一台电脑上的其他账号可能读到或替换其中的文件（API key、程序文件）。`, `Warning: the data folder ${home} is outside your user profile; other accounts on this computer may be able to read or replace files in it (API keys, program files).`);

  if (options.selfTest) {
    const assets = await resolveAssets(home, VERSION, here);
    const pool = await createParsePool({ ...(assets.wasmDir ? { wasmDir: assets.wasmDir } : {}), ...(assets.workerPath ? { workerPath: assets.workerPath } : {}) });
    let facts;
    try {
      facts = await pool.parse("java", "package a; @RestController public class C { @GetMapping(\"/x\") public void x() {} }", "C.java");
    } finally {
      await pool.close();
    }
    const result = { version: VERSION, mode: assets.mode, poolSize: pool.size, parsed: Boolean(facts) };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.poolSize > 0 && result.parsed ? 0 : 1;
    return undefined;
  }

  const lock = await acquireInstanceLock(home);
  if (!lock) {
    const live = await findLiveInstance(home);
    if (live) {
      const url = `http://127.0.0.1:${live.info.port}/#code=${live.code}`;
      say(`ProjectAtlas 已在运行：http://127.0.0.1:${live.info.port}`, `ProjectAtlas is already running: http://127.0.0.1:${live.info.port}`);
      if (options.open !== false) openBrowser(url);
      return undefined;
    }
    throw new Error("another ProjectAtlas is starting; try again in a few seconds");
  }

  const assets = await resolveAssets(home, VERSION, here);
  const settings = await SettingsStore.open(options.home, Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith("zh") ? "zh-cn" : "en");
  const registry = await ProjectRegistry.open({ home, settings, assets: { ...(assets.wasmDir ? { wasmDir: assets.wasmDir } : {}), ...(assets.workerPath ? { workerPath: assets.workerPath } : {}) }, log });
  let server;
  try {
    server = await startServer({ registry, settings, assetsDir: assets.assetsDir, version: VERSION, nonce: lock.nonce, dataDir: home, log, port: options.port ?? 0 });
  } catch (error) {
    await lock.release();
    throw error;
  }
  await lock.publish(server.port, server.auth.secret);
  const url = `http://127.0.0.1:${server.port}/#code=${server.auth.issueCode()}`;
  log(`listening on 127.0.0.1:${server.port} (${assets.mode})`);
  say(`ProjectAtlas ${VERSION} 正在运行：http://127.0.0.1:${server.port}`, `ProjectAtlas ${VERSION} is running: http://127.0.0.1:${server.port}`);
  say(`数据目录：${home}`, `Data folder: ${home}`);
  say("关闭此窗口即可退出。", "Close this window to quit.");
  if (options.open === false || !openBrowser(url)) say(`请在浏览器中打开：${url}`, `Open this in your browser: ${url}`);

  let idleSince = Date.now();
  const idle = setInterval(() => {
    if (registry.connected() || registry.busy()) idleSince = Date.now();
    else if (Date.now() - idleSince > IDLE_EXIT_MS) void close().then(() => process.exit(0));
  }, 60_000);
  idle.unref();

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      clearInterval(idle);
      await registry.close();
      await server.close();
      await lock.release();
      log("stopped");
    })());
  return { url, close };
}

/** Start, wire signals, report startup errors (the single-file build and `node dist/main.js`). */
export async function run(argv: readonly string[]): Promise<void> {
  try {
    const running = await main(parseArgs(argv));
    if (!running) return;
    const stop = () => void running.close().then(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    process.on("SIGHUP", stop); // Windows: the console window was closed
  } catch (error) {
    process.stderr.write(`ProjectAtlas: ${(error as Error).message}\n`);
    process.exitCode = 1;
    // Started by double-click: keep the window open long enough to read the message.
    if (process.env["ATLAS_SEA"] === "1" && process.stdin.isTTY) {
      process.stderr.write("Press Enter to close.\n");
      await new Promise<void>((resolve) => {
        process.stdin.once("data", () => resolve());
        setTimeout(resolve, 120_000).unref();
      });
      process.exit(1);
    }
  }
}

// Entry point when run directly with node (the single-file build calls run() from sea-entry.ts).
const isEntry = process.env["ATLAS_SEA"] !== "1" && (typeof require !== "undefined" ? require.main === module : process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isEntry) void run(process.argv.slice(2));
