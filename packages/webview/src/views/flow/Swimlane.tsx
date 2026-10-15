import { useMemo, useState, type MouseEvent } from "react";
import type { CallEdge, FlowDetailData, TraceDetailData } from "@project-atlas/core";
import { useI18n, type Translate } from "../../i18n.js";
import { useApp } from "../../state.js";
import { PROVENANCE_MARK } from "../../components/Legend.js";
import { useGraphNav } from "../../components/useGraphNav.js";
import { buildSwimlane, type LaneEdge, type LaneNode, type SwimlaneModel } from "./model.js";

const LABEL_W = 120;
const COL_W = 176;
const NODE_W = 156;
const NODE_H = 36;
const ROW_H = 52;
const BAND_H = 30;

export function edgeMark(edge: CallEdge, t: Translate): string {
  const mark = PROVENANCE_MARK[edge.provenance];
  if (edge.provenance === "ai-inferred") return `${mark} ${Math.round(edge.confidence * 100)}%`;
  if (edge.observed) {
    const errors = edge.observed.errorCount > 0 ? ` ⚠ ${edge.observed.errorCount}/${edge.observed.count}` : "";
    return `${mark} ${edge.observed.count}× · p95 ${edge.observed.p95Ms}ms${errors}`;
  }
  void t;
  return mark;
}

export function edgeText(e: LaneEdge, t: Translate): string {
  const parts = [edgeMark(e.edge, t)];
  if (e.branch?.first) parts.push(t("flow.branch", { n: e.branch.count }));
  if (e.back) parts.push(`↺ ${t("flow.recursion")}`);
  return parts.join(" · ");
}

function provText(edge: CallEdge, t: Translate): string {
  return t(`prov.${edge.provenance}`, { pct: `${Math.round(edge.confidence * 100)}%` });
}

function nodeAria(n: LaneNode, outgoing: number, t: Translate): string {
  if (!n.layer) return t("flow.band", { service: n.label, n: outgoing });
  return t("graph.nodeLabel", {
    name: n.label,
    kind: t("layer.suffix", { layer: t(`layer.${n.layer}`) }),
    n: outgoing,
  });
}

interface Geometry {
  bandTop: number[];
  height: number;
  width: number;
  pos: Map<string, { x: number; y: number }>;
}

function geometry(model: SwimlaneModel): Geometry {
  const bandTop: number[] = [];
  let y = 0;
  for (const b of model.bands) {
    bandTop.push(y);
    y += BAND_H + b.lanes.length * ROW_H;
  }
  const pos = new Map<string, { x: number; y: number }>();
  for (const n of model.nodes) {
    const top = (bandTop[n.band] ?? 0) + BAND_H + n.lane * ROW_H + (ROW_H - NODE_H) / 2;
    pos.set(n.id, { x: LABEL_W + n.col * COL_W, y: top });
  }
  return { bandTop, height: y, width: LABEL_W + Math.max(1, model.columns) * COL_W, pos };
}

function edgePath(a: { x: number; y: number }, b: { x: number; y: number }, back: boolean): { d: string; mx: number; my: number } {
  if (back) {
    // Recursion: leave from the bottom of the caller, arc below, enter the bottom of the callee.
    const x1 = a.x + NODE_W / 2;
    const y1 = a.y + NODE_H;
    const x2 = b.x + NODE_W / 2;
    const y2 = b.y + NODE_H;
    const dip = Math.max(y1, y2) + 14;
    return { d: `M${x1},${y1} C${x1},${dip} ${x2},${dip} ${x2},${y2}`, mx: (x1 + x2) / 2, my: dip - 4 };
  }
  const x1 = a.x + NODE_W;
  const y1 = a.y + NODE_H / 2;
  const x2 = b.x;
  const y2 = b.y + NODE_H / 2;
  const c = Math.max(24, (x2 - x1) / 2);
  return { d: `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 };
}

export function Swimlane({
  detail,
  vertical,
  onLoadMore,
  depth,
  trace,
}: {
  detail: FlowDetailData;
  vertical: boolean;
  onLoadMore(): void;
  depth: number;
  /** Single-trace mode (from the Trace tab waterfall). */
  trace?: TraceDetailData | undefined;
}) {
  const { t } = useI18n();
  const { state, dispatch, send } = useApp();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // Single-trace mode: this trace's own durations per step; everything else is dimmed.
  const traceSteps = useMemo(() => {
    if (!trace) return undefined;
    const m = new Map<string, number>();
    for (const s of trace.spans) if (s.stepId) m.set(s.stepId, Math.max(m.get(s.stepId) ?? 0, s.durationMs));
    return m;
  }, [trace]);
  const [menu, setMenu] = useState<{ edge: LaneEdge; x: number; y: number } | undefined>();
  const collapsedBands = useMemo(() => new Set(state.persisted.collapsedBands), [state.persisted.collapsedBands]);
  const model = useMemo(
    () => buildSwimlane(detail, { expandedBranches: expanded, collapsedBands }),
    [detail, expanded, collapsedBands],
  );
  const geo = useMemo(() => geometry(model), [model]);
  const nodeIds = useMemo(() => model.nodes.map((n) => n.id), [model]);
  const navEdges = useMemo(() => model.edges.filter((e) => !e.back), [model]);
  const names = useMemo(() => new Map(model.nodes.map((n) => [n.id, n.label])), [model]);
  const outCount = (id: string) => model.edges.filter((e) => e.from === id).length;

  const toggleBand = (serviceId: string) => {
    const next = new Set(collapsedBands);
    if (next.has(serviceId)) next.delete(serviceId);
    else next.add(serviceId);
    dispatch({ type: "persist", patch: { collapsedBands: [...next] } });
  };
  const toggleBranches = (n: LaneNode) => {
    if (n.branchGroups.length === 0) return;
    const next = new Set(expanded);
    const allOpen = n.branchGroups.every((g) => next.has(g));
    for (const g of n.branchGroups) {
      if (allOpen) next.delete(g);
      else next.add(g);
    }
    setExpanded(next);
  };

  const activate = (id: string) => {
    const n = model.nodes.find((x) => x.id === id);
    if (!n) return;
    if (n.step) send({ type: "openSource", ref: n.step.symbol });
    else toggleBand(n.serviceId);
  };
  const toggle = (id: string) => {
    const n = model.nodes.find((x) => x.id === id);
    if (!n) return;
    if (!n.step) toggleBand(n.serviceId);
    else toggleBranches(n);
  };
  const nav = useGraphNav(nodeIds, navEdges, { onActivate: activate, onToggle: toggle });

  const openMenu = (edge: LaneEdge, e: MouseEvent<Element>) => {
    e.preventDefault();
    const rect = (e.currentTarget as Element).getBoundingClientRect();
    setMenu({ edge, x: rect.left, y: rect.bottom });
  };

  const edgeAria = (e: LaneEdge) =>
    t("flow.edgeLabel", {
      from: names.get(e.from) ?? e.from,
      to: names.get(e.to) ?? e.to,
      prov: [provText(e.edge, t), e.branch?.first ? t("flow.branch", { n: e.branch.count }) : "", e.back ? t("flow.recursion") : ""]
        .filter(Boolean)
        .join(", "),
    });
  const edgeTitle = (e: LaneEdge) =>
    [edgeAria(e), e.edge.rationale ? t("flow.rationale", { text: e.edge.rationale }) : ""].filter(Boolean).join("\n");

  const renderNode = (n: LaneNode, style?: { left: number; top: number }) => {
    const props = nav.nodeProps(n.id);
    const branchCount = n.branchGroups.length;
    return (
      <div
        key={n.id}
        role="button"
        data-node-id={n.id}
        aria-label={nodeAria(n, outCount(n.id), t)}
        {...(branchCount > 0 ? { "aria-expanded": n.branchGroups.every((g) => expanded.has(g)) } : {})}
        className={`lane-node${n.step ? "" : " band-placeholder"}${n.layer ? ` layer-${n.layer}` : ""}${n.step && traceSteps && !traceSteps.has(n.step.id) ? " dim" : ""}${n.step?.observed && !traceSteps ? " observed" : ""}`}
        style={style ? { left: style.left, top: style.top, width: NODE_W, height: NODE_H } : undefined}
        title={n.step ? `${n.step.symbol.fqn}\n${n.step.symbol.file}${n.step.symbol.line !== undefined ? `:${n.step.symbol.line}` : ""}` : n.label}
        onClick={() => activate(n.id)}
        {...props}
      >
        <span className="code lane-node-label">{n.label}</span>
        {n.recursive ? <span className="badge" aria-hidden="true">↺</span> : null}
        {n.step && traceSteps?.has(n.step.id) ? (
          <span className="badge badge-observed" title={t("trace.thisTrace")}>
            {traceSteps.get(n.step.id)} ms
          </span>
        ) : n.step?.observed && !traceSteps ? (
          <span
            className={`badge badge-observed${n.step.observed.errorCount > 0 ? " badge-error" : ""}`}
            title={t("trace.observedTitle", { count: n.step.observed.count, p50: n.step.observed.p50Ms, p95: n.step.observed.p95Ms, errors: n.step.observed.errorCount })}
          >
            ✓ {n.step.observed.p95Ms} ms
          </span>
        ) : null}
      </div>
    );
  };

  const edgeMenu = menu ? (
    <div
      className="context-menu"
      role="menu"
      aria-label={t("flow.edgeActions")}
      style={vertical ? undefined : { left: menu.x, top: menu.y }}
      onKeyDown={(e) => {
        if (e.key === "Escape") setMenu(undefined);
      }}
    >
      <p className="muted">{edgeTitle(menu.edge)}</p>
      <button
        type="button"
        role="menuitem"
        autoFocus
        onClick={() => {
          send({ type: "markEdgeWrong", edgeId: menu.edge.edge.id });
          setMenu(undefined);
        }}
      >
        {t("flow.markWrong")}
      </button>
      {menu.edge.branch ? (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            const from = model.nodes.find((n) => n.id === menu.edge.from);
            if (from) toggleBranches(from);
            setMenu(undefined);
          }}
        >
          {menu.edge.branch.group && expanded.has(menu.edge.branch.group)
            ? t("flow.hideBranches")
            : t("flow.showBranches", { n: menu.edge.branch.count })}
        </button>
      ) : null}
      <button type="button" role="menuitem" onClick={() => setMenu(undefined)}>
        {t("legend.close")}
      </button>
    </div>
  ) : null;

  const edgeButton = (e: LaneEdge, style?: { left: number; top: number }) => (
    <button
      key={e.key}
      type="button"
      className={`edge-label edge-label-${e.edge.provenance}${traceSteps && !(traceSteps.has(e.from) && traceSteps.has(e.to)) ? " dim" : ""}`}
      data-edge-id={e.edge.id}
      style={style}
      aria-label={edgeAria(e)}
      aria-haspopup="menu"
      title={edgeTitle(e)}
      onClick={(ev) => openMenu(e, ev)}
      onContextMenu={(ev) => openMenu(e, ev)}
    >
      {edgeText(e, t)}
    </button>
  );

  const truncated = detail.flow.truncated ? (
    <div className="banner banner-info" role="status" data-partial="truncated">
      <span>{t("flow.truncated", { depth })}</span>
      <button type="button" className="secondary" onClick={onLoadMore}>
        {t("flow.expandMore")}
      </button>
    </div>
  ) : null;

  if (vertical) {
    return (
      <div className="swimlane vertical" role="group" aria-label={t("flow.diagram", { ep: detail.entrypoint.handler.name })}>
        {truncated}
        {model.bands.map((b, bi) => (
          <section key={b.serviceId} className="lane-band">
            <BandHeader band={b} onToggle={() => toggleBand(b.serviceId)} t={t} />
            {model.nodes
              .filter((n) => n.band === bi)
              .map((n) => (
                <div key={n.id} className="vertical-step">
                  <span className="lane-tag muted">{n.layer ? t(`layer.${n.layer}`) : ""}</span>
                  {renderNode(n)}
                  <ul className="vertical-edges">
                    {model.edges
                      .filter((e) => e.from === n.id)
                      .map((e) => (
                        <li key={e.key} className={`edge-${e.edge.provenance}`}>
                          <span aria-hidden="true">→ </span>
                          <span className="code">{names.get(e.to) ?? e.to}</span> {edgeButton(e)}
                        </li>
                      ))}
                  </ul>
                </div>
              ))}
          </section>
        ))}
        {edgeMenu}
      </div>
    );
  }

  return (
    <div className="swimlane-scroll">
      {truncated}
      <div
        className="swimlane"
        role="group"
        aria-label={t("flow.diagram", { ep: detail.entrypoint.handler.name })}
        style={{ width: geo.width, height: geo.height }}
      >
        {model.bands.map((b, bi) => (
          <div key={b.serviceId} className="lane-band" style={{ top: geo.bandTop[bi] ?? 0, height: BAND_H + b.lanes.length * ROW_H }}>
            <BandHeader band={b} onToggle={() => toggleBand(b.serviceId)} t={t} />
            {b.lanes.map((l, li) => (
              <div key={l} className="lane-row" style={{ top: BAND_H + li * ROW_H, height: ROW_H }}>
                <span className="lane-label muted">{l === "collapsed" ? "" : t(`layer.${l}`)}</span>
              </div>
            ))}
          </div>
        ))}
        <svg className="swimlane-edges" width={geo.width} height={geo.height} aria-hidden="true">
          <defs>
            <marker id="atlas-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" className="arrow-head" />
            </marker>
          </defs>
          {model.edges.map((e) => {
            const a = geo.pos.get(e.from);
            const b = geo.pos.get(e.to);
            if (!a || !b) return null;
            const p = edgePath(a, b, e.back || e.from === e.to);
            return (
              <path
                key={e.key}
                d={p.d}
                className={`edge-path edge-${e.edge.provenance}${e.edge.observed ? " observed" : ""}`}
                markerEnd="url(#atlas-arrow)"
                onContextMenu={(ev) => openMenu(e, ev)}
              />
            );
          })}
        </svg>
        {model.nodes.map((n) => {
          const p = geo.pos.get(n.id);
          return p ? renderNode(n, { left: p.x, top: p.y }) : null;
        })}
        {model.edges.map((e) => {
          const a = geo.pos.get(e.from);
          const b = geo.pos.get(e.to);
          if (!a || !b) return null;
          const p = edgePath(a, b, e.back || e.from === e.to);
          return edgeButton(e, { left: p.mx, top: p.my });
        })}
        {edgeMenu}
      </div>
    </div>
  );
}

function BandHeader({ band, onToggle, t }: { band: SwimlaneModel["bands"][number]; onToggle(): void; t: Translate }) {
  return (
    <div className="band-header">
      <button
        type="button"
        className="secondary small"
        aria-expanded={!band.collapsed}
        aria-label={band.collapsed ? t("flow.expandBand", { service: band.name }) : t("flow.collapseBand", { service: band.name })}
        onClick={onToggle}
      >
        {band.collapsed ? "▸" : "▾"}
      </button>
      <span className="code">{t("flow.band", { service: band.name, n: band.stepCount })}</span>
    </div>
  );
}
