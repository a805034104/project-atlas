import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent } from "react";
import type { ViewId, WebviewToHost } from "@project-atlas/core";
import type { Bridge } from "./bridge.js";
import { I18nContext, langFor, makeT } from "./i18n.js";
import {
  AppContext,
  initialState,
  phasesKey,
  reducer,
  TAB_ORDER,
  type AppApi,
  type Crumb,
} from "./state.js";
import { loadState, saveState, type VsCodeApi } from "./vscode.js";
import { Banner, CommandButton, ErrorPanel } from "./components/common.js";
import { Legend } from "./components/Legend.js";
import { viewReady } from "./components/ViewFrame.js";
import { OverviewView } from "./views/OverviewView.js";
import { TopologyView } from "./views/TopologyView.js";
import { ModulesView } from "./views/ModulesView.js";
import { FeaturesView } from "./views/FeaturesView.js";
import { StartupView } from "./views/StartupView.js";
import { FlowView } from "./views/flow/FlowView.js";
import { HistoryView } from "./views/HistoryView.js";

const VIEWS: Record<ViewId, () => JSX.Element> = {
  overview: OverviewView,
  topology: TopologyView,
  modules: ModulesView,
  features: FeaturesView,
  startup: StartupView,
  flow: FlowView,
  history: HistoryView,
};

export function App({ bridge, vscode }: { bridge: Bridge; vscode: VsCodeApi }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => initialState(loadState(vscode)));
  const [legendOpen, setLegendOpen] = useState(false);
  const i18n = useMemo(() => {
    const lang = langFor(state.locale);
    return { lang, t: makeT(lang) };
  }, [state.locale]);
  const { t } = i18n;

  const send = useCallback((m: WebviewToHost) => bridge.send(m), [bridge]);

  // Host messages + ready handshake.
  useEffect(() => {
    const off = bridge.onMessage((message) => dispatch({ type: "host", message }));
    bridge.send({ type: "ready" });
    return off;
  }, [bridge]);

  // Persist tab / selections / filters (retainContextWhenHidden=false).
  useEffect(() => {
    saveState(state.persisted, vscode);
  }, [state.persisted, vscode]);

  const tab = state.persisted.tab;
  const tabs = TAB_ORDER.filter((v) => v !== "topology" || state.showTopology);

  // Request the active view's data when its phase completes (and again when phases change).
  const requested = useRef(new Map<ViewId, string>());
  const key = phasesKey(state.analysis);
  useEffect(() => {
    if (!state.initialized || !viewReady(tab, state.analysis)) return;
    if (state.data[tab] !== undefined && state.dataKey[tab] === key) return;
    if (requested.current.get(tab) === key) return;
    requested.current.set(tab, key);
    send({ type: "requestView", view: tab });
  }, [tab, key, state.initialized, state.analysis, state.data, state.dataKey, send]);

  const currentCrumb = useCallback(
    (label?: string): Crumb => {
      const nodeId =
        tab === "flow"
          ? state.persisted.selectedEntrypointId
          : tab === "modules" || tab === "history"
            ? state.persisted.selectedModuleId
            : tab === "features"
              ? state.selectedFeatureId
              : tab === "topology"
                ? state.selectedServiceId
                : undefined;
      return { view: tab, ...(nodeId !== undefined ? { nodeId } : {}), label: label ?? "" };
    },
    [tab, state.persisted, state.selectedFeatureId, state.selectedServiceId],
  );

  const api: AppApi = useMemo(
    () => ({
      state,
      send,
      dispatch,
      go(view, nodeId, fromLabel) {
        dispatch({ type: "navigate", view, nodeId, from: currentCrumb(fromLabel) });
      },
    }),
    [state, send, currentCrumb],
  );

  // "/" focuses the active view's search field.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
      const search = document.querySelector<HTMLInputElement>(".tabpanel [data-search]");
      if (search) {
        e.preventDefault();
        search.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const tabRefs = useRef(new Map<ViewId, HTMLButtonElement>());
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = tabs.indexOf(tab);
    let next: ViewId | undefined;
    if (e.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
    else if (e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
    else if (e.key === "Home") next = tabs[0];
    else if (e.key === "End") next = tabs[tabs.length - 1];
    if (next === undefined) return;
    e.preventDefault();
    dispatch({ type: "persist", patch: { tab: next } });
    tabRefs.current.get(next)?.focus();
  };

  const View = VIEWS[tab];
  const stale = state.analysis?.staleFiles ?? 0;

  return (
    <I18nContext.Provider value={i18n}>
      <AppContext.Provider value={api}>
        <div className="atlas" lang={i18n.lang === "zh" ? "zh-CN" : "en"}>
          <header className="topbar">
            <div role="tablist" aria-label={t("app.tablist")} className="tabs">
              {tabs.map((v) => (
                <button
                  key={v}
                  ref={(el) => {
                    if (el) tabRefs.current.set(v, el);
                    else tabRefs.current.delete(v);
                  }}
                  type="button"
                  role="tab"
                  id={`tab-${v}`}
                  aria-selected={v === tab}
                  aria-controls={`panel-${v}`}
                  tabIndex={v === tab ? 0 : -1}
                  className="tab"
                  onClick={() => dispatch({ type: "persist", patch: { tab: v } })}
                  onKeyDown={onTabKey}
                >
                  {t(`tab.${v}`)}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="secondary small legend-button"
              aria-expanded={legendOpen}
              aria-label={t("legend.button")}
              title={t("legend.button")}
              onClick={() => setLegendOpen((o) => !o)}
            >
              ⓘ {t("legend.button")}
            </button>
          </header>
          {legendOpen ? <Legend onClose={() => setLegendOpen(false)} /> : null}

          {state.crumbs.length > 0 ? (
            <nav className="breadcrumb" aria-label={t("nav.breadcrumb")}>
              <button type="button" className="secondary small" onClick={() => dispatch({ type: "back" })}>
                {t("nav.back")}
              </button>
              <ol>
                {state.crumbs.map((c, i) => (
                  <li key={i}>{c.label || t(`tab.${c.view}`)}</li>
                ))}
                <li aria-current="page">{t(`tab.${tab}`)}</li>
              </ol>
            </nav>
          ) : null}

          {stale > 0 ? (
            <Banner
              kind="stale"
              action={<CommandButton command="atlas.analyzeIncremental">{t("banner.staleAction")}</CommandButton>}
            >
              {t("banner.stale", { n: stale })}
            </Banner>
          ) : null}
          {state.hostError ? (
            <ErrorPanel error={state.hostError} onDismiss={() => dispatch({ type: "dismissError" })} />
          ) : null}

          <main className="tabpanel" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
            <View />
          </main>
        </div>
      </AppContext.Provider>
    </I18nContext.Provider>
  );
}
