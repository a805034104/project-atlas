/**
 * Webview application state: everything received from the host plus UI state
 * (tab, breadcrumbs, selections). Pure reducer so it is trivially testable.
 */

import { createContext, useContext } from "react";
import type {
  AnalysisPhase,
  AnalysisState,
  FlowDetailData,
  HostToWebview,
  RuntimeState,
  TraceDetailData,
  UserFacingError,
  ViewId,
  ViewPayload,
  WebviewToHost,
} from "@project-atlas/core";
import type { PersistedState } from "./vscode.js";

export type ViewDataMap = { [P in ViewPayload as P["view"]]: P["data"] };

/** The analysis phase a view needs before it can render (state matrix "loading"). */
export const VIEW_PHASE: Record<ViewId, AnalysisPhase> = {
  overview: "parse",
  topology: "cross-service",
  modules: "parse",
  features: "rules",
  startup: "parse",
  flow: "rules",
  history: "history",
  trace: "rules",
};

export const TAB_ORDER: readonly ViewId[] = ["overview", "topology", "modules", "features", "startup", "flow", "history", "trace"];

export interface Crumb {
  view: ViewId;
  nodeId?: string;
  label: string;
}

export interface AppState {
  locale: string;
  initialized: boolean;
  analysis: AnalysisState | undefined;
  showTopology: boolean;
  data: Partial<ViewDataMap>;
  /** completedPhases key at the time each view's data arrived (re-request when it changes). */
  dataKey: Partial<Record<ViewId, string>>;
  flowDetails: Record<string, FlowDetailData>;
  hostError: UserFacingError | undefined;
  persisted: PersistedState;
  crumbs: Crumb[];
  /** Node to highlight/focus after a deep link or reveal. */
  revealNodeId: string | undefined;
  selectedFeatureId: string | undefined;
  selectedServiceId: string | undefined;
  /** Local runtime capture state (v0.2). */
  runtime: RuntimeState | undefined;
  /** Bumped whenever observed stats change; part of every data cache key. */
  runtimeVersion: number;
  traceDetails: Record<string, TraceDetailData>;
  /** Flow view shows this one trace instead of aggregates (entered from the waterfall). */
  singleTrace: { traceId: string; entrypointId: string } | undefined;
}

export type Action =
  | { type: "host"; message: HostToWebview }
  | { type: "dismissError" }
  | { type: "persist"; patch: Partial<PersistedState> }
  | { type: "navigate"; view: ViewId; nodeId?: string | undefined; from?: Crumb }
  | { type: "back" }
  | { type: "selectFeature"; id: string | undefined }
  | { type: "selectService"; id: string | undefined }
  | { type: "singleTrace"; trace: { traceId: string; entrypointId: string } | undefined };

export function initialState(persisted: PersistedState): AppState {
  return {
    locale: "en",
    initialized: false,
    analysis: undefined,
    showTopology: false,
    data: {},
    dataKey: {},
    flowDetails: {},
    hostError: undefined,
    persisted,
    crumbs: [],
    revealNodeId: undefined,
    selectedFeatureId: undefined,
    selectedServiceId: undefined,
    runtime: undefined,
    runtimeVersion: 0,
    traceDetails: {},
    singleTrace: undefined,
  };
}

export function phasesKey(analysis: AnalysisState | undefined, runtimeVersion = 0): string {
  return analysis ? `${analysis.status}:${[...analysis.completedPhases].sort().join(",")}#${runtimeVersion}` : "";
}

function visibleTab(state: AppState, tab: ViewId): ViewId {
  return tab === "topology" && !state.showTopology ? "overview" : tab;
}

/** Applies a navigation target's node id to the selection that view uses. */
function select(state: AppState, view: ViewId, nodeId: string | undefined): AppState {
  if (nodeId === undefined) return state;
  switch (view) {
    case "flow":
      return { ...state, persisted: { ...state.persisted, selectedEntrypointId: nodeId } };
    case "modules":
    case "history":
      return { ...state, persisted: { ...state.persisted, selectedModuleId: nodeId } };
    case "features":
      return { ...state, selectedFeatureId: nodeId };
    case "topology":
      return { ...state, selectedServiceId: nodeId };
    default:
      return state;
  }
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "host": {
      const m = action.message;
      switch (m.type) {
        case "init": {
          const next: AppState = {
            ...state,
            initialized: true,
            locale: m.locale,
            analysis: m.state,
            showTopology: m.showTopology,
          };
          return { ...next, persisted: { ...next.persisted, tab: visibleTab(next, next.persisted.tab) } };
        }
        case "analysisState":
          return { ...state, analysis: m.state };
        case "viewData":
          return {
            ...state,
            data: { ...state.data, [m.payload.view]: m.payload.data },
            dataKey: { ...state.dataKey, [m.payload.view]: phasesKey(state.analysis, state.runtimeVersion) },
          };
        case "flowDetail":
          return { ...state, flowDetails: { ...state.flowDetails, [m.data.entrypoint.id]: m.data } };
        case "reveal": {
          const view = visibleTab(state, m.view);
          const from: Crumb | undefined =
            view !== state.persisted.tab ? { view: state.persisted.tab, label: "" } : undefined;
          const moved: AppState = {
            ...state,
            crumbs: from ? [...state.crumbs, from] : state.crumbs,
            persisted: { ...state.persisted, tab: view },
            revealNodeId: m.nodeId,
          };
          return select(moved, view, m.nodeId);
        }
        case "error":
          return { ...state, hostError: m.error };
        case "runtimeState":
          return { ...state, runtime: m.state };
        case "runtimeUpdated":
          // Observed stats changed: cached views and flows are stale (keys include the version).
          return { ...state, runtimeVersion: state.runtimeVersion + 1, flowDetails: {} };
        case "traceDetail":
          return { ...state, traceDetails: { ...state.traceDetails, [m.data.traceId]: m.data } };
        default:
          return state;
      }
    }
    case "dismissError":
      return { ...state, hostError: undefined };
    case "persist":
      return { ...state, persisted: { ...state.persisted, ...action.patch } };
    case "navigate": {
      const view = visibleTab(state, action.view);
      const moved: AppState = {
        ...state,
        crumbs: action.from ? [...state.crumbs, action.from] : state.crumbs,
        persisted: { ...state.persisted, tab: view },
        revealNodeId: action.nodeId,
      };
      return select(moved, view, action.nodeId);
    }
    case "back": {
      const last = state.crumbs[state.crumbs.length - 1];
      if (!last) return state;
      const moved: AppState = {
        ...state,
        crumbs: state.crumbs.slice(0, -1),
        persisted: { ...state.persisted, tab: last.view },
        revealNodeId: last.nodeId,
      };
      return select(moved, last.view, last.nodeId);
    }
    case "selectFeature":
      return { ...state, selectedFeatureId: action.id };
    case "selectService":
      return { ...state, selectedServiceId: action.id };
    case "singleTrace":
      return action.trace
        ? { ...state, singleTrace: action.trace, persisted: { ...state.persisted, tab: "flow", selectedEntrypointId: action.trace.entrypointId } }
        : { ...state, singleTrace: undefined };
    default:
      return state;
  }
}

export interface AppApi {
  state: AppState;
  send(message: WebviewToHost): void;
  dispatch(action: Action): void;
  /** Deep link: pushes the current location on the breadcrumb stack. */
  go(view: ViewId, nodeId?: string, fromLabel?: string): void;
}

export const AppContext = createContext<AppApi | null>(null);

export function useApp(): AppApi {
  const api = useContext(AppContext);
  if (!api) throw new Error("useApp outside <AppContext.Provider>");
  return api;
}
