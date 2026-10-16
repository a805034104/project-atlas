import { describe, expect, it } from "vitest";
import type { CallEdge, FlowDetailData, FlowLayer, FlowStep } from "@project-atlas/core";
import { buildSwimlane } from "../src/views/flow/model.js";
import { buildPyramid, FANOUT_SHOW, middleTruncate, NODE_H, NODE_W, ROW_GAP } from "../src/views/flow/pyramid-layout.js";
import { userListDetail } from "../src/dev/mock.js";

const none = new Set<string>();

function detail(steps: [string, FlowLayer][], edges: [string, string][], service = "svc"): FlowDetailData {
  const s: FlowStep[] = steps.map(([id, layer]) => ({ id, serviceId: service, layer, symbol: { rootId: "r", file: `${id}.java`, line: 1, name: id, fqn: `a.${id}#m()` } }));
  const e: CallEdge[] = edges.map(([from, to], i) => ({ id: `e${i}`, from, to, order: i, provenance: "static", confidence: 1 }));
  return {
    entrypoint: { id: "ep", serviceId: service, kind: "http", method: "GET", path: "/x", handler: s[0]?.symbol ?? { rootId: "r", file: "x", name: "x", fqn: "x" }, evidence: [] } as unknown as FlowDetailData["entrypoint"],
    flow: { entrypointId: "ep", stepIds: s.map((x) => x.id), edgeIds: e.map((x) => x.id), truncated: false },
    steps: s,
    edges: e,
    services: [{ id: service, name: service }],
    unresolvedCalls: [],
  };
}

const layoutOf = (d: FlowDetailData, expandedFanout: ReadonlySet<string> = none) => buildPyramid(buildSwimlane(d, { expandedBranches: none, collapsedBands: none }), { expandedFanout });
const at = (l: ReturnType<typeof layoutOf>, id: string) => l.nodes.find((n) => n.id === id) as NonNullable<ReturnType<typeof layoutOf>["nodes"][number]>;

describe("pyramid layout", () => {
  it("puts the entry on top and each call one row lower; a caller is centred over its callees", () => {
    const l = layoutOf(detail([["ctl", "controller"], ["svc", "service"], ["m1", "repository"], ["m2", "repository"], ["m3", "repository"]], [["ctl", "svc"], ["svc", "m1"], ["svc", "m2"], ["svc", "m3"]]));
    expect(at(l, "ctl").depth).toBe(0);
    expect(at(l, "svc").y - at(l, "ctl").y).toBe(NODE_H + ROW_GAP);
    const kids = ["m1", "m2", "m3"].map((id) => at(l, id));
    expect(new Set(kids.map((k) => k.y)).size).toBe(1);
    const mid = (kids[0]!.x + kids[2]!.x) / 2;
    expect(Math.abs(at(l, "svc").x - mid)).toBeLessThan(1);
    expect(Math.abs(at(l, "ctl").x - at(l, "svc").x)).toBeLessThan(1); // straight trunk
  });

  it("never overlaps two nodes", () => {
    const l = layoutOf(userListDetail() as FlowDetailData);
    for (const a of l.nodes) for (const b of l.nodes) {
      if (a === b || a.y !== b.y) continue;
      expect(Math.abs(a.x - b.x)).toBeGreaterThanOrEqual(NODE_W);
    }
  });

  it("folds a wide fan-out into the first callees plus one '+N' node, expandable in place", () => {
    const mappers = Array.from({ length: 12 }, (_, i) => `m${i}`);
    const d = detail([["svc", "service"], ...mappers.map((m) => [m, "repository"] as [string, FlowLayer])], mappers.map((m) => ["svc", m] as [string, string]));
    const folded = layoutOf(d);
    const row = folded.nodes.filter((n) => n.depth === 1);
    expect(row.length).toBe(FANOUT_SHOW + 1);
    expect(row.at(-1)?.more).toEqual({ parent: "svc", count: 12 - FANOUT_SHOW });
    expect(layoutOf(d, new Set(["svc"])).nodes.filter((n) => n.depth === 1).length).toBe(12);
  });

  it("draws recursion as a loop on the right, not as a row going back up", () => {
    const l = layoutOf(detail([["a", "service"], ["b", "service"]], [["a", "b"], ["b", "a"]]));
    const back = l.links.find((x) => x.kind === "back");
    expect(back?.from).toBe("b");
    expect(back?.to).toBe("a");
    expect(back?.path).toMatch(/^M[\d.]+,[\d.]+ H[\d.]+ V[\d.]+ H[\d.]+$/);
  });

  it("lays out 200 steps well within a frame budget", () => {
    const ids = Array.from({ length: 200 }, (_, i) => `s${i}`);
    const edges: [string, string][] = ids.slice(1).map((id, i) => [ids[Math.floor(i / 3)] as string, id]);
    const d = detail(ids.map((id) => [id, "service"]), edges);
    const started = performance.now();
    const l = layoutOf(d, new Set(ids));
    expect(performance.now() - started).toBeLessThan(200);
    expect(l.nodes.length).toBe(200);
  });

  it("truncates long labels in the middle, keeping both ends", () => {
    expect(middleTruncate("SysUserServiceImpl.selectUserList")).toBe("SysUserServi…electUserList");
    expect(middleTruncate("Short.x")).toBe("Short.x");
  });
});
