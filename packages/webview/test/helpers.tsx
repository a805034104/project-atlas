import { act, render, type RenderResult } from "@testing-library/react";
import type { AnalysisState, HostToWebview, ViewId, ViewPayload, WebviewToHost } from "@project-atlas/core";
import { App } from "../src/App.js";
import type { Bridge, HostListener } from "../src/bridge.js";
import { DEFAULT_STATE, type PersistedState, type VsCodeApi } from "../src/vscode.js";

export interface Harness extends RenderResult {
  sent: WebviewToHost[];
  emit(message: HostToWebview): void;
  vscode: VsCodeApi & { state: unknown };
  lastSent<T extends WebviewToHost["type"]>(type: T): Extract<WebviewToHost, { type: T }> | undefined;
}

export function renderApp(persisted: Partial<PersistedState> = {}): Harness {
  const sent: WebviewToHost[] = [];
  const listeners = new Set<HostListener>();
  const bridge: Bridge = {
    send: (m) => sent.push(m),
    onMessage(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  const vscode = {
    state: { ...DEFAULT_STATE, ...persisted } as unknown,
    postMessage() {},
    getState() {
      return this.state;
    },
    setState(s: unknown) {
      this.state = s;
    },
  };
  const result = render(<App bridge={bridge} vscode={vscode} />);
  const emit = (message: HostToWebview) =>
    act(() => {
      for (const l of listeners) l(message);
    });
  return {
    ...result,
    sent,
    emit,
    vscode,
    lastSent(type) {
      for (let i = sent.length - 1; i >= 0; i--) {
        const m = sent[i];
        if (m && m.type === type) return m as Extract<WebviewToHost, { type: typeof type }>;
      }
      return undefined;
    },
  };
}

export function state(overrides: Partial<AnalysisState> = {}): AnalysisState {
  return {
    status: "done",
    completedPhases: ["parse", "rules", "cross-service", "history", "ai"],
    staleFiles: 0,
    ai: "done",
    ...overrides,
  };
}

/** Renders the app on `tab`, sends init and (optionally) the view's data. */
export function openView(
  tab: ViewId,
  opts: { analysis?: AnalysisState; locale?: string; payload?: ViewPayload; showTopology?: boolean; persisted?: Partial<PersistedState> } = {},
): Harness {
  const h = renderApp({ tab, ...opts.persisted });
  h.emit({ type: "init", locale: opts.locale ?? "en", state: opts.analysis ?? state(), showTopology: opts.showTopology ?? true });
  if (opts.payload) h.emit({ type: "viewData", payload: opts.payload });
  return h;
}
