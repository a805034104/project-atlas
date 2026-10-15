import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeWorkspace } from "../../src/analyze.js";
import type { AtlasGraph } from "../../src/model/types.js";
import { buildAgentConfig, formatMethodsInclude, instrumentedMethods } from "../../src/runtime/agent-config.js";
import { Aggregator } from "../../src/runtime/aggregate.js";
import { applyOverlay, reconcile } from "../../src/runtime/match.js";
import { buildTraceData, buildTraceDetail } from "../../src/runtime/trace-view.js";
import { decodeTraceRequest } from "../../src/runtime/otlp-decode.js";
import { toSpanRecords, type SpanRecord } from "../../src/runtime/span-record.js";
import { FIXTURES, haveFixtures } from "../helpers/fixtures.js";
import { analyzeTree, springApp } from "../helpers/synthetic.js";

const GOLDEN = path.resolve(__dirname, "../../../../fixtures/runtime/ruoyi-vue-2.31.1/raw");
const golden = (): SpanRecord[] =>
  readdirSync(GOLDEN)
    .filter((f) => f.endsWith(".pb"))
    .sort()
    .flatMap((f) => toSpanRecords(decodeTraceRequest(readFileSync(path.join(GOLDEN, f)))));

const names = (graph: AtlasGraph, ids: Iterable<string>) => {
  const steps = new Map(graph.steps.map((s) => [s.id, s.symbol.name]));
  return [...ids].map((id) => steps.get(id));
};

describe.skipIf(!haveFixtures(FIXTURES.ruoyiVue))("reconcile — real RuoYi-Vue spans (S0 golden) on the static graph", () => {
  it("observes every instrumentable step of GET /system/user/list (AC#19 offline) and draws no guessed edge", async () => {
    const { graph } = await analyzeWorkspace({ roots: [{ path: FIXTURES.ruoyiVue }], history: false });
    const agg = new Aggregator();
    agg.add(golden());
    const overlay = reconcile(graph, agg.state);
    const g = applyOverlay(graph, overlay);

    const ep = g.entrypoints.find((e) => e.method === "GET" && e.path === "/system/user/list");
    expect(ep?.observed?.count).toBe(1);
    const flow = g.flows.find((f) => f.entrypointId === ep?.id);
    const stepIndex = new Map(g.steps.map((s) => [s.id, s]));
    const flowSteps = (flow?.stepIds ?? []).map((id) => stepIndex.get(id)).filter((s) => s !== undefined);
    const observed = flowSteps.filter((s) => s.observed).map((s) => `${s.layer}:${s.symbol.name}`);
    expect(observed).toEqual(
      expect.arrayContaining([
        "filter:JwtAuthenticationTokenFilter.doFilterInternal",
        "interceptor:RepeatSubmitInterceptor.preHandle",
        "controller:SysUserController.list",
        "aspect:@Before DataScopeAspect.doBefore",
        "service:SysUserServiceImpl.selectUserList",
        "repository:SysUserMapper.selectUserList",
        'sql:<select id="selectUserList">',
      ]),
    );
    expect(overlay.coverage[ep?.id ?? ""]).toEqual({ observed: 9, instrumentable: 9 });
    // controller → @Before aspect → service: every edge on the path is observed
    const controller = flowSteps.find((s) => s.layer === "controller");
    const observedOut = g.edges.filter((e) => e.from === controller?.id && e.observed);
    expect(observedOut.length).toBeGreaterThan(0);

    // Only same-class helpers become runtime-observed edges; login → (Spring Security, unreached
    // UserDetailsService) → selectUserByUserName stays "reachable", never a drawn edge.
    const runtime = g.edges.filter((e) => e.provenance === "runtime-observed");
    expect(names(g, runtime.map((e) => e.from)).every((n, i) => n?.split(".")[0] === names(g, [runtime[i]?.to ?? ""])[0]?.split(".")[0])).toBe(true);
    expect(runtime.some((e) => names(g, [e.to])[0] === "SysUserServiceImpl.selectUserByUserName")).toBe(false);
    expect(overlay.reachability.some((r) => names(g, [r.to])[0] === "SysUserServiceImpl.selectUserByUserName")).toBe(true);
    expect(overlay.unmatched).toEqual([]);

    // the agent configuration covers filters / interceptors / aspects / controllers / services, not data objects or mappers
    const methods = instrumentedMethods(graph);
    expect(methods.get("com.ruoyi.web.controller.system.SysUserController")?.has("list")).toBe(true);
    expect(methods.get("com.ruoyi.framework.aspectj.DataScopeAspect")?.has("doBefore")).toBe(true);
    expect([...methods.keys()].some((c) => /\.domain\.|Mapper$/.test(c))).toBe(false);
    expect(formatMethodsInclude(methods).length).toBeLessThan(20_000);

    // Trace tab data on the same spans: rows map to entrypoints with coverage; waterfall rows to steps.
    const data = buildTraceData(graph, agg.state, overlay, { status: "receiving", spans: agg.state.total, duplicates: 0, rejected: 0, trusted: true });
    const userList = data.traces.find((r) => r.rootName === "GET /system/user/list");
    expect(userList?.entrypointId).toBe(ep?.id);
    expect(userList?.coverage).toEqual({ observed: 9, instrumentable: 9 });
    expect(data.suggestedRequest?.url).toMatch(/^http:\/\/localhost:8080\/captchaImage$/);
    expect(data.diff.runtimeOnly.some((r) => !r.drawn && r.to === "SysUserServiceImpl.selectUserByUserName")).toBe(true);
    const detail = buildTraceDetail(graph, golden().filter((r) => r.t === userList?.traceId));
    const layers = detail?.spans.map((s) => s.layer);
    expect(layers).toEqual(expect.arrayContaining(["entrypoint", "filter", "interceptor", "controller", "aspect", "service", "sql"]));
    const sqlRows = detail?.spans.filter((s) => s.layer === "sql") ?? [];
    expect(sqlRows.length).toBeGreaterThan(0);
    expect(sqlRows.every((s) => s.stepId !== undefined)).toBe(true); // attributed through the mapper / service
  });
});

describe("reconcile — synthetic edge cases", () => {
  const sources = {
    "Repo.java": "@Service public class Repo { public void save() {} }",
    "Helper.java": "@Service public class Helper { @Autowired private Repo repo; public void help() { repo.save(); } }",
    "Svc.java": "@Service public class Svc { @Autowired private Helper helper; public void run() { helper.help(); } public void a(int x) {} public void a(String s) {} private void inner() {} }",
    "Ctl.java": '@RestController public class Ctl { @Autowired private Svc svc; @GetMapping("/x") public void x() { svc.run(); } }',
  };
  let id = 0;
  const span = (t: string, s: string, cls: string, fn: string, p?: string, extra: Partial<SpanRecord> = {}): SpanRecord => ({
    t: t.padEnd(32, "0"),
    s: s.padEnd(16, "0"),
    ...(p ? { p: p.padEnd(16, "0") } : {}),
    svc: "app",
    scope: "io.opentelemetry.methods",
    name: `${cls}.${fn}`,
    kind: "internal",
    start: 1000 + id++,
    dur: 5,
    err: false,
    a: { cls: `app.${cls}`, fn },
    ...extra,
  });

  it("a gap frame (uninstrumented middle method) is reachability, not an edge; observed paths light up", async () => {
    const graph = await analyzeTree(springApp(sources));
    const agg = new Aggregator();
    // Ctl.x → Svc.run → (Helper.help not instrumented) → Repo.save
    agg.add([span("1", "1", "Ctl", "x"), span("1", "2", "Svc", "run", "1"), span("1", "3", "Repo", "save", "2")]);
    const overlay = reconcile(graph, agg.state);
    expect(overlay.runtimeEdges).toEqual([]);
    expect(names(graph, overlay.reachability.map((r) => r.to))).toEqual(["Repo.save"]);
    expect(names(graph, Object.keys(overlay.steps)).sort()).toEqual(["Ctl.x", "Repo.save", "Svc.run"]);
  });

  it("a same-class call the static rules inline becomes a runtime-observed edge; overloads are ambiguous", async () => {
    const graph = await analyzeTree(springApp(sources));
    // make Svc.inner a known step: it is only reached at runtime
    const stepRun = graph.steps.find((s) => s.symbol.name === "Svc.run");
    const inner = { ...stepRun!, id: "inner-step", symbol: { ...stepRun!.symbol, name: "Svc.inner", fqn: "app.Svc#inner()" } };
    const withInner: AtlasGraph = { ...graph, steps: [...graph.steps, inner] };
    const agg = new Aggregator();
    agg.add([span("2", "1", "Svc", "run"), span("2", "2", "Svc", "inner", "1")]);
    const overlay = reconcile(withInner, agg.state);
    expect(overlay.runtimeEdges.map((e) => [names(withInner, [e.from])[0], names(withInner, [e.to])[0]])).toEqual([["Svc.run", "Svc.inner"]]);

    const ambiguous: AtlasGraph = {
      ...graph,
      steps: [...graph.steps, { ...stepRun!, id: "a1", symbol: { ...stepRun!.symbol, name: "Svc.a", fqn: "app.Svc#a(int)" } }, { ...stepRun!, id: "a2", symbol: { ...stepRun!.symbol, name: "Svc.a", fqn: "app.Svc#a(String)" } }],
    };
    const agg2 = new Aggregator();
    agg2.add([span("3", "1", "Svc", "a")]);
    expect(reconcile(ambiguous, agg2.state).unmatched).toEqual([{ key: "m:app.Svc#a", count: 1, reason: "ambiguous" }]);
  });

  it("writes a properties file with escaped values and mybatis on", () => {
    const text = buildAgentConfig({ serviceName: "ruoyi-admin", endpoint: "http://127.0.0.1:43180/v1/traces", token: "t0k", methodsInclude: "a.B[c,d];e.F[g]" });
    expect(text).toContain("otel.exporter.otlp.traces.endpoint=http\\://127.0.0.1\\:43180/v1/traces");
    expect(text).toContain("otel.exporter.otlp.traces.headers=authorization\\=Bearer t0k");
    expect(text).toContain("otel.instrumentation.mybatis.enabled=true");
    expect(text).toContain("otel.instrumentation.methods.include=a.B[c,d];e.F[g]");
  });
});

describe.skipIf(!haveFixtures(FIXTURES.ruoyiVue))("AC#25 — merge throughput", () => {
  it("folds 10 000 spans in and reconciles them against RuoYi-Vue in under 2 s", async () => {
    const { graph } = await analyzeWorkspace({ roots: [{ path: FIXTURES.ruoyiVue }], history: false });
    const base = golden();
    const records: SpanRecord[] = [];
    for (let i = 0; records.length < 10_000; i++) {
      const suffix = i.toString(16).padStart(6, "0");
      for (const r of base) records.push({ ...r, t: `${r.t.slice(0, 26)}${suffix}`, start: r.start + i, ...(r.p ? { p: r.p } : {}) });
    }
    const started = performance.now();
    const agg = new Aggregator();
    agg.add(records.slice(0, 10_000));
    const overlay = reconcile(graph, agg.state);
    applyOverlay(graph, overlay);
    const ms = performance.now() - started;
    expect(agg.state.total).toBe(10_000);
    expect(Object.keys(overlay.entrypoints).length).toBeGreaterThan(3);
    expect(ms).toBeLessThan(2000);
  });
});
