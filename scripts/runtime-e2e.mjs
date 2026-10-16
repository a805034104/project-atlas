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
import { fileURLToPath, pathToFileURL } from "node:url";

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

function traceCli(args, cwd) {
  const child = spawn(process.execPath, [path.join(repo, "packages/cli/dist/bin.js"), "trace", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  const out = { stdout: "", stderr: "" };
  child.stdout.on("data", (d) => (out.stdout += d));
  child.stderr.on("data", (d) => (out.stderr += d));
  out.exited = new Promise((resolve) => child.on("exit", resolve));
  out.child = child;
  return out;
}

function killPort(port) {
  const pid = (() => {
    try {
      return javaPidOn(port);
    } catch {
      return undefined;
    }
  })();
  if (!pid) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(pid), "/F"]);
    else process.kill(Number(pid));
  } catch {
    // gone
  }
}

/**
 * AC#22 — two services linked by a message channel; the consumer starts through CLI process A
 * (owns the receiver), the producer through CLI process B (reuses A's receiver, V8);
 * POST /orders/{id} three times; the static link must be confirmed at runtime.
 *   redis-stream: no trace context crosses the stream → confirmed from XADD + XREAD on one key
 *   kafka:        context propagates → one trace spans producer and consumer as well
 */
async function channelScenario({ fixture, label, channel, producerPort, consumerPort, sameTrace }) {
  const synth = path.join(repo, "fixtures/synthetic", fixture);
  const consumerJar = path.join(synth, "order-consumer/target/order-consumer-1.0.0.jar");
  const producerJar = path.join(synth, "order-producer/target/order-producer-1.0.0.jar");
  if (!existsSync(consumerJar) || !existsSync(producerJar)) {
    console.log(`${label} scenario skipped: build fixtures/synthetic/${fixture} with \`mvn -q -DskipTests package\``);
    return;
  }
  console.log(`${label} scenario (AC#22):`);
  const { rmSync } = await import("node:fs");
  rmSync(path.join(synth, ".atlas", "traces"), { recursive: true, force: true });
  const a = traceCli(["--dir", synth, "--service", "order-consumer", "--json", "--", "java", "-jar", consumerJar], synth);
  await until(() => existsSync(path.join(synth, ".atlas", "receiver.json")), 120_000, "receiver of CLI A");
  const b = traceCli(["--dir", synth, "--service", "order-producer", "--", "java", "-jar", producerJar], synth);
  try {
    await until(async () => (await fetch(`http://127.0.0.1:${consumerPort}/`)).status > 0, 120_000, `consumer on :${consumerPort}`);
    await until(async () => (await fetch(`http://127.0.0.1:${producerPort}/`)).status > 0, 120_000, `producer on :${producerPort}`);
    check(/using the receiver of pid/.test(b.stderr), "second CLI reused the first one's receiver (V8)");
    for (const id of ["1", "2", "3"]) check((await fetch(`http://127.0.0.1:${producerPort}/orders/${id}`, { method: "POST" })).ok, `POST /orders/${id}`);
    // A Kafka consumer joins its group only after the previous (killed) member's session times out:
    // wait for the handler's own output rather than a fixed delay.
    if (sameTrace) await until(() => /handled order 3/.test(a.stderr), 90_000, "the consumer to handle the orders");
    await new Promise((r) => setTimeout(r, 4000));
  } finally {
    killPort(producerPort);
    killPort(consumerPort);
  }
  await Promise.race([Promise.all([a.exited, b.exited]), new Promise((_, reject) => setTimeout(() => reject(new Error("CLIs did not exit")), 30_000))]);
  const core = await import(pathToFileURL(path.join(repo, "packages/core/dist/index.js")).href);
  const stored = await core.loadStoredGraph(path.join(synth, ".atlas"));
  const aggregates = await new core.TraceStore(path.join(synth, ".atlas", "traces")).loadAggregates();
  const overlay = core.reconcile(stored.graph, aggregates);
  const link = stored.graph.serviceLinks.find((l) => l.channel === channel);
  check(!!link, `static link order-producer → order-consumer over ${channel}`);
  check(!!overlay.links[link.id], `AC#22: link confirmed at runtime (${overlay.links[link.id]?.count ?? 0} consumer-side observations)`);
  const create = stored.graph.entrypoints.find((e) => e.method === "POST" && e.path === "/orders/{}");
  check(overlay.entrypoints[create.id]?.count === 3, "POST /orders/{id} observed 3×");
  if (sameTrace) {
    const spanning = aggregates.traces.filter((t) => t.services.includes("order-producer") && t.services.includes("order-consumer"));
    check(spanning.length >= 3, `trace context crossed the topic: ${spanning.length} traces span producer and consumer`);
    const consumerEp = stored.graph.entrypoints.find((e) => e.kind === "mq-consumer");
    const handler = stored.graph.steps.find((s) => s.symbol.name === "OrderHandler.handle");
    check(!!overlay.steps[handler?.id ?? ""], `consumer handler ${consumerEp?.method} ${consumerEp?.path} → OrderHandler.handle observed`);
  }
  const summary = JSON.parse(a.stdout);
  check(summary.spans > 0, `consumer-side CLI summary (${summary.spans} spans across both services)`);
}

const redisStreamScenario = () => channelScenario({ fixture: "redis-stream", label: "Redis stream", channel: "redis-stream:stream:orders", producerPort: 18081, consumerPort: 18082, sameTrace: false });
async function kafkaScenario() {
  try {
    execFileSync("bash", [path.join(repo, "scripts/spike/start-kafka.sh")], { stdio: "inherit" });
  } catch {
    console.log("Kafka scenario skipped: no broker (scripts/spike/start-kafka.sh)");
    return;
  }
  await channelScenario({ fixture: "kafka", label: "Kafka", channel: "kafka:order-created", producerPort: 18091, consumerPort: 18092, sameTrace: true });
}

/**
 * AC#23 — calls the static analysis cannot see, on a real JVM (no external services):
 *   GET /jobs/reportJob/run  JobService.runByName ⇢(reflection)⇢ ReportJob.execute   other class: reachable only
 *   GET /jobs/local          JobService.runLocal  ⇢(reflection)⇢ JobService.audit    same class: runtime-observed edge
 */
async function reflectionScenario() {
  const synth = path.join(repo, "fixtures/synthetic/reflection");
  const appJar = path.join(synth, "target/reflect-demo-1.0.0.jar");
  if (!existsSync(appJar)) {
    console.log("reflection scenario skipped: build fixtures/synthetic/reflection with `mvn -q -DskipTests package`");
    return;
  }
  console.log("reflection scenario (AC#23):");
  const { rmSync } = await import("node:fs");
  rmSync(path.join(synth, ".atlas", "traces"), { recursive: true, force: true });
  const port = 18101;
  const t = traceCli(["--dir", synth, "--json", "--", "java", "-jar", appJar], synth);
  try {
    await until(async () => (await fetch(`http://127.0.0.1:${port}/report`)).ok, 120_000, `reflect-demo on :${port}`);
    for (let i = 0; i < 2; i++) {
      check((await (await fetch(`http://127.0.0.1:${port}/jobs/reportJob/run`)).text()) === "report done", "GET /jobs/reportJob/run (reflection into another bean)");
      check((await (await fetch(`http://127.0.0.1:${port}/jobs/local`)).text()) === "audited", "GET /jobs/local (reflection inside JobService)");
    }
    await new Promise((r) => setTimeout(r, 2500));
  } finally {
    killPort(port);
  }
  await Promise.race([t.exited, new Promise((_, reject) => setTimeout(() => reject(new Error("CLI did not exit")), 30_000))]);
  const core = await import(pathToFileURL(path.join(repo, "packages/core/dist/index.js")).href);
  const { graph } = await core.loadStoredGraph(path.join(synth, ".atlas"));
  const overlay = core.reconcile(graph, await new core.TraceStore(path.join(synth, ".atlas", "traces")).loadAggregates());
  const step = (name) => graph.steps.find((s) => s.symbol.name === name);
  const [runByName, execute, runLocal, audit] = ["JobService.runByName", "ReportJob.execute", "JobService.runLocal", "JobService.audit"].map(step);
  check(!graph.edges.some((e) => e.from === runByName.id && e.to === execute.id), "static graph: no edge runByName → ReportJob.execute");
  check(!!overlay.steps[execute.id], `ReportJob.execute observed (${overlay.steps[execute.id]?.count ?? 0}×)`);
  check(overlay.reachability.some((r) => r.from === runByName.id && r.to === execute.id), "AC#23: runByName ⇢ ReportJob.execute listed as runtime-only reachability");
  check(!overlay.runtimeEdges.some((e) => e.to === execute.id), "AC#23: no guessed edge into ReportJob.execute (another class, frames may sit in between)");
  const local = overlay.runtimeEdges.find((e) => e.from === runLocal.id && e.to === audit.id);
  check(!!local && !local.async, `AC#23: same-class runLocal → audit drawn as runtime-observed edge (${local?.observed.count ?? 0}×)`);
  const summary = JSON.parse(t.stdout);
  check(summary.spans > 0, `CLI summary (${summary.spans} spans)`);
}

/** RabbitMQ (a broker on 127.0.0.1:5672: local install, or the service container in CI). */
async function rabbitScenario() {
  const { createConnection } = await import("node:net");
  const up = await new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port: 5672 }, () => (socket.end(), resolve(true)));
    socket.on("error", () => resolve(false));
  });
  if (!up) {
    if (process.env.RABBITMQ_REQUIRED) throw new Error("runtime E2E failed: no RabbitMQ broker on 127.0.0.1:5672");
    console.log("RabbitMQ scenario skipped: no broker on 127.0.0.1:5672");
    return;
  }
  // The agent reports the exchange (publish) and the routing key (Spring listener), never the queue.
  await channelScenario({ fixture: "rabbitmq", label: "RabbitMQ", channel: "rabbitmq:order.q", producerPort: 18111, consumerPort: 18112, sameTrace: true });
}

if (process.argv.includes("--reflection-only")) {
  await reflectionScenario();
  process.exit(0);
}
if (process.argv.includes("--rabbitmq-only")) {
  await rabbitScenario();
  process.exit(0);
}
if (!existsSync(jar)) {
  console.log(`runtime E2E skipped: ${jar} not built (see docs/s0-spike.md)`);
  process.exit(0);
}
execFileSync("bash", [startDeps], { stdio: "inherit" });
if (process.argv.includes("--channels-only")) {
  await redisStreamScenario();
  await kafkaScenario();
  await rabbitScenario();
  process.exit(0);
}

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
  console.log(`RuoYi scenario passed (${summary.spans} spans)`);
  await reflectionScenario();
  await redisStreamScenario();
  await kafkaScenario();
  await rabbitScenario();
  console.log("runtime E2E passed");
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
