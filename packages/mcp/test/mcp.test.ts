import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { analyzeWorkspace, emptyGraph, saveGraph, type AtlasGraph, type GraphView } from "@project-atlas/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GraphSource, StoreUnavailableError } from "../src/store.js";
import { findSymbol, getFlow, getModuleHistory, listEntrypoints, listServices, listTraces, ToolInputError } from "../src/tools.js";
import { TOOL_NAMES } from "../src/server.js";

const RUOYI_VUE = path.resolve("fixtures/repos/ruoyi-vue");
const RUOYI_VUE3 = path.resolve("fixtures/repos/ruoyi-vue3");
const haveFixtures = existsSync(RUOYI_VUE) && existsSync(RUOYI_VUE3);
const BIN = path.resolve("packages/mcp/dist/bin.js");

describe("graph source", () => {
  it("reports missing and corrupt stores with the analyze hint, and reloads on change", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "atlas-mcp-"));
    try {
      const source = new GraphSource(dir);
      await expect(source.view()).rejects.toThrow(StoreUnavailableError);
      await expect(source.view()).rejects.toThrow(/project-atlas analyze/);

      await saveGraph(dir, emptyGraph("0.1.0", "first", new Date("2026-10-15T00:00:00Z")));
      const first = await source.view();
      expect(first.graph.project.name).toBe("first");
      expect(await source.view()).toBe(first); // cached while meta.json is unchanged

      await saveGraph(dir, emptyGraph("0.1.0", "second-project", new Date("2026-10-15T00:00:00Z")));
      expect((await source.view()).graph.project.name).toBe("second-project");

      await writeFile(path.join(dir, "graph", "meta.json"), "{broken json");
      await expect(source.view()).rejects.toThrow(/unreadable/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!haveFixtures)("tools on RuoYi-Vue + RuoYi-Vue3", () => {
  let dir: string;
  let view: GraphView;
  let graph: AtlasGraph;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "atlas-mcp-"));
    ({ graph } = await analyzeWorkspace({ roots: [{ path: RUOYI_VUE }, { path: RUOYI_VUE3 }], history: true }));
    await saveGraph(path.join(dir, ".atlas"), graph);
    view = await new GraphSource(path.join(dir, ".atlas")).view();
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("list_services: services sorted with counts and aggregated links", () => {
    const out = listServices(view);
    const services = out.data.services as { name: string; kind: string; path: string; entrypoints: number }[];
    expect(services.map((s) => s.name)).toEqual(["ruoyi", "ruoyi-admin"]);
    expect(services[1]).toMatchObject({ kind: "backend", path: "ruoyi-vue/ruoyi-admin" });
    expect(services[1]?.entrypoints).toBeGreaterThan(100);
    expect(out.text).toContain("- ruoyi-admin [backend, java-spring] ruoyi-vue/ruoyi-admin");
    expect(out.text).toMatch(/ruoyi → ruoyi-admin \(frontend-proxy\) ×\d+/);
    expect(listServices(view)).toEqual(out);
  });

  it("list_entrypoints: filters, limit and unknown service", () => {
    const out = listEntrypoints(view, { service: "ruoyi-admin", method: "get", pathContains: "/system/user", limit: 3 });
    const eps = out.data.entrypoints as { label: string; service: string; location: string }[];
    expect(out.data.returned).toBe(3);
    expect(out.data.total as number).toBeGreaterThan(3);
    expect(eps.every((e) => e.label.startsWith("GET /system/user") && e.service === "ruoyi-admin")).toBe(true);
    expect(out.text).toContain("showing 3");
    const all = listEntrypoints(view, { pathContains: "/system/user/list" });
    expect((all.data.entrypoints as { label: string }[]).map((e) => e.label)).toContain("GET /system/user/list");
    expect(listEntrypoints(view, { kind: "frontend-route" }).data.total as number).toBeGreaterThan(0);
    expect(() => listEntrypoints(view, { service: "nope" })).toThrow(ToolInputError);
  });

  it("get_flow: GET /system/user/list in order with file:line", () => {
    const out = getFlow(view, { entrypoint: "GET /system/user/list" });
    const steps = out.data.steps as { layer: string; symbol: string; location: string; service: string }[];
    expect(steps[0]).toMatchObject({ layer: "frontend", service: "ruoyi" });
    const idx = (s: string) => steps.findIndex((x) => x.symbol === s);
    expect(idx("SysUserController.list")).toBeGreaterThan(idx("XssFilter.doFilter"));
    expect(idx("SysUserMapper.selectUserList")).toBeGreaterThan(idx("SysUserController.list"));
    expect(steps.find((s) => s.layer === "sql")?.location).toMatch(/^ruoyi-vue\/ruoyi-system\/src\/main\/resources\/mapper\/system\/SysUserMapper\.xml:\d+$/);
    expect(out.text.split("\n")[0]).toMatch(/^GET \/system\/user\/list \[ruoyi-admin\] → SysUserController\.list \(ruoyi-vue\/.+SysUserController\.java:\d+\)$/);
    expect(out.text).toMatch(/\n\d+\. controller · SysUserController\.list \(/);
    const byId = getFlow(view, { entrypoint: (out.data.entrypoint as { id: string }).id, depth: 30 });
    expect((byId.data.steps as unknown[]).length).toBeGreaterThanOrEqual(steps.length);
  });

  it("get_flow: unknown entrypoint is a tool error", () => {
    expect(() => getFlow(view, { entrypoint: "GET /does/not/exist" })).toThrow(/list_entrypoints/);
  });

  it("find_symbol: steps with location and containing flows", () => {
    const out = findSymbol(view, { query: "selectuserlist", limit: 50 });
    const steps = out.data.steps as { symbol: string; layer: string; location: string; flows: string[]; flowCount: number }[];
    const mapper = steps.find((s) => s.symbol === "SysUserMapper.selectUserList");
    expect(mapper?.layer).toBe("repository");
    expect(mapper?.location).toMatch(/SysUserMapper\.java:\d+$/);
    expect(mapper?.flows).toContain("GET /system/user/list");
    expect(out.text).toContain("repository · SysUserMapper.selectUserList (");
    expect(findSymbol(view, { query: "zzz-no-such-symbol" }).data.total).toBe(0);
  });

  it("find_symbol: limit and empty query", () => {
    const out = findSymbol(view, { query: "Controller", limit: 2 });
    expect(out.data.returned).toBe(2);
    expect(out.data.total as number).toBeGreaterThan(2);
    expect(() => findSymbol(view, { query: "  " })).toThrow(ToolInputError);
  });

  it("get_module_history: by name and by id", () => {
    const out = getModuleHistory(view, { module: "ruoyi-system", limit: 5 });
    const module = out.data.module as { id: string; name: string; service: string };
    expect(module.name).toBe("ruoyi-system");
    expect(out.data.total as number).toBeGreaterThan(0);
    expect((out.data.commits as { sha: string }[])[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(out.text.split("\n")[0]).toMatch(/^ruoyi-system \[ruoyi-admin\] ruoyi-system — \d+ commit\(s\) recorded/);
    expect(getModuleHistory(view, { module: module.id }).data.module).toEqual(module);
  });

  it("get_module_history: unknown module lists known ones", () => {
    expect(() => getModuleHistory(view, { module: "nope" })).toThrow(/Known modules: .*ruoyi-system/);
  });

  it.skipIf(!existsSync(BIN))("serves the tools over stdio (SDK client smoke test)", async () => {
    const client = new Client({ name: "atlas-test", version: "0.0.0" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, "--dir", path.join(dir, ".atlas")], stderr: "pipe" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
      expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);

      const flow = await client.callTool({ name: "get_flow", arguments: { entrypoint: "GET /system/user/list" } });
      expect(flow.isError).toBeFalsy();
      const content = flow.content as { type: string; text: string }[];
      expect(content[0]?.text).toContain("controller · SysUserController.list");
      expect((flow.structuredContent as { steps: unknown[] }).steps.length).toBeGreaterThan(5);

      const bad = await client.callTool({ name: "get_flow", arguments: { entrypoint: "GET /nope" } });
      expect(bad.isError).toBe(true);
    } finally {
      await client.close();
    }
  }, 60_000);

  it.skipIf(!existsSync(BIN))("returns a clear tool error when the store is missing", async () => {
    const client = new Client({ name: "atlas-test", version: "0.0.0" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, "--dir", path.join(dir, "nothing-here")], stderr: "pipe" });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: "list_services", arguments: {} });
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0]?.text).toMatch(/Run `project-atlas analyze`/);
    } finally {
      await client.close();
    }
  }, 60_000);
});

describe("runtime data over MCP", () => {
  it("list_traces returns aggregates only and folds observed stats into get_flow", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "atlas-mcp-rt-"));
    try {
      const graph = emptyGraph("0.2.0", "rt", new Date("2026-10-15T00:00:00Z"));
      await saveGraph(dir, graph);
      const source = new GraphSource(dir);
      const empty = listTraces(await source.view(), await source.aggregates());
      expect(empty.text).toMatch(/project-atlas trace/);

      const { TraceStore, Aggregator } = await import("@project-atlas/core");
      const agg = new Aggregator();
      agg.add([
        { t: "1".repeat(32), s: "a".repeat(16), svc: "app", scope: "s", name: "GET /x", kind: "server", start: Date.parse("2026-10-15T01:00:00Z"), dur: 12, err: false, a: { route: "/x", method: "GET" } },
        { t: "2".repeat(32), s: "b".repeat(16), svc: "app", scope: "s", name: "GET /y", kind: "server", start: Date.parse("2026-10-15T02:00:00Z"), dur: 30, err: true, a: { route: "/y", method: "GET", status: 500 } },
      ]);
      await new TraceStore(path.join(dir, "traces")).saveAggregates(agg.state);
      const view = await source.view();
      const all = listTraces(view, await source.aggregates());
      expect((all.data as { returned: number }).returned).toBe(2);
      expect(all.text.split("\n")[0]).toContain("GET /y");
      const errors = listTraces(view, await source.aggregates(), { errorsOnly: true });
      expect((errors.data as { traces: { root: string }[] }).traces.map((t) => t.root)).toEqual(["GET /y"]);
      const since = listTraces(view, await source.aggregates(), { since: "2026-10-15T01:30:00Z" });
      expect((since.data as { returned: number }).returned).toBe(1);
      expect(() => listTraces(view, agg.state, { since: "yesterday" })).toThrow(ToolInputError);
      // aggregates only: keys of a trace row
      expect(Object.keys((all.data as { traces: Record<string, unknown>[] }).traces[0] ?? {}).sort()).toEqual(["durationMs", "error", "root", "services", "spans", "start", "traceId"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
