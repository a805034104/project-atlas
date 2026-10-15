// @vitest-environment jsdom
/**
 * State matrix (spec Phase 2 Pass 2): loading / empty / error / partial / stale
 * for every view.
 */
import { describe, expect, it } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import type { UserFacingError, ViewId, ViewPayload } from "@project-atlas/core";
import { openView, state } from "./helpers.js";
import {
  featuresData,
  flowListData,
  historyData,
  modulesData,
  overviewData,
  startupData,
  topologyData,
  userListDetail,
  USER_ADD_EP,
  genericDetail,
  entrypoints,
  traceData,
} from "../src/dev/mock.js";

const VIEWS: ViewId[] = ["overview", "topology", "modules", "features", "startup", "flow", "history", "trace"];

const PAYLOADS: Record<ViewId, () => ViewPayload> = {
  overview: () => ({ view: "overview", data: overviewData(true) }),
  topology: () => ({ view: "topology", data: topologyData() }),
  modules: () => ({ view: "modules", data: modulesData() }),
  features: () => ({ view: "features", data: featuresData(true) }),
  startup: () => ({ view: "startup", data: startupData() }),
  flow: () => ({ view: "flow", data: flowListData() }),
  history: () => ({ view: "history", data: historyData() }),
  trace: () => ({ view: "trace", data: traceData(true) }),
};

const E020: UserFacingError = {
  code: "ATLAS-E020",
  problem: "Anthropic returned 401 (key invalid or revoked)",
  cause: "HTTP 401 from api.anthropic.com",
  fix: "Run atlas.configureProvider and paste a valid key.",
  docsUrl: "https://example.invalid/docs/errors#atlas-e020",
  fixCommand: "atlas.configureProvider",
};

describe("loading", () => {
  it.each(VIEWS)("%s shows a skeleton until its phase completes, then requests data", (view) => {
    const h = openView(view, { analysis: state({ status: "running", completedPhases: [], currentPhase: "parse", progress: 0.4 }) });
    expect(h.container.querySelector(".skeleton")).not.toBeNull();
    expect(screen.getByText(/Analyzing: parsing 40%/)).toBeTruthy();
    expect(h.sent.some((m) => m.type === "requestView")).toBe(false);

    h.emit({ type: "analysisState", state: state() });
    expect(h.lastSent("requestView")).toEqual({ type: "requestView", view });
    // Still a skeleton until viewData arrives.
    expect(h.container.querySelector(".skeleton")).not.toBeNull();
    h.emit({ type: "viewData", payload: PAYLOADS[view]() });
    expect(h.container.querySelector(".skeleton")).toBeNull();
  });

  it("cancel button in the progress line runs atlas.cancel", () => {
    const h = openView("overview", { analysis: state({ status: "running", completedPhases: [], currentPhase: "parse" }) });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(h.lastSent("runCommand")).toEqual({ type: "runCommand", command: "atlas.cancel" });
  });

  it("never-analyzed workspace shows an Analyze primary action", () => {
    const h = openView("modules", { analysis: { status: "never", completedPhases: [], staleFiles: 0, ai: "none" } });
    fireEvent.click(screen.getByRole("button", { name: "Analyze workspace" }));
    expect(h.lastSent("runCommand")).toEqual({ type: "runCommand", command: "atlas.analyze" });
  });

  it("cancelled analysis offers to analyze again", () => {
    openView("history", { analysis: state({ status: "cancelled", completedPhases: ["parse"] }) });
    expect(screen.getByText("Analysis was cancelled before this view was ready")).toBeTruthy();
  });
});

describe("error", () => {
  it.each(VIEWS)("%s renders UserFacingError when analysis failed before its phase", (view) => {
    const h = openView(view, { analysis: state({ status: "error", completedPhases: [], error: E020 }) });
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("ATLAS-E020")).toBeTruthy();
    expect(within(alert).getByText(E020.cause)).toBeTruthy();
    expect(within(alert).getByText(E020.fix)).toBeTruthy();
    expect(within(alert).getByRole("link", { name: "Documentation" }).getAttribute("href")).toBe(E020.docsUrl);
    fireEvent.click(within(alert).getByRole("button", { name: "Fix it" }));
    expect(h.lastSent("runCommand")).toEqual({ type: "runCommand", command: "atlas.configureProvider" });
  });

  it("copy diagnostics posts copyText with the error code and analysis status", () => {
    const h = openView("overview", { analysis: state({ status: "error", completedPhases: [], error: E020 }) });
    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics" }));
    const copy = h.lastSent("copyText");
    expect(copy?.text).toContain("ATLAS-E020");
    expect(copy?.text).toContain('"status": "error"');
  });

  it("host error message shows a dismissible panel; unknown fixCommand gets no fix button", () => {
    const h = openView("overview", { payload: PAYLOADS.overview() });
    h.emit({ type: "error", error: { ...E020, code: "ATLAS-E030", fixCommand: "rm -rf /" } });
    const alert = screen.getByRole("alert");
    expect(within(alert).queryByRole("button", { name: "Fix it" })).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("empty", () => {
  it("overview: no supported stack → diagnostics action", () => {
    const data = { ...overviewData(false), stacks: [], moduleCount: 0, entrypointCount: 0 };
    const h = openView("overview", { payload: { view: "overview", data } });
    expect(screen.getByText("No supported stack detected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Export diagnostics" }));
    expect(h.lastSent("runCommand")?.command).toBe("atlas.diagnose");
  });

  it("topology: no links", () => {
    openView("topology", { payload: { view: "topology", data: { ...topologyData(), links: [], unresolvedCount: 0 } } });
    expect(screen.getByText("No cross-service links found")).toBeTruthy();
  });

  it("modules: no modules", () => {
    openView("modules", { payload: { view: "modules", data: { services: [], modules: [], commits90d: {} } } });
    expect(screen.getByText("No modules found")).toBeTruthy();
  });

  it("features: nothing to show → configure model", () => {
    const h = openView("features", {
      analysis: state({ ai: "none" }),
      payload: { view: "features", data: { features: [], modules: [], entrypoints: [] } },
    });
    expect(screen.getByText("No feature list yet")).toBeTruthy();
    fireEvent.click(within(h.container.querySelector(".empty-state") as HTMLElement).getByRole("button", { name: "Configure model" }));
    expect(h.lastSent("runCommand")?.command).toBe("atlas.configureProvider");
  });

  it("startup: lists the inspected files, each opens on click", () => {
    const inspected = { rootId: "r", file: "pom.xml", line: 1 };
    const h = openView("startup", { payload: { view: "startup", data: { guides: [], inspectedFiles: [inspected] } } });
    expect(screen.getByText("No startup method recognized")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open pom.xml:1" }));
    expect(h.lastSent("openSource")).toEqual({ type: "openSource", ref: inspected });
  });

  it("flow: no entrypoints → supported frameworks", () => {
    openView("flow", { payload: { view: "flow", data: { services: [], entrypoints: [] } } });
    expect(screen.getByText("No entrypoints recognized")).toBeTruthy();
    expect(screen.getByText(/Spring MVC/)).toBeTruthy();
  });

  it("history: not a git repository", () => {
    const data = historyData();
    openView("history", {
      payload: { view: "history", data: { ...data, history: data.history.map((h) => ({ moduleId: h.moduleId, commits: [], degraded: "no-git" as const })) } },
    });
    expect(screen.getByText("History unavailable: not a git repository")).toBeTruthy();
  });

  it("history: no commits", () => {
    const data = historyData();
    openView("history", { payload: { view: "history", data: { ...data, history: data.history.map((h) => ({ moduleId: h.moduleId, commits: [] })) } } });
    expect(screen.getByText("No commits found")).toBeTruthy();
  });
});

describe("partial", () => {
  it("overview: AI not configured → banner + candidate features", () => {
    const h = openView("overview", { analysis: state({ ai: "none" }), payload: { view: "overview", data: overviewData(false) } });
    const banner = h.container.querySelector('[data-banner="partial"]') as HTMLElement;
    expect(banner.textContent).toContain("AI summaries not generated");
    expect(h.container.querySelector('[data-partial="candidates"]')).not.toBeNull();
    expect(screen.getByText("SysUser (user management)")).toBeTruthy();
    fireEvent.click(within(banner).getByRole("button", { name: "Configure model" }));
    expect(h.lastSent("runCommand")).toEqual({ type: "runCommand", command: "atlas.configureProvider" });
  });

  it("features: AI not configured → candidate features derived from handlers", () => {
    const h = openView("features", { analysis: state({ ai: "declined" }), payload: { view: "features", data: featuresData(false) } });
    expect(h.container.querySelector('[data-banner="partial"]')).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Candidate features (not AI-generated)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "SysUser" })).toBeTruthy();
  });

  it("modules: AI not configured → banner, map still rendered", () => {
    const h = openView("modules", {
      analysis: state({ ai: "none" }),
      payload: PAYLOADS.modules(),
      persisted: { listView: { modules: true } },
    });
    expect(h.container.querySelector('[data-banner="partial"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "ruoyi-system" })).toBeTruthy();
  });

  it("topology: candidate AI links toggle hides ai-inferred links", () => {
    openView("topology", { payload: PAYLOADS.topology(), persisted: { listView: { topology: true } } });
    const toggle = screen.getByRole("checkbox", { name: /candidate links \(AI\)/ });
    expect(screen.getByText("GET /user/info/{}")).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.queryByText("GET /user/info/{}")).toBeNull();
  });

  it("flow: truncated at depth 12 → 展开更多 requests a deeper flow", () => {
    const h = openView("flow", { payload: PAYLOADS.flow(), persisted: { selectedEntrypointId: USER_ADD_EP } });
    expect(h.lastSent("requestFlow")).toEqual({ type: "requestFlow", entrypointId: USER_ADD_EP });
    const ep = entrypoints.find((e) => e.id === USER_ADD_EP);
    if (!ep) throw new Error("mock");
    h.emit({ type: "flowDetail", data: genericDetail(ep) });
    expect(screen.getByText("This flow was cut at depth 12.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(h.lastSent("requestFlow")).toEqual({ type: "requestFlow", entrypointId: USER_ADD_EP, depth: 24 });
  });

  it("history: shallow clone banner copies git fetch --unshallow; AI summary absent → timeline only", () => {
    const data = historyData();
    const clean = data.history.map((m, i) => {
      const { aiSummary: _dropped, ...rest } = m;
      return i === 0 ? { ...rest, degraded: "shallow" as const } : rest;
    });
    const h = openView("history", {
      analysis: state({ ai: "none" }),
      payload: { view: "history", data: { ...data, history: clean } },
      persisted: { selectedModuleId: "mod-system" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Copy git fetch --unshallow" }));
    expect(h.lastSent("copyText")).toEqual({ type: "copyText", text: "git fetch --unshallow" });
    expect(screen.queryByText("Evolution summary (AI)")).toBeNull();
    expect(h.container.querySelectorAll(".commit-list li").length).toBe(38);
  });

  it("flow detail loading: skeleton while the selected entrypoint's flow is pending", () => {
    const h = openView("flow", { payload: PAYLOADS.flow(), persisted: { selectedEntrypointId: userListDetail().entrypoint.id } });
    expect(h.container.querySelector(".flow-main .skeleton")).not.toBeNull();
    h.emit({ type: "flowDetail", data: userListDetail() });
    expect(h.container.querySelector(".flow-main .skeleton")).toBeNull();
  });
});

describe("stale", () => {
  it.each(VIEWS)("%s shows the stale banner with incremental update", (view) => {
    const h = openView(view, { locale: "zh-cn", analysis: state({ staleFiles: 3 }), payload: PAYLOADS[view]() });
    const banner = h.container.querySelector('[data-banner="stale"]') as HTMLElement;
    expect(banner.textContent).toContain("3 个文件已变化");
    fireEvent.click(within(banner).getByRole("button", { name: "增量更新" }));
    expect(h.lastSent("runCommand")).toEqual({ type: "runCommand", command: "atlas.analyzeIncremental" });
  });

  it("no banner when nothing changed", () => {
    const h = openView("overview", { payload: PAYLOADS.overview() });
    expect(h.container.querySelector('[data-banner="stale"]')).toBeNull();
    act(() => undefined);
  });
});
