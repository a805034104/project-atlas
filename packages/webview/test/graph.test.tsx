// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import type { Module } from "@project-atlas/core";
import { openView } from "./helpers.js";
import { historyData, modulesData, services, topologyData } from "../src/dev/mock.js";
import { layeredFallback } from "../src/layout.js";
import { MAX_GRAPH_NODES } from "../src/components/GraphCanvas.js";

describe("modules graph", () => {
  it("renders React Flow nodes with descriptive aria-labels and heat numbers", () => {
    const h = openView("modules", { payload: { view: "modules", data: modulesData() } });
    expect(h.container.querySelector('.graph-or-list[data-mode="graph"]')).not.toBeNull();
    const sys = screen.getByRole("button", { name: /^ruoyi-system, build-module, 3 outgoing edges, 38 commits in the last 90 days$/ });
    expect(sys.textContent).toContain("38");
  });

  it("keyboard: Tab stop on one node, ArrowRight follows a dependency edge, Enter opens details", () => {
    openView("modules", { payload: { view: "modules", data: modulesData() } });
    const sys = screen.getByRole("button", { name: /^ruoyi-system,/ });
    expect(sys.getAttribute("tabindex")).toBe("0");
    act(() => sys.focus());
    fireEvent.keyDown(sys, { key: "ArrowRight" });
    const core = screen.getByRole("button", { name: /^ruoyi-common-core,/ });
    expect(document.activeElement).toBe(core);
    fireEvent.keyDown(core, { key: "Enter" });
    expect(screen.getByRole("complementary", { name: "ruoyi-common-core" })).toBeTruthy();
  });

  it("list view toggle renders an accessible table instead", () => {
    openView("modules", { payload: { view: "modules", data: modulesData() } });
    fireEvent.click(screen.getByRole("button", { name: "List view" }));
    const table = screen.getByRole("table");
    expect(table.querySelectorAll("tbody tr").length).toBe(modulesData().modules.length);
    expect(screen.getByRole("button", { name: "Graph view" }).getAttribute("aria-pressed")).toBe("true");
  });

  it(`auto-switches to the list above ${MAX_GRAPH_NODES} nodes`, () => {
    const many: Module[] = Array.from({ length: MAX_GRAPH_NODES + 1 }, (_, i) => ({
      id: `m${i}`,
      serviceId: "svc-system",
      name: `module-${i}`,
      path: `m/${i}`,
      kind: "package",
      dependsOn: i > 0 ? [`m${i - 1}`] : [],
      fileCount: 1,
      loc: 10,
    }));
    const h = openView("modules", { payload: { view: "modules", data: { services, modules: many, commits90d: {} } } });
    expect(h.container.querySelector('.graph-or-list[data-mode="list"]')).not.toBeNull();
    expect(screen.getByRole("note").textContent).toContain("501 nodes");
    expect(screen.getByRole("table").querySelectorAll("tbody tr").length).toBe(501);
    expect(h.container.querySelector(".react-flow")).toBeNull();
  });

  it("service filter narrows the graph and is persisted", () => {
    const h = openView("modules", { payload: { view: "modules", data: modulesData() } });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "svc-auth" } });
    expect(screen.queryByRole("button", { name: /^ruoyi-system,/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^ruoyi-auth,/ })).toBeTruthy();
    expect((h.vscode.state as { filters: { moduleServiceId: string } }).filters.moduleServiceId).toBe("svc-auth");
  });
});

describe("topology graph", () => {
  it("service nodes; Enter opens the service's evidence", () => {
    const h = openView("topology", { payload: { view: "topology", data: topologyData() } });
    const gw = screen.getByRole("button", { name: "ruoyi-gateway, gateway, 2 outgoing edges" });
    fireEvent.keyDown(gw, { key: "Enter" });
    expect(h.lastSent("openSource")?.ref.file).toBe("ruoyi-gateway/pom.xml");
  });
});

describe("history heatmap", () => {
  it("cells carry counts in tooltip/aria-label and the table toggle shows the same numbers", () => {
    openView("history", { payload: { view: "history", data: historyData() } });
    const cells = [...document.querySelectorAll<HTMLElement>(".heat-cell")];
    expect(cells.length).toBe(6 * 12);
    const total = cells.reduce((s, c) => s + Number(c.dataset.count), 0);
    expect(total).toBe(38 + 24 + 9 + 7 + 4 + 2);
    const busy = cells.find((c) => Number(c.dataset.count) > 0) as HTMLElement;
    expect(busy.getAttribute("title")).toMatch(/week of \d{4}-\d{2}-\d{2}: \d+ commits/);

    fireEvent.click(screen.getByRole("button", { name: "Table view" }));
    const table = screen.getByRole("table");
    const nums = [...table.querySelectorAll("tbody td")].reduce((s, td) => s + Number(td.textContent), 0);
    expect(nums).toBe(total);
  });

  it("selecting a module shows its timeline and plain-text AI summary (no HTML)", () => {
    const data = historyData();
    const sys = data.history.find((x) => x.moduleId === "mod-system");
    if (sys) sys.aiSummary = "<b>bold?</b> first\n\nsecond paragraph";
    const h = openView("history", { payload: { view: "history", data } });
    fireEvent.click(screen.getAllByRole("button", { name: "ruoyi-system" })[0] as HTMLElement);
    expect(screen.getByText("Evolution summary (AI)", { exact: false })).toBeTruthy();
    const summary = h.container.querySelector(".ai-summary .plain-text") as HTMLElement;
    expect(summary.querySelectorAll("p").length).toBe(2);
    expect(summary.querySelector("b")).toBeNull();
    expect(summary.textContent).toContain("<b>bold?</b>");
  });
});

describe("layout fallback", () => {
  it("layers nodes left→right by longest path and survives cycles", () => {
    const pos = layeredFallback(
      ["a", "b", "c"].map((id) => ({ id, width: 100, height: 40 })),
      [
        { id: "1", from: "a", to: "b" },
        { id: "2", from: "b", to: "c" },
        { id: "3", from: "c", to: "b" },
      ],
    );
    expect(pos.a?.x).toBe(0);
    expect((pos.b?.x ?? 0) > 0).toBe(true);
    expect(Object.keys(pos)).toHaveLength(3);
  });
});
