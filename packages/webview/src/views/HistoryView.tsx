import { useMemo } from "react";
import type { HistoryData } from "@project-atlas/core";
import { useI18n } from "../i18n.js";
import { useApp } from "../state.js";
import { Banner, CopyButton, EmptyState, PlainText, ViewToggle } from "../components/common.js";
import { ViewFrame } from "../components/ViewFrame.js";

export const HEATMAP_WEEKS = 12;
const DAY = 86_400_000;

/** Monday 00:00 (local time) of the week containing `ms`. Display uses local time; storage is UTC. */
export function weekStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  return d.getTime() - dow * DAY;
}

function isoDay(ms: number): string {
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export interface Heatmap {
  weeks: number[];
  rows: { moduleId: string; name: string; counts: number[]; total: number }[];
  max: number;
}

export function buildHeatmap(data: HistoryData, weeksBack = HEATMAP_WEEKS): Heatmap {
  let latest = 0;
  for (const h of data.history) for (const c of h.commits) latest = Math.max(latest, Date.parse(c.authorTime));
  if (latest === 0) return { weeks: [], rows: [], max: 0 };
  const last = weekStart(latest);
  const weeks = Array.from({ length: weeksBack }, (_, i) => weekStart(last - (weeksBack - 1 - i) * 7 * DAY));
  const names = new Map(data.modules.map((m) => [m.id, m.name]));
  let max = 0;
  const rows = data.history.map((h) => {
    const counts = weeks.map(() => 0);
    for (const c of h.commits) {
      const idx = weeks.indexOf(weekStart(Date.parse(c.authorTime)));
      if (idx >= 0) counts[idx] = (counts[idx] ?? 0) + 1;
    }
    for (const n of counts) max = Math.max(max, n);
    return { moduleId: h.moduleId, name: names.get(h.moduleId) ?? h.moduleId, counts, total: h.commits.length };
  });
  rows.sort((a, b) => b.total - a.total);
  return { weeks, rows, max };
}

function level(n: number, max: number): number {
  if (n <= 0 || max <= 0) return 0;
  return Math.min(4, Math.ceil((n / max) * 4));
}

function HistoryBody({ data }: { data: HistoryData }) {
  const { t, lang } = useI18n();
  const { state, dispatch } = useApp();
  const heat = useMemo(() => buildHeatmap(data), [data]);
  const tableView = state.persisted.listView.history ?? false;
  const selectedId = state.persisted.selectedModuleId;
  const selected = data.history.find((h) => h.moduleId === selectedId);
  const select = (id: string) => dispatch({ type: "persist", patch: { selectedModuleId: id } });
  const dateLocale = lang === "zh" ? "zh-CN" : "en";

  const noGit = data.history.length > 0 && data.history.every((h) => h.degraded === "no-git");
  if (noGit) {
    return <EmptyState title={t("history.noGit.title")} body={t("history.noGit.body")} />;
  }
  const shallow = data.history.some((h) => h.degraded === "shallow");
  if (heat.rows.length === 0 || heat.weeks.length === 0) {
    return (
      <>
        {shallow ? (
          <Banner kind="info" action={<CopyButton text="git fetch --unshallow" label={t("history.shallowAction")} />}>
            {t("history.shallow")}
          </Banner>
        ) : null}
        <EmptyState title={t("history.empty.title")} body={t("history.empty.body")} />
      </>
    );
  }

  const weekLabel = (w: number) => isoDay(w);

  return (
    <div className="history">
      {shallow ? (
        <Banner kind="info" action={<CopyButton text="git fetch --unshallow" label={t("history.shallowAction")} />}>
          {t("history.shallow")}
        </Banner>
      ) : null}
      <div className="toolbar">
        <h2>{t("history.heatmap")}</h2>
        <ViewToggle
          listView={tableView}
          listLabel={t("history.tableView")}
          onChange={(v) => dispatch({ type: "persist", patch: { listView: { ...state.persisted.listView, history: v } } })}
        />
      </div>

      {tableView ? (
        <div className="table-scroll">
          <table className="data-table heat-table">
            <caption className="sr-only">{t("history.heatmap")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("col.name")}</th>
                {heat.weeks.map((w) => (
                  <th key={w} scope="col" className="num">
                    {weekLabel(w).slice(5)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {heat.rows.map((r) => (
                <tr key={r.moduleId} aria-selected={r.moduleId === selectedId}>
                  <th scope="row">
                    <button type="button" className="link code" onClick={() => select(r.moduleId)}>
                      {r.name}
                    </button>
                  </th>
                  {r.counts.map((n, i) => (
                    <td key={i} className="num">
                      {n}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div
          className="heatmap"
          role="group"
          aria-label={t("history.heatmap")}
          style={{ gridTemplateColumns: `minmax(8em, max-content) repeat(${heat.weeks.length}, minmax(14px, 1fr))` }}
        >
          <span />
          {heat.weeks.map((w, i) => (
            <span key={w} className="heat-week muted" aria-hidden="true">
              {i % 4 === 0 ? weekLabel(w).slice(5) : ""}
            </span>
          ))}
          {heat.rows.map((r) => (
            <HeatRow
              key={r.moduleId}
              row={r}
              weeks={heat.weeks}
              max={heat.max}
              selected={r.moduleId === selectedId}
              onSelect={() => select(r.moduleId)}
              label={(n, w) => t("history.cell", { module: r.name, week: weekLabel(w), n })}
            />
          ))}
        </div>
      )}

      <section className="timeline" aria-label={selected ? t("history.timeline", { module: selected.moduleId }) : undefined}>
        {selected ? (
          <>
            <h2>
              {t("history.timeline", {
                module: data.modules.find((m) => m.id === selected.moduleId)?.name ?? selected.moduleId,
              })}
            </h2>
            {selected.aiSummary ? (
              <div className="ai-summary">
                <h3 className="subtle">✨ {t("history.aiSummary")}</h3>
                <PlainText text={selected.aiSummary} />
              </div>
            ) : null}
            {selected.commits.length === 0 ? (
              <p className="muted">{t("history.noCommits")}</p>
            ) : (
              <ol className="commit-list">
                {[...selected.commits]
                  .sort((a, b) => Date.parse(b.authorTime) - Date.parse(a.authorTime))
                  .map((c) => (
                    <li key={c.sha}>
                      <time dateTime={c.authorTime} className="muted">
                        {new Date(c.authorTime).toLocaleString(dateLocale, { hour12: false })}
                      </time>{" "}
                      <span className="code">{c.sha.slice(0, 8)}</span> <span>{c.message.split("\n")[0]}</span>
                      <span className="muted">
                        {" "}
                        · {c.author} · +{c.added} −{c.deleted} · {t("history.files", { n: c.files.length })}
                      </span>
                    </li>
                  ))}
              </ol>
            )}
          </>
        ) : (
          <p className="muted">{t("history.pick")}</p>
        )}
      </section>
    </div>
  );
}

function HeatRow({
  row,
  weeks,
  max,
  selected,
  onSelect,
  label,
}: {
  row: Heatmap["rows"][number];
  weeks: number[];
  max: number;
  selected: boolean;
  onSelect(): void;
  label(n: number, week: number): string;
}) {
  return (
    <>
      <button
        type="button"
        className={`link code heat-row-label${selected ? " selected" : ""}`}
        aria-pressed={selected}
        onClick={onSelect}
      >
        {row.name}
      </button>
      {row.counts.map((n, i) => {
        const w = weeks[i] ?? 0;
        const text = label(n, w);
        return (
          <button
            key={i}
            type="button"
            tabIndex={-1}
            className={`heat-cell heat-${level(n, max)}`}
            title={text}
            aria-label={text}
            data-count={n}
            onClick={onSelect}
          />
        );
      })}
    </>
  );
}

export function HistoryView() {
  return (
    <ViewFrame view="history" aiAware>
      {(data) => <HistoryBody data={data} />}
    </ViewFrame>
  );
}
