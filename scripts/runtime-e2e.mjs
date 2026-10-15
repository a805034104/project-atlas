// E1 / AC#19 — real end-to-end runtime capture through the CLI:
//   MySQL + Redis ─▶ project-atlas trace --json -- java -jar ruoyi-admin.jar
//   ─▶ GET /captchaImage, POST /login, GET /system/user/list, GET /system/role/list
//   ─▶ stop the JVM ─▶ the CLI prints its JSON summary ─▶ assertions
//
//   node scripts/runtime-e2e.mjs
// Env: RUOYI_JAR (default E:/tools/ruoyi-vue-build/ruoyi-admin/target/ruoyi-admin.jar),
//      RUOYI_WS (workspace analyzed by Atlas, default fixtures/repos/ruoyi-vue),
//      START_DEPS (default scripts/spike/start-deps.sh; MySQL 3306 + Redis 6379 with ry-vue, captcha off).
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jar = path.resolve(process.env.RUOYI_JAR ?? "E:/tools/ruoyi-vue-build/ruoyi-admin/target/ruoyi-admin.jar");
const ws = path.resolve(repo, process.env.RUOYI_WS ?? "fixtures/repos/ruoyi-vue");
const startDeps = path.resolve(repo, process.env.START_DEPS ?? "scripts/spike/start-deps.sh");
const BASE = "http://127.0.0.1:8080";

function check(ok, message) {
  if (!ok) throw new Error(`runtime E2E failed: ${message}`);
  console.log(`  ✓ ${message}`);
}

async function until(fn, ms, label) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      if (await fn()) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting for ${label}`);
}

function javaPidOn(port) {
  if (process.platform !== "win32") return execFileSync("sh", ["-c", `lsof -ti tcp:${port} -sTCP:LISTEN`]).toString().trim().split("\n")[0];
  const out = execFileSync("netstat", ["-ano", "-p", "TCP"]).toString();
  const line = out.split(/\r?\n/).find((l) => new RegExp(`:${port}\\s.*LISTENING`).test(l));
  return line?.trim().split(/\s+/).pop();
}

if (!existsSync(jar)) {
  console.log(`runtime E2E skipped: ${jar} not built (see docs/s0-spike.md)`);
  process.exit(0);
}
execFileSync("bash", [startDeps], { stdio: "inherit" });

const started = Date.now();
const cli = spawn(process.execPath, [path.join(repo, "packages/cli/dist/bin.js"), "trace", "--dir", ws, "--json", "--", "java", "-jar", jar], {
  cwd: path.dirname(path.dirname(jar)),
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
cli.stdout.on("data", (d) => (stdout += d));
cli.stderr.on("data", (d) => {
  stderr += d;
  if (/^atlas:/m.test(String(d))) process.stderr.write(String(d).split("\n").filter((l) => l.startsWith("atlas:")).map((l) => `    ${l}\n`).join(""));
});
const exited = new Promise((resolve) => cli.on("exit", resolve));

try {
  await until(async () => (await fetch(`${BASE}/captchaImage`)).ok, 180_000, "RuoYi on :8080");
  const bootMs = Date.now() - started;
  check(true, `RuoYi started with the agent via project-atlas trace (${Math.round(bootMs / 1000)} s incl. analysis)`);
  const login = await (await fetch(`${BASE}/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin123" }) })).json();
  check(typeof login.token === "string", "logged in (captcha disabled)");
  const auth = { authorization: `Bearer ${login.token}` };
  const requested = Date.now();
  check((await fetch(`${BASE}/system/user/list?pageNum=1&pageSize=10`, { headers: auth })).ok, "GET /system/user/list");
  check((await fetch(`${BASE}/system/role/list`, { headers: auth })).ok, "GET /system/role/list");
  await new Promise((r) => setTimeout(r, 2500)); // batch export delay is 500 ms
  const pid = javaPidOn(8080);
  check(!!pid, `found the RuoYi JVM (pid ${pid})`);
  if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(pid), "/F"]);
  else process.kill(Number(pid), "SIGTERM");
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("CLI did not exit")), 30_000))]);

  const summary = JSON.parse(stdout);
  const userList = summary.entrypoints.find((e) => e.label === "GET /system/user/list");
  check(!!userList, `GET /system/user/list observed (${userList?.count}×, p95 ${userList?.p95Ms} ms)`);
  check(userList.coverage && userList.coverage.observed === userList.coverage.instrumentable, `AC#19: ${userList.coverage.observed}/${userList.coverage.instrumentable} instrumentable steps observed (filters, interceptor, aspect, controller, service, mapper, SQL)`);
  check(summary.entrypoints.some((e) => e.label === "GET /system/role/list"), "GET /system/role/list observed");
  check(!summary.runtimeEdges.some((e) => e.to === "SysUserServiceImpl.selectUserByUserName"), "no guessed edge through Spring Security (login → selectUserByUserName stays reachable-only)");
  check(Date.now() - requested < 60_000, "observations reported promptly");
  console.log(`runtime E2E passed (${summary.spans} spans)`);
} catch (error) {
  console.error(stderr.split("\n").slice(-30).join("\n"));
  throw error;
} finally {
  const pid = (() => {
    try {
      return javaPidOn(8080);
    } catch {
      return undefined;
    }
  })();
  if (pid) {
    try {
      if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(pid), "/F"]);
      else process.kill(Number(pid));
    } catch {
      // already gone
    }
  }
  cli.kill();
}
