import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Aggregator, spanKey, statsQuantile } from "../../src/runtime/aggregate.js";
import { decodeTraceRequest } from "../../src/runtime/otlp-decode.js";
import { normalizeClassName, sqlSummary, toSpanRecords, type SpanRecord } from "../../src/runtime/span-record.js";
import { TraceStore } from "../../src/runtime/store.js";

const GOLDEN = path.resolve(__dirname, "../../../../fixtures/runtime/ruoyi-vue-2.31.1/raw");

/** All spans S0 captured from a real RuoYi-Vue run with agent 2.31.1. */
function goldenRecords(): SpanRecord[] {
  return readdirSync(GOLDEN)
    .filter((f) => f.endsWith(".pb"))
    .sort()
    .flatMap((f) => toSpanRecords(decodeTraceRequest(readFileSync(path.join(GOLDEN, f)))));
}

function record(over: Partial<SpanRecord> & { t?: string; s: string }): SpanRecord {
  return { t: "a".repeat(32), svc: "app", scope: "test", name: over.s, kind: "internal", start: 1000, dur: 10, err: false, a: {}, ...over };
}

describe("SpanRecord normalisation (golden S0 payloads)", () => {
  const records = goldenRecords();

  it("decodes every captured span with whitelisted attributes only", () => {
    expect(records).toHaveLength(124);
    expect(new Set(records.map((r) => r.svc))).toEqual(new Set(["ruoyi-admin"]));
    const text = JSON.stringify(records);
    // never persisted: SQL text, redis keys, connection strings, users, hosts, command lines
    for (const forbidden of ["select u.user_id", "count(?)", "login_tokens", "mysql://", "db.user", "root", "command_line", "host.name"]) expect(text).not.toContain(forbidden);
  });

  it("maps the GET /system/user/list trace onto method, route and db keys", () => {
    const server = records.find((r) => r.kind === "server" && r.a.route === "/system/user/list");
    expect(server).toBeDefined();
    const trace = records.filter((r) => r.t === server?.t);
    expect(trace.map(spanKey).sort()).toEqual(
      expect.arrayContaining([
        "r:ruoyi-admin:GET /system/user/list",
        "m:com.ruoyi.web.controller.system.SysUserController#list",
        "m:com.ruoyi.system.service.impl.SysUserServiceImpl#selectUserList",
        "m:com.ruoyi.framework.aspectj.DataScopeAspect#doBefore",
        "m:com.ruoyi.framework.interceptor.RepeatSubmitInterceptor#preHandle",
        "m:com.ruoyi.framework.security.filter.JwtAuthenticationTokenFilter#doFilterInternal",
        "d:ruoyi-admin:SELECT sys_user",
      ]),
    );
    const jdbc = trace.filter((r) => r.a.dbSystem === "mysql");
    expect(jdbc.every((r) => r.name === "SELECT sys_user")).toBe(true);
    expect(trace.find((r) => r.a.dbSystem === "redis")?.name).toBe("GET");
  });

  it("aggregates parent→child edges in either arrival order and flags the async log INSERT", () => {
    const forward = new Aggregator();
    forward.add(records);
    const reversed = new Aggregator();
    reversed.add([...records].reverse());
    expect(Object.keys(reversed.state.edges).sort()).toEqual(Object.keys(forward.state.edges).sort());
    const edges = forward.state.edges;
    expect(edges["m:com.ruoyi.web.controller.system.SysUserController#list>m:com.ruoyi.system.service.impl.SysUserServiceImpl#selectUserList"]?.count).toBeGreaterThan(0);
    expect(edges["m:com.ruoyi.system.service.impl.SysUserServiceImpl#selectUserList>d:ruoyi-admin:SELECT sys_user"]?.count).toBeGreaterThanOrEqual(2);
    const asyncEdges = Object.entries(edges).filter(([, e]) => e.async).map(([k]) => k);
    expect(asyncEdges.some((k) => /LogAspect.*>.*INSERT sys_oper_log/.test(k))).toBe(true);
    // the redis call runs on a lettuce event-loop thread but inside the request: not async (ends before parent)
    expect(forward.state.traces[0]?.root?.key).toMatch(/^r:ruoyi-admin:/);
  });

  it("deduplicates exporter retries", () => {
    const agg = new Aggregator();
    agg.add(records);
    expect(agg.add(records.slice(0, 10))).toHaveLength(0);
    expect(agg.state.duplicates).toBe(10);
    expect(agg.state.total).toBe(124);
  });
});

describe("normalisation helpers", () => {
  it("strips Spring proxy suffixes and drops JDK proxies", () => {
    expect(normalizeClassName("com.x.UserService$$EnhancerBySpringCGLIB$$1a2b")).toBe("com.x.UserService");
    expect(normalizeClassName("com.x.UserService$$SpringCGLIB$$0")).toBe("com.x.UserService");
    expect(normalizeClassName("jdk.proxy2.$Proxy123")).toBeUndefined();
  });

  it("summarises SQL without keeping it", () => {
    expect(sqlSummary("/* c */ select * from `sys_user` u where id = ?")).toEqual({ op: "SELECT", table: "sys_user" });
    expect(sqlSummary("INSERT INTO sys_oper_log(a) values (?)")).toEqual({ op: "INSERT", table: "sys_oper_log" });
    expect(sqlSummary("update sys_role set x=?")).toEqual({ op: "UPDATE", table: "sys_role" });
  });

  it("drops whole batches from build-tool JVMs (Maven/Gradle inheriting JAVA_TOOL_OPTIONS)", () => {
    const span = { traceId: "a".repeat(32), spanId: "b".repeat(16), name: "x", kind: 1, startTimeUnixNano: 0n, endTimeUnixNano: 1n, attributes: {}, events: [], statusCode: 0 };
    const batch = (cmd: string) => [{ resource: { "service.name": "app", "process.command_line": cmd }, scopeSpans: [{ scope: { name: "s" }, spans: [span] }] }];
    expect(toSpanRecords(batch("java -classpath boot/plexus-classworlds.jar org.codehaus.plexus.classworlds.launcher.Launcher spring-boot:run"))).toHaveLength(0);
    expect(toSpanRecords(batch("java -javaagent:x.jar -jar app.jar"))).toHaveLength(1);
  });

  it("keeps quantiles within the sketch's relative error", () => {
    const agg = new Aggregator();
    agg.add(Array.from({ length: 1000 }, (_, i) => record({ s: `s${i}`.padStart(16, "0"), dur: i + 1, a: { cls: "C", fn: "m" } })));
    const stats = agg.state.nodes["m:C#m"];
    expect(statsQuantile(stats, 0.5)).toBeGreaterThan(500 * 0.95);
    expect(statsQuantile(stats, 0.5)).toBeLessThan(500 * 1.05);
    expect(statsQuantile(stats, 0.95)).toBeGreaterThan(950 * 0.95);
    expect(statsQuantile(stats, 0.95)).toBeLessThan(950 * 1.05);
  });
});

describe("TraceStore", () => {
  it("rotates segments, enforces the span cap and keeps aggregates after eviction", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "atlas-traces-"));
    let now = 1_000;
    const store = new TraceStore(dir, { maxSpans: 25, segmentSpans: 10, now: () => now++ });
    const agg = new Aggregator();
    for (let batch = 0; batch < 5; batch++) {
      const recs = Array.from({ length: 10 }, (_, i) => record({ t: String(batch).repeat(32).slice(0, 32), s: `${batch}${i}`.padStart(16, "0"), a: { cls: "C", fn: "m" } }));
      agg.add(recs);
      await store.append(recs);
    }
    expect(await store.count()).toBeLessThanOrEqual(30);
    expect(await store.count()).toBeGreaterThanOrEqual(20);
    const segments = (await readdir(dir)).filter((f) => f.startsWith("spans-"));
    expect(segments.length).toBeLessThanOrEqual(3);
    await store.saveAggregates(agg.state);
    const reloaded = await new TraceStore(dir).loadAggregates();
    expect(reloaded.nodes["m:C#m"]?.count).toBe(50); // statistics outlive raw-span eviction
  });

  it("skips a torn last line", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "atlas-traces-"));
    const ok = record({ s: "1".padStart(16, "0") });
    await writeFile(path.join(dir, "spans-1.jsonl"), `${JSON.stringify(ok)}\n{"t":"trunc`);
    const out: SpanRecord[] = [];
    for await (const r of new TraceStore(dir).records()) out.push(r);
    expect(out).toEqual([ok]);
  });

  it("appends after a torn last line without losing the new record", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "atlas-traces-"));
    await writeFile(path.join(dir, "spans-1.jsonl"), '{"t":"trunc');
    const fresh = record({ s: "f".repeat(16) });
    await new TraceStore(dir).append([fresh]);
    const out: SpanRecord[] = [];
    for await (const r of new TraceStore(dir).records()) out.push(r);
    expect(out).toEqual([fresh]);
  });

  it("a second store on the same directory sees rotated segments and clears them all", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "atlas-traces-"));
    let now = 1;
    const writer = new TraceStore(dir, { segmentSpans: 2, now: () => now++ });
    const reader = new TraceStore(dir);
    await writer.append([record({ s: "1".repeat(16) }), record({ s: "2".repeat(16) })]);
    for await (const _ of reader.records()) void _;
    await writer.append([record({ s: "3".repeat(16) })]);
    const ids: string[] = [];
    for await (const r of reader.records()) ids.push(r.s);
    expect(ids).toContain("3".repeat(16));
    await reader.clear();
    expect((await readdir(dir)).filter((f) => f.startsWith("spans-"))).toEqual([]);
  });
});

describe("Aggregator.reset", () => {
  it("forgets cleared traces so they do not reappear on the next batch", () => {
    const agg = new Aggregator();
    agg.add([record({ t: "a".repeat(32), s: "1".repeat(16) })]);
    agg.reset();
    agg.add([record({ t: "b".repeat(32), s: "2".repeat(16) })]);
    expect(agg.state.traces.map((t) => t.t)).toEqual(["b".repeat(32)]);
    expect(agg.state.total).toBe(1);
  });
});
