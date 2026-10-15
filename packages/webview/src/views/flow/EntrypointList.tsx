import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Entrypoint, FlowListData } from "@project-atlas/core";
import { useI18n } from "../../i18n.js";
import { entrypointLabel } from "../FeaturesView.js";

export const ROW_H = 26;
const OVERSCAN = 8;
const DEFAULT_VIEWPORT = 640;

type Row = { kind: "header"; serviceId: string; name: string; count: number } | { kind: "item"; ep: Entrypoint };

export function filterEntrypoints(entrypoints: Entrypoint[], search: string, method: string): Entrypoint[] {
  const q = search.trim().toLowerCase();
  return entrypoints.filter((ep) => {
    if (method && (ep.method ?? "").toUpperCase() !== method) return false;
    if (!q) return true;
    return (
      entrypointLabel(ep).toLowerCase().includes(q) ||
      ep.handler.name.toLowerCase().includes(q) ||
      ep.handler.fqn.toLowerCase().includes(q)
    );
  });
}

function groupRows(data: FlowListData, filtered: Entrypoint[]): Row[] {
  const rows: Row[] = [];
  const known = new Set<string>();
  const services = [...data.services];
  for (const ep of filtered) {
    if (!services.some((s) => s.id === ep.serviceId) && !known.has(ep.serviceId)) {
      known.add(ep.serviceId);
      services.push({ id: ep.serviceId, name: ep.serviceId });
    }
  }
  for (const s of services) {
    const eps = filtered
      .filter((e) => e.serviceId === s.id)
      .sort((a, b) => (a.path ?? "").localeCompare(b.path ?? "") || (a.method ?? "").localeCompare(b.method ?? ""));
    if (eps.length === 0) continue;
    rows.push({ kind: "header", serviceId: s.id, name: s.name, count: eps.length });
    for (const ep of eps) rows.push({ kind: "item", ep });
  }
  return rows;
}

export function methodsOf(entrypoints: Entrypoint[]): string[] {
  return [...new Set(entrypoints.map((e) => (e.method ?? "").toUpperCase()).filter(Boolean))].sort();
}

export function FlowFilters({
  data,
  search,
  method,
  onSearch,
  onMethod,
}: {
  data: FlowListData;
  search: string;
  method: string;
  onSearch(v: string): void;
  onMethod(v: string): void;
}) {
  const { t } = useI18n();
  const methods = useMemo(() => methodsOf(data.entrypoints), [data.entrypoints]);
  return (
    <div className="flow-filters">
      <input
        type="search"
        data-search
        aria-label={t("flow.search")}
        placeholder={t("flow.search")}
        value={search}
        onChange={(e) => onSearch(e.target.value)}
      />
      <select aria-label={t("flow.method")} value={method} onChange={(e) => onMethod(e.target.value)}>
        <option value="">{t("flow.allMethods")}</option>
        {methods.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Grouped, windowed entrypoint listbox (fixed row height; only visible rows are in the DOM). */
export function EntrypointList({
  data,
  filtered,
  selectedId,
  onSelect,
}: {
  data: FlowListData;
  filtered: Entrypoint[];
  selectedId: string | undefined;
  onSelect(id: string): void;
}) {
  const { t } = useI18n();
  const rows = useMemo(() => groupRows(data, filtered), [data, filtered]);
  const items = useMemo(() => rows.flatMap((r, i) => (r.kind === "item" ? [{ id: r.ep.id, row: i }] : [])), [rows]);
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(DEFAULT_VIEWPORT);
  const [activeId, setActiveId] = useState<string | undefined>(selectedId);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const height = el.clientHeight > 0 ? el.clientHeight : DEFAULT_VIEWPORT;
    if (el.clientHeight > 0) setViewport(el.clientHeight);
    // Bring a restored / deep-linked selection into view.
    const row = items.find((i) => i.id === selectedId)?.row;
    if (row !== undefined && row * ROW_H > height - ROW_H) {
      el.scrollTop = Math.max(0, row * ROW_H - height / 3);
      setScrollTop(el.scrollTop);
    }
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const active = activeId !== undefined && items.some((i) => i.id === activeId) ? activeId : (selectedId ?? items[0]?.id);

  const ensureVisible = (row: number) => {
    const el = scroller.current;
    if (!el) return;
    const top = row * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + viewport) el.scrollTop = top + ROW_H - viewport;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = items.findIndex((i) => i.id === active);
    let next = idx;
    if (e.key === "ArrowDown") next = Math.min(items.length - 1, idx + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, idx - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (active !== undefined) onSelect(active);
      return;
    } else return;
    e.preventDefault();
    const item = items[next];
    if (item) {
      setActiveId(item.id);
      ensureVisible(item.row);
    }
  };

  if (filtered.length === 0) return <p className="muted">{t("flow.noMatch")}</p>;

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewport) / ROW_H) + OVERSCAN);

  return (
    <div
      ref={scroller}
      className="ep-list"
      role="listbox"
      tabIndex={0}
      aria-label={t("flow.entrypoint")}
      aria-activedescendant={active !== undefined ? `ep-${active}` : undefined}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
    >
      <div style={{ height: rows.length * ROW_H, position: "relative" }}>
        {rows.slice(first, last).map((r, i) => {
          const top = (first + i) * ROW_H;
          if (r.kind === "header") {
            return (
              <div key={`h-${r.serviceId}`} className="ep-group" role="presentation" style={{ top, height: ROW_H }}>
                <span className="code">{r.name}</span> <span className="muted">{r.count}</span>
              </div>
            );
          }
          const sel = r.ep.id === selectedId;
          return (
            <div
              key={r.ep.id}
              id={`ep-${r.ep.id}`}
              role="option"
              aria-selected={sel}
              className={`ep-item${sel ? " selected" : ""}${r.ep.id === active ? " active" : ""}`}
              style={{ top, height: ROW_H }}
              title={r.ep.handler.fqn}
              onClick={() => {
                setActiveId(r.ep.id);
                onSelect(r.ep.id);
              }}
            >
              {r.ep.method ? <span className="method code">{r.ep.method}</span> : null}
              <span className="code">{r.ep.path ?? r.ep.handler.name}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
