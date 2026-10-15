import { describe, expect, it } from "vitest";
import { buildSwimlane, bandNodeId } from "../src/views/flow/model.js";
import { userListDetail } from "../src/dev/mock.js";
import { asWebviewCommand, isHostMessage } from "../src/bridge.js";
import { DEFAULT_STATE, loadState, type VsCodeApi } from "../src/vscode.js";
import { reducer, initialState } from "../src/state.js";

const none = new Set<string>();

describe("buildSwimlane", () => {
  it("orders bands by first visit and hides the collapsed branch", () => {
    const m = buildSwimlane(userListDetail(), { expandedBranches: none, collapsedBands: none });
    expect(m.bands.map((b) => b.name)).toEqual(["ruoyi-ui", "ruoyi-gateway", "ruoyi-system", "ruoyi-auth"]);
    expect(m.nodes.some((n) => n.id === "s-svc2")).toBe(false);
    expect(m.hiddenSteps).toBe(1);
    const branch = m.edges.find((e) => e.edge.id === "e-ctrl-svc")?.branch;
    expect(branch).toEqual({ group: "s-ctrl#1", count: 2, first: true });
  });

  it("expanding the branch reveals the second implementation", () => {
    const m = buildSwimlane(userListDetail(), { expandedBranches: new Set(["s-ctrl#1"]), collapsedBands: none });
    expect(m.nodes.some((n) => n.id === "s-svc2")).toBe(true);
    expect(m.hiddenSteps).toBe(0);
  });

  it("marks recursion as a back edge", () => {
    const m = buildSwimlane(userListDetail(), { expandedBranches: none, collapsedBands: none });
    expect(m.edges.find((e) => e.edge.id === "e-dept-dept")?.back).toBe(true);
    expect(m.nodes.find((n) => n.id === "s-dept")?.recursive).toBe(true);
  });

  it("collapsed band → single placeholder, edges remapped, internal edges dropped", () => {
    const m = buildSwimlane(userListDetail(), { expandedBranches: none, collapsedBands: new Set(["svc-auth"]) });
    const ids = m.nodes.map((n) => n.id);
    expect(ids).toContain(bandNodeId("svc-auth"));
    expect(ids).not.toContain("s-auth-ctrl");
    expect(m.edges.some((e) => e.to === bandNodeId("svc-auth") && e.from === "s-remote")).toBe(true);
    expect(m.edges.some((e) => e.from === bandNodeId("svc-auth") && e.to === bandNodeId("svc-auth"))).toBe(false);
  });
});

describe("bridge & persisted state", () => {
  it("accepts only known host message types", () => {
    expect(isHostMessage({ type: "init", locale: "en" })).toBe(true);
    expect(isHostMessage({ type: "evil" })).toBe(false);
    expect(isHostMessage("init")).toBe(false);
    expect(isHostMessage(null)).toBe(false);
  });

  it("only allow-listed fix commands are runnable", () => {
    expect(asWebviewCommand("atlas.configureProvider")).toBe("atlas.configureProvider");
    expect(asWebviewCommand("workbench.action.terminal.sendSequence")).toBeUndefined();
    expect(asWebviewCommand(undefined)).toBeUndefined();
  });

  it("loadState falls back to defaults on garbage", () => {
    const api = (s: unknown): VsCodeApi => ({ postMessage() {}, getState: () => s, setState() {} });
    expect(loadState(api(undefined))).toEqual(DEFAULT_STATE);
    expect(loadState(api({ tab: "bogus", filters: 3 }))).toEqual(DEFAULT_STATE);
    expect(loadState(api({ tab: "flow", selectedEntrypointId: "x", filters: { flowMethod: "GET" } }))).toMatchObject({
      tab: "flow",
      selectedEntrypointId: "x",
      filters: { flowMethod: "GET", flowSearch: "" },
    });
  });

  it("reducer: navigate pushes a crumb, back pops it", () => {
    let s = initialState(DEFAULT_STATE);
    s = reducer(s, { type: "navigate", view: "modules", nodeId: "m1", from: { view: "features", label: "F" } });
    expect(s.persisted.tab).toBe("modules");
    expect(s.persisted.selectedModuleId).toBe("m1");
    expect(s.crumbs).toHaveLength(1);
    s = reducer(s, { type: "back" });
    expect(s.persisted.tab).toBe("features");
    expect(s.crumbs).toHaveLength(0);
  });
});
