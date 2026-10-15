/**
 * Thin wrapper over `acquireVsCodeApi()`.
 *
 * Inside VS Code the API may only be acquired once per webview, so this module
 * caches it. In a plain browser (Vite dev server, tests) `acquireVsCodeApi` is
 * absent and a fallback is used: state goes to sessionStorage and outgoing
 * messages are dispatched as a `atlas-dev:post` CustomEvent on `window`, which
 * the dev mock host (src/dev/mockHost.ts) listens to.
 */

import type { ViewId } from "@project-atlas/core";

/** Everything the panel restores after being hidden (retainContextWhenHidden=false). */
export interface PersistedState {
  tab: ViewId;
  selectedEntrypointId?: string;
  selectedModuleId?: string;
  filters: {
    flowSearch: string;
    flowMethod: string;
    moduleServiceId: string;
  };
  listView: Partial<Record<"topology" | "modules" | "history", boolean>>;
  collapsedBands: string[];
}

export const DEFAULT_STATE: PersistedState = {
  tab: "overview",
  filters: { flowSearch: "", flowMethod: "", moduleServiceId: "" },
  listView: {},
  collapsedBands: [],
};

export interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  // Injected by VS Code into webviews.
  // eslint-disable-next-line no-var
  var acquireVsCodeApi: (() => VsCodeApi) | undefined;
}

export const DEV_POST_EVENT = "atlas-dev:post";
const DEV_STATE_KEY = "atlas.webview.state";

function createDevApi(): VsCodeApi {
  return {
    postMessage(message) {
      window.dispatchEvent(new CustomEvent(DEV_POST_EVENT, { detail: message }));
    },
    getState() {
      try {
        const raw = window.sessionStorage.getItem(DEV_STATE_KEY);
        return raw ? (JSON.parse(raw) as unknown) : undefined;
      } catch {
        return undefined;
      }
    },
    setState(state) {
      try {
        window.sessionStorage.setItem(DEV_STATE_KEY, JSON.stringify(state));
      } catch {
        /* storage unavailable: state just isn't persisted */
      }
    },
  };
}

let cached: VsCodeApi | undefined;

export function getVsCodeApi(): VsCodeApi {
  if (cached) return cached;
  const acquire = typeof globalThis.acquireVsCodeApi === "function" ? globalThis.acquireVsCodeApi : undefined;
  cached = acquire ? acquire() : createDevApi();
  return cached;
}

/** Test hook: replace (or reset) the cached API. */
export function setVsCodeApiForTesting(api: VsCodeApi | undefined): void {
  cached = api;
}

const VIEW_IDS: readonly ViewId[] = ["overview", "topology", "modules", "features", "startup", "flow", "history"];

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/** Reads persisted state defensively: anything malformed falls back to defaults. */
export function loadState(api: VsCodeApi = getVsCodeApi()): PersistedState {
  const raw = api.getState();
  if (!raw || typeof raw !== "object") return structuredCloneState(DEFAULT_STATE);
  const r = raw as Record<string, unknown>;
  const filters = (r.filters && typeof r.filters === "object" ? r.filters : {}) as Record<string, unknown>;
  const listView = (r.listView && typeof r.listView === "object" ? r.listView : {}) as Record<string, unknown>;
  const state: PersistedState = {
    tab: VIEW_IDS.includes(r.tab as ViewId) ? (r.tab as ViewId) : "overview",
    filters: {
      flowSearch: str(filters.flowSearch),
      flowMethod: str(filters.flowMethod),
      moduleServiceId: str(filters.moduleServiceId),
    },
    listView: {},
    collapsedBands: Array.isArray(r.collapsedBands) ? r.collapsedBands.filter((x): x is string => typeof x === "string") : [],
  };
  for (const k of ["topology", "modules", "history"] as const) {
    if (typeof listView[k] === "boolean") state.listView[k] = listView[k];
  }
  if (typeof r.selectedEntrypointId === "string") state.selectedEntrypointId = r.selectedEntrypointId;
  if (typeof r.selectedModuleId === "string") state.selectedModuleId = r.selectedModuleId;
  return state;
}

export function saveState(state: PersistedState, api: VsCodeApi = getVsCodeApi()): void {
  api.setState(state);
}

function structuredCloneState(s: PersistedState): PersistedState {
  return JSON.parse(JSON.stringify(s)) as PersistedState;
}
