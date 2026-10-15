import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeWorkspace } from "../../src/analyze.js";
import { emptyGraph } from "../../src/model/schema.js";
import { GraphView, loadStoredGraph, saveGraph } from "../../src/store/graph-store.js";
import { FIXTURES, haveFixtures } from "../helpers/fixtures.js";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("graph store", () => {
  it("reports missing and corrupt stores", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "atlas-store-"));
    expect(await loadStoredGraph(dir)).toEqual({ status: "missing" });
    await saveGraph(dir, emptyGraph("0.1.0", "x", new Date("2026-10-15T00:00:00Z")));
    expect((await loadStoredGraph(dir)).status).toBe("ok");
    await writeFile(path.join(dir, "graph", "meta.json"), "{broken");
    expect((await loadStoredGraph(dir)).status).toBe("rebuild");
  });

  it.skipIf(!haveFixtures(FIXTURES.ruoyiVue, FIXTURES.ruoyiVue3))("round-trips a real graph and slices views", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "atlas-store-"));
    const { graph } = await analyzeWorkspace({ roots: [{ path: FIXTURES.ruoyiVue }, { path: FIXTURES.ruoyiVue3 }], history: false });
    await saveGraph(dir, graph);
    const loaded = await loadStoredGraph(dir);
    expect(loaded.status).toBe("ok");
    if (loaded.status !== "ok") return;
    expect(loaded.graph.steps.length).toBe(graph.steps.length);
    expect(loaded.graph.edges.length).toBe(graph.edges.length);
    expect(loaded.graph.flows.length).toBe(graph.flows.length);

    const view = new GraphView(loaded.graph);
    const overview = view.overview();
    expect(overview.serviceCount).toBe(2);
    expect(overview.candidateFeatures.map((f) => f.title)).toContain("用户管理");
    const userMenu = overview.candidateFeatures.find((f) => f.title === "用户管理");
    expect(userMenu?.entrypointIds.length).toBeGreaterThan(3);

    const ep = graph.entrypoints.find((e) => e.method === "GET" && e.path === "/system/user/list");
    const detail = view.flowDetail(ep?.id ?? "");
    expect(detail?.steps.map((s) => s.layer)).toContain("sql");
    expect(detail?.steps[0]?.layer).toBe("frontend");
    const deep = view.flowDetail(ep?.id ?? "", 30);
    expect(deep?.steps.length).toBeGreaterThanOrEqual(detail?.steps.length ?? 0);
  }, 120_000);
});
