import { describe, expect, it } from "vitest";
import { analyzeWorkspace, GraphView } from "@project-atlas/core";
import { FIXTURES, haveFixtures } from "../../core/test/helpers/fixtures.js";
import { buildSwimlane } from "../../webview/src/views/flow/model.js";
import { buildPyramid, NODE_W } from "../../webview/src/views/flow/pyramid-layout.js";

/**
 * Invariant on real projects: in every flow, every step is drawn (as a node or as an aspect
 * side-car) and no two nodes overlap. (mall-swarm once lost 63 of 64 steps behind a chain of
 * @Before/@AfterReturning/@Around advice at the entry.)
 */
describe.skipIf(!haveFixtures(FIXTURES.ruoyiCloud, FIXTURES.ruoyiVue))("pyramid on real projects", () => {
  it.each([
    ["RuoYi-Vue", FIXTURES.ruoyiVue],
    ["RuoYi-Cloud", FIXTURES.ruoyiCloud],
  ])("%s: every step of every flow is placed, nothing overlaps", async (_name, dir) => {
    const { graph } = await analyzeWorkspace({ roots: [{ path: dir }], history: false });
    const view = new GraphView(graph);
    let flows = 0;
    for (const ep of graph.entrypoints) {
      const detail = view.flowDetail(ep.id);
      if (!detail) continue;
      flows++;
      const model = buildSwimlane(detail, { expandedBranches: new Set(), collapsedBands: new Set() });
      const layout = buildPyramid(model, { expandedFanout: new Set(model.nodes.map((n) => n.id)) });
      const shown = layout.nodes.length + layout.nodes.reduce((n, p) => n + (p.sidecars?.length ?? 0), 0);
      expect(shown, `${ep.method} ${ep.path}`).toBe(model.nodes.length);
      const rows = new Map<number, number[]>();
      for (const n of layout.nodes) rows.set(n.y, [...(rows.get(n.y) ?? []), n.x]);
      for (const xs of rows.values()) {
        const sorted = xs.sort((a, b) => a - b);
        for (let i = 1; i < sorted.length; i++) expect((sorted[i] as number) - (sorted[i - 1] as number), `${ep.method} ${ep.path}`).toBeGreaterThanOrEqual(NODE_W);
      }
    }
    expect(flows).toBeGreaterThan(50);
  });
});
