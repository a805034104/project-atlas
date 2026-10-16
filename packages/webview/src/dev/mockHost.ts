/**
 * Browser-only stand-in for the extension host. Answers the webview's
 * WebviewToHost messages with mock data and simulates a phased analysis so
 * loading skeletons, partial and stale states are all visible.
 *
 * Query parameters (index.dev.html):
 *   ?locale=en|zh-cn   ?ai=none|done   ?stale=N   ?status=never|error|done|running
 *   ?topology=0        ?tab=<view>&node=<id> (deep link via a reveal message)
 *   ?runtime=receiving|off|waiting|downloading|error|history|restricted (Trace tab state)
 *   ?theme=light|hc-dark|hc-light (default dark)   ?observed=1 (runtime overlay on GET /system/user/list)
 */

import type { AnalysisPhase, AnalysisState, HostToWebview, ViewId, WebviewToHost } from "@project-atlas/core";
import { DEV_POST_EVENT } from "../vscode.js";
import {
  doneState,
  featuresData,
  flowDetail,
  flowListData,
  historyData,
  modulesData,
  overviewData,
  startupData,
  topologyData,
  traceData,
  traceDetail,
  type RuntimeScenario,
} from "./mock.js";

const PHASES: AnalysisPhase[] = ["parse", "rules", "cross-service", "history", "ai"];

export function installMockHost(win: Window = window): () => void {
  const q = new URLSearchParams(win.location.search);
  const locale = q.get("locale") ?? "zh-cn";
  let aiEnabled = q.get("ai") !== "none";
  const statusParam = q.get("status") ?? "running";
  let state: AnalysisState;
  if (statusParam === "never") state = { status: "never", completedPhases: [], staleFiles: 0, ai: "none" };
  else if (statusParam === "error")
    state = {
      status: "error",
      completedPhases: ["parse"],
      staleFiles: 0,
      ai: "none",
      error: {
        code: "ATLAS-E001",
        problem: "git is not installed",
        cause: "`git --version` failed: ENOENT",
        fix: "Install git, or set atlas.git.path; the History view is degraded until then.",
        docsUrl: "https://github.com/project-atlas/project-atlas/blob/main/docs/errors.md#atlas-e001",
        fixCommand: "atlas.diagnose",
      },
    };
  else if (statusParam === "done") state = doneState({ ai: aiEnabled ? "done" : "none" });
  else state = { status: "running", completedPhases: [], currentPhase: "parse", progress: 0, staleFiles: 0, ai: aiEnabled ? "running" : "none" };
  state.staleFiles = Number(q.get("stale") ?? "0") || 0;

  const post = (m: HostToWebview) => win.postMessage(m, "*");
  const timers: number[] = [];
  const later = (ms: number, fn: () => void) => timers.push(win.setTimeout(fn, ms));

  const runAnalysis = () => {
    state = { status: "running", completedPhases: [], currentPhase: "parse", progress: 0, staleFiles: 0, ai: aiEnabled ? "running" : "none" };
    post({ type: "analysisState", state });
    PHASES.forEach((phase, i) => {
      later(500 * (i + 1), () => {
        if (phase === "ai" && !aiEnabled) {
          state = { ...state, status: "done", completedPhases: [...state.completedPhases, "ai"], ai: "none" };
          delete state.currentPhase;
          delete state.progress;
        } else {
          const completed = [...state.completedPhases, phase];
          const next = PHASES[i + 1];
          state = { ...state, completedPhases: completed, ...(next ? { currentPhase: next, progress: 0.3 } : {}) };
          if (!next) {
            state = { ...state, status: "done", ai: aiEnabled ? "done" : "none" };
            delete state.currentPhase;
            delete state.progress;
          }
        }
        post({ type: "analysisState", state });
      });
    });
  };

  const onMessage = (event: Event) => {
    const m = (event as CustomEvent<WebviewToHost>).detail;
    console.info("[mock host] ←", m);
    switch (m.type) {
      case "ready":
        post({ type: "init", locale, state, showTopology: q.get("topology") !== "0" });
        if (q.get("tab")) {
          const node = q.get("node");
          post({ type: "reveal", view: q.get("tab") as ViewId, ...(node ? { nodeId: node } : {}) });
        }
        if (state.status === "running") runAnalysis();
        break;
      case "requestView": {
        const withAi = aiEnabled && state.completedPhases.includes("ai");
        later(150, () => {
          switch (m.view) {
            case "overview":
              return post({ type: "viewData", payload: { view: "overview", data: overviewData(withAi) } });
            case "topology":
              return post({ type: "viewData", payload: { view: "topology", data: topologyData() } });
            case "modules":
              return post({ type: "viewData", payload: { view: "modules", data: modulesData() } });
            case "features":
              return post({ type: "viewData", payload: { view: "features", data: featuresData(withAi) } });
            case "startup":
              return post({ type: "viewData", payload: { view: "startup", data: startupData() } });
            case "flow":
              return post({ type: "viewData", payload: { view: "flow", data: flowListData() } });
            case "history":
              return post({ type: "viewData", payload: { view: "history", data: historyData() } });
            case "trace":
              return post({ type: "viewData", payload: { view: "trace", data: traceData(q.get("traces") !== "0", (q.get("runtime") as RuntimeScenario | null) ?? undefined) } });
          }
        });
        break;
      }
      case "requestFlow": {
        const detail = flowDetail(m.entrypointId, m.depth, q.get("observed") === "1");
        later(200, () => (detail ? post({ type: "flowDetail", data: detail }) : undefined));
        break;
      }
      case "copyText":
        void navigator.clipboard?.writeText(m.text).catch(() => undefined);
        break;
      case "runCommand":
        if (m.command === "atlas.configureProvider") {
          aiEnabled = true;
          runAnalysis();
        } else if (m.command === "atlas.analyze" || m.command === "atlas.analyzeIncremental") {
          runAnalysis();
        } else if (m.command === "atlas.cancel") {
          timers.splice(0).forEach((t) => win.clearTimeout(t));
          state = { ...state, status: "cancelled" };
          post({ type: "analysisState", state });
        }
        break;
      case "requestTrace": {
        const detail = traceDetail(m.traceId);
        later(100, () => (detail ? post({ type: "traceDetail", data: detail }) : undefined));
        break;
      }
      case "runtimeAction":
      case "openSource":
      case "markEdgeWrong":
        break;
    }
  };
  win.addEventListener(DEV_POST_EVENT, onMessage);
  return () => {
    win.removeEventListener(DEV_POST_EVENT, onMessage);
    timers.forEach((t) => win.clearTimeout(t));
  };
}
