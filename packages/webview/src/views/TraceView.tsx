import { useEffect, useMemo, useRef, useState } from "react";
import type { TraceData, TraceDetailData, TraceRow } from "@project-atlas/core";
import { useI18n } from "../i18n.js";
import { useApp } from "../state.js";
import { CommandButton, CopyButton, EmptyState, ErrorPanel } from "../components/common.js";
import { ViewFrame } from "../components/ViewFrame.js";

/**
 * Trace tab (v0.2 U1):
 *   status line ─ receiver port · spans · rejected
 *   empty       ─ copy VM options (primary) / launch with tracing + a request that needs no login
 *   list        ─ newest first, absolute local time; live inserts never move the selection ("N new ↑")
 *   waterfall   ─ one row per span, layer badge, "no static step" rows, click → flow in single-trace mode
 *   diff        ─ static vs observed: observed entrypoints, runtime-only calls, unmatched span keys
 */

function time(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour12: false });
}

function StatusLine({ data }: { data: TraceData }) {
  const { t } = useI18n();
  const { state } = useApp();
  const r = state.runtime ?? data.runtime;
  const label = t(`trace.status.${r.status}`);
  return (
    <p className="trace-status" role="status">
      <span className={`dot dot-${r.status}`} aria-hidden="true" /> {label}
      {r.port ? <span className="code"> · 127.0.0.1:{r.port}</span> : null}
      {r.spans > 0 ? <span> · {t("trace.spans", { n: r.spans })}</span> : null}
      {r.rejected > 0 ? <span className="warn"> · {t("trace.rejected", { n: r.rejected })}</span> : null}
      {r.agent ? (
        <span>
          {" "}
          · {t("trace.agentDownload", { source: r.agent.source, mb: (r.agent.received / 1e6).toFixed(1), total: r.agent.total ? (r.agent.total / 1e6).toFixed(1) : "?" })}
        </span>
      ) : null}
      {r.status === "receiving" || r.status === "waiting" ? (
        <CommandButton command="atlas.runtime.stop">{t("trace.stop")}</CommandButton>
      ) : null}
    </p>
  );
}

function StartActions({ data }: { data: TraceData }) {
  const { t } = useI18n();
  const { send, state } = useApp();
  const trusted = (state.runtime ?? data.runtime).trusted;
  if (!trusted) return <p className="muted">{t("trace.restricted")}</p>;
  const one = data.services.length === 1 ? data.services[0] : undefined;
  return (
    <div className="trace-actions">
      <button type="button" className="primary" onClick={() => send({ type: "runtimeAction", action: "copyVmOptions", ...(one ? { serviceId: one.id } : {}) })}>
        {t("trace.copyVm")}
      </button>
      <button type="button" className="secondary" onClick={() => send({ type: "runtimeAction", action: "launch", ...(one ? { serviceId: one.id } : {}) })}>
        {t("trace.launch")}
      </button>
    </div>
  );
}

function Waterfall({ detail, row }: { detail: TraceDetailData; row: TraceRow }) {
  const { t } = useI18n();
  const { dispatch, send } = useApp();
  const total = Math.max(1, ...detail.spans.map((s) => s.offsetMs + s.durationMs));
  const depth = useMemo(() => {
    const parent = new Map(detail.spans.map((s) => [s.spanId, s.parentSpanId]));
    const d = new Map<string, number>();
    const of = (id: string, guard = 0): number => {
      const cached = d.get(id);
      if (cached !== undefined) return cached;
      const p = parent.get(id);
      const v = p && parent.has(p) && guard < 32 ? of(p, guard + 1) + 1 : 0;
      d.set(id, v);
      return v;
    };
    for (const s of detail.spans) of(s.spanId);
    return d;
  }, [detail]);
  const entrypointId = row.entrypointId ?? detail.entrypointId;
  return (
    <section className="waterfall" aria-label={t("trace.waterfall", { id: detail.traceId.slice(0, 8) })}>
      <header className="waterfall-head">
        <h3 className="subtle">
          {t("trace.waterfall", { id: detail.traceId.slice(0, 8) })} · {time(detail.start)}
        </h3>
        {entrypointId ? (
          <button type="button" className="secondary" onClick={() => dispatch({ type: "singleTrace", trace: { traceId: detail.traceId, entrypointId } })}>
            {t("trace.openInFlow")}
          </button>
        ) : null}
        <CopyButton text={detail.traceId} label={t("trace.copyId")} />
      </header>
      <ol className="waterfall-rows">
        {detail.spans.map((s) => (
          <li key={s.spanId} className={`waterfall-row${s.stepId ? "" : " unmatched"}${s.error ? " error" : ""}`}>
            <span className="waterfall-name" style={{ paddingLeft: `${(depth.get(s.spanId) ?? 0) * 12}px` }}>
              <span className={`layer-badge layer-${s.layer ?? "none"}`}>{s.layer ? t(`layer.${s.layer}` as Parameters<typeof t>[0]) : t("trace.noStep")}</span>{" "}
              <span className="code">{s.name}</span>
              {s.async ? <span className="badge" title={t("trace.async")}>⇢</span> : null}
              {s.stepId ? (
                <button type="button" className="link" onClick={() => entrypointId && dispatch({ type: "singleTrace", trace: { traceId: detail.traceId, entrypointId } })} aria-label={t("trace.locate", { name: s.name })}>
                  ⌖
                </button>
              ) : null}
            </span>
            <span className="waterfall-bar-track" aria-hidden="true">
              <span className="waterfall-bar" style={{ left: `${(s.offsetMs / total) * 100}%`, width: `${Math.max(0.5, (s.durationMs / total) * 100)}%` }} />
            </span>
            <span className="waterfall-ms">{s.durationMs} ms</span>
          </li>
        ))}
      </ol>
      <p className="muted small">
        {t("trace.privacy")} <button type="button" className="link" onClick={() => send({ type: "runCommand", command: "atlas.runtime.clear" })}>{t("trace.clear")}</button>
      </p>
    </section>
  );
}

function Diff({ data }: { data: TraceData }) {
  const { t } = useI18n();
  const d = data.diff;
  if (d.observedEntrypoints === 0 && d.runtimeOnly.length === 0) return null;
  return (
    <section className="trace-diff" aria-labelledby="trace-diff">
      <h3 id="trace-diff" className="subtle">{t("trace.diff")}</h3>
      <p>{t("trace.diffObserved", { n: d.observedEntrypoints, total: d.totalEntrypoints })}</p>
      {d.links.total > 0 ? <p>{t("trace.diffLinks", { n: d.links.observed, total: d.links.total })}</p> : null}
      {d.runtimeLinks.length > 0 ? (
        <>
          <p className="muted">{t("trace.runtimeLinksHelp")}</p>
          <ul className="plain-list">
            {d.runtimeLinks.map((l, i) => (
              <li key={i}>
                <span className="code">{l.fromService}</span> → <span className="code">{l.toService}</span>
                <span className="muted"> · {l.kind} {l.channel} · {l.count}×</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {d.runtimeOnly.length > 0 ? (
        <>
          <p className="muted">{t("trace.runtimeOnlyHelp")}</p>
          <ul className="plain-list">
            {d.runtimeOnly.slice(0, 20).map((r, i) => (
              <li key={i}>
                <span className="code">{r.from}</span> {r.drawn ? "→" : "⇝"} <span className="code">{r.to}</span>
                <span className="muted"> · {r.count}×{r.async ? ` · ${t("trace.async")}` : ""} · {r.drawn ? t("trace.drawn") : t("trace.reachable")}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {d.unmatched.length > 0 ? (
        <details>
          <summary>{t("trace.unmatched", { n: d.unmatched.length })}</summary>
          <ul className="plain-list">
            {d.unmatched.slice(0, 30).map((u) => (
              <li key={u.key} className="code">
                {u.key} <span className="muted">· {u.count}× · {u.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function TraceBody({ data }: { data: TraceData }) {
  const { t } = useI18n();
  const { state, send, dispatch } = useApp();
  const [selected, setSelected] = useState<string | undefined>(data.traces[0]?.traceId);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const seen = useRef(new Set(data.traces.map((r) => r.traceId)));
  const [frozen, setFrozen] = useState<TraceRow[]>(data.traces);
  const fresh = data.traces.filter((r) => !seen.current.has(r.traceId)).length;
  // Keep the visible list stable while the user is looking at a trace; new rows wait behind "N new ↑".
  useEffect(() => {
    if (selected === undefined || frozen.length === 0) {
      setFrozen(data.traces);
      for (const r of data.traces) seen.current.add(r.traceId);
    }
  }, [data.traces, selected, frozen.length]);
  const rows = (frozen.length > 0 ? frozen : data.traces).filter((r) => !errorsOnly || r.error);
  const row = rows.find((r) => r.traceId === selected);
  const detail = selected ? state.traceDetails[selected] : undefined;
  useEffect(() => {
    if (selected && !state.traceDetails[selected]) send({ type: "requestTrace", traceId: selected });
  }, [selected, state.traceDetails, send]);
  const runtime = state.runtime ?? data.runtime;

  if (data.traces.length === 0) {
    // Off or failed: nothing is receiving, so "waiting for the first request" would mislead.
    const idle = runtime.status === "off" || runtime.status === "error";
    return (
      <div className="trace">
        <StatusLine data={data} />
        {runtime.error ? <ErrorPanel error={runtime.error} /> : null}
        <EmptyState title={idle ? t("trace.empty.title") : t("trace.waiting.title")} action={<StartActions data={data} />}>
          <p className="muted">{idle ? t("trace.empty.body") : t("trace.waiting.body")}</p>
          {data.suggestedRequest ? (
            <p>
              <code className="command">curl {data.suggestedRequest.url}</code> <CopyButton text={`curl ${data.suggestedRequest.url}`} />
            </p>
          ) : null}
          <p className="muted small">{t("trace.cli")}</p>
          <p>
            <code className="command">project-atlas trace -- mvn spring-boot:run</code> <CopyButton text="project-atlas trace -- mvn spring-boot:run" />
          </p>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="trace">
      <StatusLine data={data} />
      {runtime.error ? <ErrorPanel error={runtime.error} /> : null}
      <div className="trace-toolbar">
        <label>
          <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} /> {t("trace.errorsOnly")}
        </label>
        {fresh > 0 ? (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setFrozen(data.traces);
              for (const r of data.traces) seen.current.add(r.traceId);
            }}
          >
            {t("trace.newRows", { n: fresh })}
          </button>
        ) : null}
        {runtime.status === "off" ? <StartActions data={data} /> : null}
      </div>
      <table className="trace-table">
        <thead>
          <tr>
            <th>{t("trace.col.time")}</th>
            <th>{t("trace.col.request")}</th>
            <th>{t("trace.col.services")}</th>
            <th className="num">{t("trace.col.duration")}</th>
            <th className="num">{t("trace.col.spans")}</th>
            <th className="num">{t("trace.col.coverage")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.traceId}
              className={`${r.traceId === selected ? "selected" : ""}${r.error ? " error" : ""}`}
              tabIndex={0}
              aria-selected={r.traceId === selected}
              onClick={() => setSelected(r.traceId)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setSelected(r.traceId);
              }}
            >
              <td>{time(r.start)}</td>
              <td className="code">
                {r.rootName ?? t("trace.noRoot")}
                {r.error ? <span className="badge badge-error"> ⚠</span> : null}
              </td>
              <td>{r.services.join(", ")}</td>
              <td className="num">{r.durationMs} ms</td>
              <td className="num">{r.spans}</td>
              <td className="num">{r.coverage ? `${Math.round((r.coverage.observed / Math.max(1, r.coverage.instrumentable)) * 100)}%` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {row && detail ? <Waterfall detail={detail} row={row} /> : row ? <p className="muted">{t("common.loading")}</p> : null}
      <Diff data={data} />
      {state.singleTrace ? (
        <button type="button" className="link" onClick={() => dispatch({ type: "singleTrace", trace: undefined })}>
          {t("trace.exitSingle")}
        </button>
      ) : null}
    </div>
  );
}

export function TraceView() {
  return <ViewFrame view="trace">{(data) => <TraceBody data={data} />}</ViewFrame>;
}
