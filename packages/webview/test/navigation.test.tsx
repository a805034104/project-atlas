// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { openView, renderApp, state } from "./helpers.js";
import { featuresData, flowListData, modulesData, overviewData, USER_LIST_EP } from "../src/dev/mock.js";
import type { PersistedState } from "../src/vscode.js";

describe("tabs", () => {
  it("renders the tablist in spec order, topology only when showTopology", () => {
    openView("overview", { showTopology: true });
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "Overview",
      "Topology",
      "Modules",
      "Features",
      "Startup",
      "Flow",
      "History",
      "Trace",
    ]);
  });

  it("hides topology for single-service workspaces and falls back from a persisted topology tab", () => {
    openView("topology", { showTopology: false });
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).not.toContain("Topology");
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("Overview");
  });

  it("arrow keys / Home / End move selection and focus with roving tabindex", () => {
    const h = openView("overview");
    const overview = screen.getByRole("tab", { name: "Overview" });
    expect(overview.getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("tab", { name: "Modules" }).getAttribute("tabindex")).toBe("-1");

    fireEvent.keyDown(overview, { key: "ArrowRight" });
    const topo = screen.getByRole("tab", { name: "Topology" });
    expect(topo.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(topo);

    fireEvent.keyDown(topo, { key: "End" });
    expect(screen.getByRole("tab", { name: "Trace" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Trace" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Overview" }), { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Trace" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Trace" }), { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "History" }).getAttribute("aria-selected")).toBe("true");

    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe("tab-history");
    expect((h.vscode.state as PersistedState).tab).toBe("history");
  });

  it("restores the persisted tab, entrypoint and filters", () => {
    const h = openView("flow", {
      persisted: {
        selectedEntrypointId: USER_LIST_EP,
        filters: { flowSearch: "user/list", flowMethod: "GET", moduleServiceId: "" },
      },
      payload: { view: "flow", data: flowListData() },
    });
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("Flow");
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("user/list");
    expect(h.lastSent("requestFlow")?.entrypointId).toBe(USER_LIST_EP);
  });

  it("sends ready on mount", () => {
    const h = renderApp();
    expect(h.sent[0]).toEqual({ type: "ready" });
  });

  it("'/' focuses the search field of the active view", () => {
    openView("flow", { payload: { view: "flow", data: flowListData() } });
    fireEvent.keyDown(document.body, { key: "/" });
    expect(document.activeElement).toBe(screen.getByRole("searchbox"));
  });
});

describe("deep links & breadcrumbs", () => {
  it("feature → module → back", () => {
    const h = openView("features", { payload: { view: "features", data: featuresData(true) } });
    fireEvent.click(screen.getByRole("button", { name: "User & permission management" }));
    fireEvent.click(screen.getByRole("button", { name: "ruoyi-system" }));
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("Modules");
    expect(h.lastSent("requestView")).toEqual({ type: "requestView", view: "modules" });
    h.emit({ type: "viewData", payload: { view: "modules", data: modulesData() } });
    // Module details panel opened for the deep-linked module.
    expect(screen.getByRole("complementary", { name: "ruoyi-system" })).toBeTruthy();
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumbs.textContent).toContain("User & permission management");

    fireEvent.click(screen.getByRole("button", { name: "← Back" }));
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("Features");
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
  });

  it("feature → entrypoint opens the flow with that entrypoint selected", () => {
    const h = openView("features", { payload: { view: "features", data: featuresData(true) } });
    fireEvent.click(screen.getByRole("button", { name: "User & permission management" }));
    fireEvent.click(screen.getByRole("button", { name: "GET /system/user/list" }));
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("Flow");
    h.emit({ type: "viewData", payload: { view: "flow", data: flowListData() } });
    expect(h.lastSent("requestFlow")).toEqual({ type: "requestFlow", entrypointId: USER_LIST_EP });
  });

  it("reveal message switches view, selects the node and is undoable with Back", () => {
    const h = openView("overview", { payload: { view: "overview", data: overviewData(true) } });
    h.emit({ type: "reveal", view: "flow", nodeId: USER_LIST_EP });
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("Flow");
    expect((h.vscode.state as PersistedState).selectedEntrypointId).toBe(USER_LIST_EP);
    fireEvent.click(screen.getByRole("button", { name: "← Back" }));
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("Overview");
  });

  it("overview hot module links into the modules view", () => {
    openView("overview", { analysis: state(), payload: { view: "overview", data: overviewData(true) } });
    const hot = screen.getByRole("region", { name: "Where the heat is" });
    expect(hot.querySelectorAll("li").length).toBe(5);
    fireEvent.click(screen.getAllByRole("button", { name: "ruoyi-system" })[0] as HTMLElement);
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("Modules");
  });
});
