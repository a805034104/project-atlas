import { describe, expect, it } from "vitest";
import { GraphBuilder } from "../../src/graph/builder.js";
import { JavaIndex } from "../../src/rules/java-index.js";
import { indexMapperXml } from "../../src/rules/mybatis.js";
import { runSpringRules } from "../../src/rules/spring.js";
import { detectProject } from "../../src/workspace/detect.js";
import type { Workspace } from "../../src/workspace/load.js";
import { FIXTURES, haveFixtures, loadFixture } from "../helpers/fixtures.js";

function within(dir: string, rel: string): boolean {
  return dir === "" || rel.startsWith(`${dir}/`);
}

async function analyzeService(workspace: Workspace, name: string) {
  const project = detectProject(workspace);
  const svc = project.java.find((j) => j.service.name === name);
  if (!svc) throw new Error(`no service ${name}`);
  const files = workspace.files.filter((f) => svc.classpath.some((c) => c.rootId === f.rootId && within(c.dir, f.relPath)));
  const index = new JavaIndex(files);
  const graph = new GraphBuilder();
  const result = runSpringRules(svc, index, indexMapperXml(files), graph);
  return { svc, graph, result };
}

function flowNames(graph: GraphBuilder, chain: { chainStepIds: string[]; chainEdgeIds: string[]; handlerStepId: string; entrypoint: { id: string } }) {
  const flow = graph.projectFlow(chain.entrypoint.id, chain.chainStepIds, chain.chainEdgeIds, chain.handlerStepId);
  return flow.stepIds.map((id) => {
    const s = graph.steps.get(id);
    return `${s?.layer}:${s?.symbol.name}`;
  });
}

describe.skipIf(!haveFixtures(FIXTURES.ruoyiVue))("Spring rules on RuoYi-Vue", () => {
  it("finds every controller endpoint (spec AC#2)", async () => {
    const { graph, result } = await analyzeService(await loadFixture(FIXTURES.ruoyiVue, FIXTURES.ruoyiVue3), "ruoyi-admin");
    const http = [...graph.entrypoints.values()].filter((e) => e.kind === "http");
    // Pinned fixture: scripts/reference/count_spring_endpoints.py fixtures/repos/ruoyi-vue → 148
    expect(http.length).toBe(148);
    expect(http.some((e) => e.method === "GET" && e.path === "/system/user/list")).toBe(true);
    expect(http.some((e) => e.method === "GET" && e.path === "/system/user/{}")).toBe(true);
    expect(result.chains.length).toBe(http.length);
  });

  it("builds the GET /system/user/list chain in order (spec AC#3, by symbol)", async () => {
    const { graph, result } = await analyzeService(await loadFixture(FIXTURES.ruoyiVue, FIXTURES.ruoyiVue3), "ruoyi-admin");
    const chain = result.chains.find((c) => c.entrypoint.method === "GET" && c.entrypoint.path === "/system/user/list");
    expect(chain).toBeDefined();
    const names = flowNames(graph, chain as NonNullable<typeof chain>);
    const idx = (needle: string) => names.findIndex((n) => n.includes(needle));
    const order = [
      "filter:JwtAuthenticationTokenFilter",
      "interceptor:RepeatSubmitInterceptor",
      "interceptor:@PreAuthorize",
      "controller:SysUserController.list",
      "aspect:@Before DataScopeAspect",
      "service:SysUserServiceImpl.selectUserList",
      "repository:SysUserMapper.selectUserList",
      'sql:<select id="selectUserList">',
    ];
    for (const needle of order) expect(idx(needle), `${needle} in ${names.join(" → ")}`).toBeGreaterThanOrEqual(0);
    const positions = order.map(idx);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});
