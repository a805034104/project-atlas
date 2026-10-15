import { describe, expect, it } from "vitest";
import { analyzeWorkspace } from "../src/analyze.js";
import type { AtlasGraph } from "../src/model/types.js";
import { FIXTURES, haveFixtures } from "./helpers/fixtures.js";

function names(graph: AtlasGraph, entrypointPath: string, method = "GET"): string[] {
  const ep = graph.entrypoints.find((e) => e.kind === "http" && e.method === method && e.path === entrypointPath);
  const flow = graph.flows.find((f) => f.entrypointId === ep?.id);
  const steps = new Map(graph.steps.map((s) => [s.id, s]));
  const services = new Map(graph.services.map((s) => [s.id, s.name]));
  return (flow?.stepIds ?? []).map((id) => {
    const s = steps.get(id);
    return `${services.get(s?.serviceId ?? "")}|${s?.layer}:${s?.symbol.name}`;
  });
}

describe.skipIf(!haveFixtures(FIXTURES.ruoyiCloud, FIXTURES.ruoyiCloudVue3))("analyzeWorkspace on RuoYi-Cloud + Vue3", () => {
  it("links frontend → gateway → service and Feign calls", async () => {
    const started = Date.now();
    const { graph } = await analyzeWorkspace({ roots: [{ path: FIXTURES.ruoyiCloud }, { path: FIXTURES.ruoyiCloudVue3 }], history: false });
    const elapsed = Date.now() - started;
    console.log(`analysis ${elapsed} ms, ${graph.entrypoints.length} entrypoints, ${graph.serviceLinks.length} links, ${graph.unresolvedCalls.length} unresolved`);

    const kinds = new Set(graph.serviceLinks.map((l) => l.kind));
    expect(kinds).toEqual(new Set(["frontend-proxy", "gateway-route", "http"]));

    const flow = names(graph, "/user/list");
    const has = (s: string) => flow.findIndex((n) => n.includes(s));
    expect(has("|frontend:listUser()"), flow.join("\n")).toBe(0);
    expect(has("ruoyi-gateway|middleware:route ruoyi-system")).toBeGreaterThan(0);
    expect(has("ruoyi-system|controller:SysUserController.list")).toBeGreaterThan(has("route ruoyi-system"));
    expect(has('ruoyi-system|sql:<select id="selectUserList">')).toBeGreaterThan(has("SysUserController.list"));

    // Feign: ruoyi-auth logs in through RemoteUserService → ruoyi-system /user/info/{username}
    const feign = graph.serviceLinks.filter((l) => l.kind === "http");
    const auth = graph.services.find((s) => s.name === "ruoyi-auth");
    const system = graph.services.find((s) => s.name === "ruoyi-system");
    expect(feign.some((l) => l.fromServiceId === auth?.id && l.toServiceId === system?.id && l.channel === "GET /user/info/{}" && l.toEntrypointId)).toBe(true);
    expect(feign.every((l) => l.toEntrypointId), feign.filter((l) => !l.toEntrypointId).map((l) => l.channel).join(", ")).toBe(true);

    // AC#15: ≥95% of frontend api calls resolve to a concrete service entrypoint
    const frontendCalls = graph.steps.filter((s) => s.layer === "frontend" && s.symbol.name.endsWith("()"));
    const resolved = new Set(graph.serviceLinks.filter((l) => l.kind === "frontend-proxy").map((l) => l.fromStepId));
    const ratio = resolved.size / frontendCalls.length;
    const unresolved = graph.unresolvedCalls.filter((u) => frontendCalls.some((s) => s.id === u.fromStepId)).map((u) => u.expression);
    expect(ratio, unresolved.join("\n")).toBeGreaterThanOrEqual(0.95);
  }, 120_000);
});

describe.skipIf(!haveFixtures(FIXTURES.ruoyiCloud, FIXTURES.ruoyiCloudVue3))("RuoYi-Cloud aspects", () => {
  it("applies the PreAuthorizeAspect declared through a constant pointcut", async () => {
    const { graph } = await analyzeWorkspace({ roots: [{ path: FIXTURES.ruoyiCloud }, { path: FIXTURES.ruoyiCloudVue3 }], history: false });
    expect(graph.diagnostics.filter((d) => d.code === "ATLAS-W010")).toEqual([]);
    const flow = names(graph, "/user/list");
    expect(flow.some((n) => n.includes("aspect:@Around PreAuthorizeAspect.around"))).toBe(true);
  }, 120_000);
});
