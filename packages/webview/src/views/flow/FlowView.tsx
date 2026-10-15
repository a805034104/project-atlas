import { useEffect, useMemo, useRef } from "react";
import type { FlowDetailData, FlowListData } from "@project-atlas/core";
import { useI18n } from "../../i18n.js";
import { phasesKey, useApp } from "../../state.js";
import { EmptyState, Skeleton, SourceLink } from "../../components/common.js";
import { ViewFrame } from "../../components/ViewFrame.js";
import { useNarrow } from "../../useNarrow.js";
import { entrypointLabel } from "../FeaturesView.js";
import { EntrypointList, FlowFilters, filterEntrypoints } from "./EntrypointList.js";
import { Swimlane } from "./Swimlane.js";

export const DEFAULT_FLOW_DEPTH = 12;

function Unresolved({ detail }: { detail: FlowDetailData }) {
  const { t } = useI18n();
  const names = new Map(detail.steps.map((s) => [s.id, s.symbol.name]));
  return (
    <details className="unresolved" open={detail.unresolvedCalls.length > 0}>
      <summary>{t("flow.unresolved", { n: detail.unresolvedCalls.length })}</summary>
      {detail.unresolvedCalls.length === 0 ? (
        <p className="muted">{t("flow.unresolvedNone")}</p>
      ) : (
        <ul className="plain-list">
          {detail.unresolvedCalls.map((u, i) => (
            <li key={i}>
              <code>{u.expression}</code>
              <span className="muted">
                {" "}
                · {names.get(u.fromStepId) ?? u.fromStepId} · {t(`flow.reason.${u.reason}`)} ·{" "}
              </span>
              <SourceLink source={u.at} />
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function FlowBody({ data }: { data: FlowListData }) {
  const { t } = useI18n();
  const { state, dispatch, send } = useApp();
  const narrow = useNarrow();
  const { flowSearch, flowMethod } = state.persisted.filters;
  const selectedId = state.persisted.selectedEntrypointId;
  const filtered = useMemo(
    () => filterEntrypoints(data.entrypoints, flowSearch, flowMethod),
    [data.entrypoints, flowSearch, flowMethod],
  );
  const detail = selectedId !== undefined ? state.flowDetails[selectedId] : undefined;
  const depths = useRef(new Map<string, number>());
  const requested = useRef(new Map<string, string>());
  const key = phasesKey(state.analysis, state.runtimeVersion);

  useEffect(() => {
    if (selectedId === undefined || !data.entrypoints.some((e) => e.id === selectedId)) return;
    const reqKey = `${key}@${depths.current.get(selectedId) ?? DEFAULT_FLOW_DEPTH}`;
    if (detail && requested.current.get(selectedId) === undefined) requested.current.set(selectedId, reqKey);
    if (requested.current.get(selectedId) === reqKey) return;
    requested.current.set(selectedId, reqKey);
    const depth = depths.current.get(selectedId);
    send({ type: "requestFlow", entrypointId: selectedId, ...(depth !== undefined ? { depth } : {}) });
  }, [selectedId, key, data.entrypoints, detail, send]);

  if (data.entrypoints.length === 0) {
    return <EmptyState title={t("flow.empty.title")} body={t("flow.empty.body")} />;
  }

  const setFilters = (patch: Partial<typeof state.persisted.filters>) =>
    dispatch({ type: "persist", patch: { filters: { ...state.persisted.filters, ...patch } } });
  const select = (id: string) => dispatch({ type: "persist", patch: { selectedEntrypointId: id } });
  const loadMore = () => {
    if (selectedId === undefined) return;
    const depth = (depths.current.get(selectedId) ?? DEFAULT_FLOW_DEPTH) + DEFAULT_FLOW_DEPTH;
    depths.current.set(selectedId, depth);
    requested.current.set(selectedId, `${key}@${depth}`);
    send({ type: "requestFlow", entrypointId: selectedId, depth });
  };
  const selectedEp = data.entrypoints.find((e) => e.id === selectedId);
  const singleTrace = state.singleTrace && state.singleTrace.entrypointId === selectedId ? state.traceDetails[state.singleTrace.traceId] : undefined;

  return (
    <div className={`flow${narrow ? " narrow" : ""}`}>
      <div className="flow-side">
        <FlowFilters
          data={data}
          search={flowSearch}
          method={flowMethod}
          onSearch={(v) => setFilters({ flowSearch: v })}
          onMethod={(v) => setFilters({ flowMethod: v })}
        />
        {narrow ? (
          <select
            className="ep-select"
            aria-label={t("flow.entrypoint")}
            value={selectedId ?? ""}
            onChange={(e) => e.target.value && select(e.target.value)}
          >
            <option value="">{t("flow.pick")}</option>
            {data.services.map((s) => {
              const eps = filtered.filter((e) => e.serviceId === s.id);
              return eps.length === 0 ? null : (
                <optgroup key={s.id} label={s.name}>
                  {eps.map((e) => (
                    <option key={e.id} value={e.id}>
                      {entrypointLabel(e)}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </select>
        ) : (
          <EntrypointList data={data} filtered={filtered} selectedId={selectedId} onSelect={select} />
        )}
      </div>
      <div className="flow-main">
        {selectedEp === undefined ? (
          <p className="muted">{t("flow.pick")}</p>
        ) : !detail ? (
          <Skeleton rows={2} />
        ) : (
          <>
            <h2 className="flow-title">
              <span className="code">{entrypointLabel(selectedEp)}</span>{" "}
              <SourceLink source={selectedEp.handler} label={selectedEp.handler.name} />
              {detail.entrypoint.observed && !singleTrace ? (
                <span className="observed-summary" title={t("trace.windowAll")}>
                  {t("trace.observedSummary", { count: detail.entrypoint.observed.count, p50: detail.entrypoint.observed.p50Ms, p95: detail.entrypoint.observed.p95Ms })}
                </span>
              ) : null}
            </h2>
            {singleTrace ? (
              <div className="banner banner-info" role="status" data-mode="single-trace">
                <span>
                  {t("trace.singleBanner", { id: singleTrace.traceId.slice(0, 8), time: new Date(singleTrace.start).toLocaleTimeString() })}
                </span>
                <button type="button" className="secondary" onClick={() => dispatch({ type: "singleTrace", trace: undefined })}>
                  {t("trace.exitSingle")}
                </button>
              </div>
            ) : null}
            <Swimlane
              detail={detail}
              vertical={narrow}
              depth={depths.current.get(selectedEp.id) ?? DEFAULT_FLOW_DEPTH}
              onLoadMore={loadMore}
              trace={singleTrace}
            />
            <Unresolved detail={detail} />
          </>
        )}
      </div>
    </div>
  );
}

export function FlowView() {
  return <ViewFrame view="flow">{(data) => <FlowBody data={data} />}</ViewFrame>;
}
