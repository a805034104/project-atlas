import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";
import type { CallEdge, FlowDetailData, TraceDetailData } from "@project-atlas/core";
import { useI18n, type Translate } from "../../i18n.js";
import { useApp } from "../../state.js";
import { PROVENANCE_MARK } from "../../components/Legend.js";
import { useGraphNav } from "../../components/useGraphNav.js";
import { buildSwimlane, type LaneEdge, type LaneNode } from "./model.js";
import { buildPyramid, middleTruncate, NODE_H, NODE_W, RAIL_W, SIDECAR_GAP, SIDECAR_W, type PyramidLink, type PyramidNode } from "./pyramid-layout.js";

/**
 * Flow diagram, top-down: the entrypoint on top, every call one row further down, a caller
 * centred over its callees (pyramid). Under 600 px it becomes an indented list.
 */

const ZOOM_MIN = 0.6;
const ZOOM_MAX = 1.5;

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
  return t("graph.nodeLabel", { name: n.label, kind: t("layer.suffix", { layer: t(`layer.${n.layer}`) }), n: outgoing });
}

export function Pyramid({
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
  const [expandedFanout, setExpandedFanout] = useState<ReadonlySet<string>>(new Set());
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [viewport, setViewport] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const traceSteps = useMemo(() => {
    if (!trace) return undefined;
    const m = new Map<string, number>();
    for (const s of trace.spans) if (s.stepId) m.set(s.stepId, Math.max(m.get(s.stepId) ?? 0, s.durationMs));
    return m;
  }, [trace]);
  const [menu, setMenu] = useState<{ edge: LaneEdge; x: number; y: number } | undefined>();
  const collapsedBands = useMemo(() => new Set(state.persisted.collapsedBands), [state.persisted.collapsedBands]);
  const model = useMemo(() => buildSwimlane(detail, { expandedBranches: expanded, collapsedBands }), [detail, expanded, collapsedBands]);
  const layout = useMemo(() => buildPyramid(model, { expandedFanout }), [model, expandedFanout]);
  // Keyboard order follows what is drawn: the pyramid's nodes, or every step in the narrow list.
  const nodeIds = useMemo(() => (vertical ? model.nodes.map((n) => n.id) : layout.nodes.map((n) => n.id)), [vertical, model, layout]);
  const navEdges = useMemo(
    () => (vertical ? model.edges.map((e) => ({ from: e.from, to: e.to })) : layout.links.filter((l) => l.kind !== "back").map((l) => ({ from: l.from, to: l.to }))),
    [vertical, model, layout],
  );
  const names = useMemo(() => new Map(model.nodes.map((n) => [n.id, n.label])), [model]);
  const outCount = (id: string) => model.edges.filter((e) => e.from === id).length;

  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setViewport(el.clientWidth));
    ro.observe(el);
    setViewport(el.clientWidth);
    return () => ro.disconnect();
    // The scroller only exists in the wide layout: re-attach after a narrow/wide switch.
  }, [vertical]);
  const scale = zoom === "fit" ? (viewport > 0 ? Math.min(1, Math.max(ZOOM_MIN, viewport / layout.width)) : 1) : zoom;

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
  const expandFanout = (parent: string) => setExpandedFanout(new Set([...expandedFanout, parent]));

  const placed = (id: string): { more?: { parent: string }; node?: LaneNode } | undefined => {
    const p = layout.nodes.find((x) => x.id === id);
    if (p) return p;
    const node = vertical ? model.nodes.find((n) => n.id === id) : undefined;
    return node ? { node } : undefined;
  };
  const activate = (id: string) => {
    const p = placed(id);
    if (p?.more) return expandFanout(p.more.parent);
    const n = p?.node;
    if (!n) return;
    if (n.step) send({ type: "openSource", ref: n.step.symbol });
    else toggleBand(n.serviceId);
  };
  const toggle = (id: string) => {
    const p = placed(id);
    if (p?.more) return expandFanout(p.more.parent);
    const n = p?.node;
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
      prov: [provText(e.edge, t), e.branch?.first ? t("flow.branch", { n: e.branch.count }) : "", e.back ? t("flow.recursion") : ""].filter(Boolean).join(", "),
    });
  const edgeTitle = (e: LaneEdge) => [edgeAria(e), e.edge.rationale ? t("flow.rationale", { text: e.edge.rationale }) : ""].filter(Boolean).join("\n");

  const badge = (n: LaneNode) =>
    n.step && traceSteps?.has(n.step.id) ? (
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
    ) : null;

  const dimmed = (n: LaneNode | undefined) => Boolean(n?.step && traceSteps && !traceSteps.has(n.step.id));

  const renderNode = (p: PyramidNode | { id: string; node: LaneNode }, style?: { left: number; top: number }) => {
    const props = nav.nodeProps(p.id);
    if ("more" in p && p.more) {
      return (
        <div
          key={p.id}
          role="button"
          data-node-id={p.id}
          aria-expanded={false}
          aria-label={t("flow.moreCallees", { n: p.more.count })}
          className="lane-node pyr-node pyr-more"
          style={style ? { left: style.left, top: style.top, width: NODE_W, height: NODE_H } : undefined}
          onClick={() => activate(p.id)}
          {...props}
        >
          <span className="pyr-label">{t("flow.moreCallees", { n: p.more.count })}</span>
        </div>
      );
    }
    const n = p.node as LaneNode;
    const branchCount = n.branchGroups.length;
    return (
      <div
        key={p.id}
        role="button"
        data-node-id={n.id}
        aria-label={nodeAria(n, outCount(n.id), t)}
        {...(branchCount > 0 ? { "aria-expanded": n.branchGroups.every((g) => expanded.has(g)) } : {})}
        className={`lane-node pyr-node${n.step ? "" : " band-placeholder"}${n.layer ? ` layer-${n.layer}` : ""}${dimmed(n) ? " dim" : ""}${n.step?.observed && !traceSteps ? " observed" : ""}`}
        style={style ? { left: style.left, top: style.top, width: NODE_W, height: NODE_H } : undefined}
        title={n.step ? `${n.step.symbol.fqn}\n${n.step.symbol.file}${n.step.symbol.line !== undefined ? `:${n.step.symbol.line}` : ""}` : n.label}
        onClick={() => activate(n.id)}
        {...props}
      >
        <span className="code pyr-label lane-node-label">{middleTruncate(n.label)}</span>
        <span className="pyr-meta">
          {n.layer ? <span className={`pyr-chip chip-${n.layer}`}>{t(`layer.${n.layer}`)}</span> : null}
          {n.recursive ? (
            <span className="badge" aria-hidden="true">
              ↺
            </span>
          ) : null}
          {branchCount > 0 ? (
            <span className="badge" aria-hidden="true">
              ×
            </span>
          ) : null}
          {badge(n)}
        </span>
      </div>
    );
  };

  const renderSidecar = (p: PyramidNode) => {
    const a = p.sidecar;
    if (!a) return null;
    const left = p.x + NODE_W + SIDECAR_GAP;
    return (
      <button
        key={`sidecar:${a.id}`}
        type="button"
        data-node-id={a.id}
        className={`pyr-sidecar layer-aspect${dimmed(a) ? " dim" : ""}${a.step?.observed && !traceSteps ? " observed" : ""}`}
        style={{ left, top: p.y + NODE_H / 2 - 14, width: SIDECAR_W }}
        title={(p.sidecars ?? [a]).map((x) => (x.step ? `${x.label}\n  ${x.step.symbol.file}${x.step.symbol.line !== undefined ? `:${x.step.symbol.line}` : ""}` : x.label)).join("\n")}
        aria-label={t("flow.aspectOn", { aspect: (p.sidecars ?? [a]).map((x) => x.label).join(", "), target: p.node?.label ?? "" })}
        onClick={() => a.step && send({ type: "openSource", ref: a.step.symbol })}
      >
        <span className="code">{middleTruncate(a.label, (p.sidecars?.length ?? 1) > 1 ? 14 : 18)}</span>
        {(p.sidecars?.length ?? 1) > 1 ? <span className="badge">+{(p.sidecars?.length ?? 1) - 1}</span> : null}
        {badge(a)}
      </button>
    );
  };

  const edgeMenu = menu ? (
    <div className="context-menu" role="menu" aria-label={t("flow.edgeActions")} style={vertical ? undefined : { left: menu.x, top: menu.y, position: "fixed" }} onKeyDown={(e) => e.key === "Escape" && setMenu(undefined)}>
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
          {menu.edge.branch.group && expanded.has(menu.edge.branch.group) ? t("flow.hideBranches") : t("flow.showBranches", { n: menu.edge.branch.count })}
        </button>
      ) : null}
      <button type="button" role="menuitem" onClick={() => setMenu(undefined)}>
        {t("legend.close")}
      </button>
    </div>
  ) : null;

  const edgeButton = (l: { key: string; edge: LaneEdge; from: string; to: string }, style?: { left: number; top: number }, compact = false) => (
    <button
      key={l.key}
      type="button"
      className={`edge-label edge-label-${l.edge.edge.provenance}${traceSteps && !(traceSteps.has(l.edge.from) && traceSteps.has(l.edge.to)) ? " dim" : ""}`}
      data-edge-id={l.edge.edge.id}
      style={style}
      aria-label={edgeAria(l.edge)}
      aria-haspopup="menu"
      title={edgeTitle(l.edge)}
      onClick={(ev) => openMenu(l.edge, ev)}
      onContextMenu={(ev) => openMenu(l.edge, ev)}
    >
      {compact ? PROVENANCE_MARK[l.edge.edge.provenance] : edgeText(l.edge, t)}
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
      <div className="pyramid vertical" role="group" aria-label={t("flow.diagram", { ep: detail.entrypoint.handler.name })}>
        {truncated}
        {model.bands.map((b, bi) => (
          <section key={b.serviceId} className="pyr-band">
            <FrameHeader name={b.name} count={b.stepCount} collapsed={b.collapsed} onToggle={() => toggleBand(b.serviceId)} t={t} />
            {model.nodes
              .filter((n) => n.band === bi)
              .map((n) => (
                <div key={n.id} className="vertical-step">
                  {renderNode({ id: n.id, node: n })}
                  <ul className="vertical-edges">
                    {model.edges
                      .filter((e) => e.from === n.id)
                      .map((e) => (
                        <li key={e.key} className={`edge-${e.edge.provenance}`}>
                          <span aria-hidden="true">↓ </span>
                          <span className="code">{names.get(e.to) ?? e.to}</span> {edgeButton({ key: e.key, edge: e, from: e.from, to: e.to })}
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

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    if (e.key === "0") setZoom("fit");
    else if (e.key === "+" || e.key === "=") setZoom(Math.min(ZOOM_MAX, Math.round((scale + 0.1) * 10) / 10));
    else if (e.key === "-") setZoom(Math.max(ZOOM_MIN, Math.round((scale - 0.1) * 10) / 10));
  };

  const linkStyle = (l: PyramidLink) => `edge-path edge-${l.edge.edge.provenance}${l.edge.edge.observed ? " observed" : ""}${l.kind === "back" ? " edge-back" : ""}${traceSteps && !(traceSteps.has(l.edge.from) && traceSteps.has(l.edge.to)) ? " dim" : ""}`;

  return (
    <div className="pyramid-wrap" onKeyDown={onKey}>
      {truncated}
      <div className="pyramid-scroll" ref={scroller}>
        <div className="pyramid-sizer" style={{ width: layout.width * scale, height: layout.height * scale }}>
          <div className="pyramid" role="group" aria-label={t("flow.diagram", { ep: detail.entrypoint.handler.name })} style={{ width: layout.width, height: layout.height, transform: `scale(${scale})`, transformOrigin: "0 0" }}>
            <div className="pyr-rail" style={{ width: RAIL_W }} aria-hidden="true">
              {layout.rows.map((r, i) => (
                <span key={i} className="pyr-rail-row muted" style={{ top: r.y, height: NODE_H }}>
                  {r.layers.map((l) => t(`layer.${l}`)).join(" · ")}
                </span>
              ))}
            </div>
            {layout.frames.map((f) => (
              <div key={f.serviceId} className="pyr-frame" style={{ left: f.x, top: f.y, width: f.w, height: f.h }}>
                <FrameHeader name={f.name} count={f.stepCount} collapsed={f.collapsed} onToggle={() => toggleBand(f.serviceId)} t={t} />
              </div>
            ))}
            <svg className="pyramid-edges" width={layout.width} height={layout.height} aria-hidden="true">
              <defs>
                <marker id="atlas-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" className="arrow-head" />
                </marker>
              </defs>
              {layout.links.map((l) => (
                <path key={l.key} d={l.path} className={linkStyle(l)} markerEnd="url(#atlas-arrow)" onContextMenu={(ev) => openMenu(l.edge, ev)} />
              ))}
              {layout.nodes
                .filter((p) => p.sidecar)
                .map((p) => (
                  <line key={`c:${p.id}`} x1={p.x + NODE_W} y1={p.y + NODE_H / 2} x2={p.x + NODE_W + SIDECAR_GAP} y2={p.y + NODE_H / 2} className="edge-path edge-sidecar" />
                ))}
            </svg>
            {layout.nodes.map((p) => renderNode(p, { left: p.x, top: p.y }))}
            {layout.nodes.map(renderSidecar)}
            {layout.links.map((l) => (l.key.startsWith("more:") ? null : <span key={l.key} className={`pyr-edge-label${l.kind === "back" ? " back" : ""}`} style={{ left: l.kind === "back" ? l.labelX : l.labelX + 6, top: l.labelY }}>{edgeButton(l, undefined, !l.showLabel)}</span>))}
          </div>
        </div>
      </div>
      <div className="pyr-zoom" role="toolbar" aria-label={t("flow.zoom")}>
        <button type="button" className="secondary small" aria-label={t("flow.zoomOut")} onClick={() => setZoom(Math.max(ZOOM_MIN, Math.round((scale - 0.1) * 10) / 10))}>
          −
        </button>
        <span className="muted small">{Math.round(scale * 100)}%</span>
        <button type="button" className="secondary small" aria-label={t("flow.zoomIn")} onClick={() => setZoom(Math.min(ZOOM_MAX, Math.round((scale + 0.1) * 10) / 10))}>
          +
        </button>
        <button type="button" className="secondary small" onClick={() => setZoom("fit")}>
          {t("flow.fit")}
        </button>
      </div>
      {edgeMenu}
    </div>
  );
}

function FrameHeader({ name, count, collapsed, onToggle, t }: { name: string; count: number; collapsed: boolean; onToggle(): void; t: Translate }) {
  return (
    <div className="band-header pyr-frame-title">
      <button
        type="button"
        className="secondary small"
        aria-expanded={!collapsed}
        aria-label={collapsed ? t("flow.expandBand", { service: name }) : t("flow.collapseBand", { service: name })}
        onClick={onToggle}
      >
        {collapsed ? "▸" : "▾"}
      </button>
      <span className="code">{t("flow.band", { service: name, n: count })}</span>
    </div>
  );
}
