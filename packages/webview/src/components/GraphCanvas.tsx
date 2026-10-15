/**
 * React Flow canvas laid out by ELK (layered). Nodes are compact rectangles
 * with roving-tabindex keyboard traversal (useGraphNav). Used by Topology and
 * Modules; each view also offers an accessible table ("List view").
 */

import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import {
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { useLayout, type LayoutEdge, type LayoutNode } from "../layout.js";
import { useI18n } from "../i18n.js";
import { useGraphNav, type GraphNav } from "./useGraphNav.js";

export const MAX_GRAPH_NODES = 500;

export type Tone = "blue" | "green" | "yellow" | "orange" | "red" | "purple" | "none";

export interface GNode {
  id: string;
  label: string;
  sublabel?: string;
  ariaLabel: string;
  tone?: Tone;
  /** Short non-colour badge (e.g. heat number, ⚠ count). */
  badge?: string;
  /** "pill" for message channels (topic / queue / stream) between services. */
  shape?: "pill";
}

export interface GEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  /** Line style class, e.g. "edge-static", "edge-ai-inferred". */
  className?: string;
}

const NODE_W = 180;
const NODE_H = 40;

interface NavCtx {
  nav: GraphNav;
  selectedId: string | undefined;
  onSelect(id: string): void;
}

const GraphNavContext = createContext<NavCtx | null>(null);

type AtlasNodeData = { g: GNode };

function AtlasNode({ id, data }: NodeProps<Node<AtlasNodeData>>) {
  const ctx = useContext(GraphNavContext);
  if (!ctx) return null;
  const { g } = data;
  const props = ctx.nav.nodeProps(id);
  return (
    <div
      role="button"
      aria-label={g.ariaLabel}
      aria-pressed={ctx.selectedId === id}
      data-node-id={id}
      className={`graph-node tone-${g.tone ?? "none"}${g.shape === "pill" ? " pill" : ""}${ctx.selectedId === id ? " selected" : ""}`}
      style={{ width: NODE_W, height: NODE_H }}
      onClick={() => ctx.onSelect(id)}
      {...props}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <span className="graph-node-label code">{g.label}</span>
      {g.sublabel || g.badge ? (
        <span className="graph-node-sub">
          {g.sublabel}
          {g.badge ? <span className="badge">{g.badge}</span> : null}
        </span>
      ) : null}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

const nodeTypes = { atlas: AtlasNode };

/** Re-fits the viewport once ELK positions replace the fallback layout. */
function FitOnLayout({ engine }: { engine: "elk" | "fallback" }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (engine === "elk") requestAnimationFrame(() => void fitView());
  }, [engine, fitView]);
  return null;
}

export function GraphCanvas({
  nodes,
  edges,
  ariaLabel,
  selectedId,
  onSelect,
  onActivate,
  onToggle,
}: {
  nodes: GNode[];
  edges: GEdge[];
  ariaLabel: string;
  selectedId?: string | undefined;
  onSelect(id: string): void;
  onActivate(id: string): void;
  onToggle?(id: string): void;
}) {
  const { t } = useI18n();
  const layoutNodes = useMemo<LayoutNode[]>(() => nodes.map((n) => ({ id: n.id, width: NODE_W, height: NODE_H })), [nodes]);
  const layoutEdges = useMemo<LayoutEdge[]>(() => edges.map((e) => ({ id: e.id, from: e.from, to: e.to })), [edges]);
  const { positions, engine } = useLayout(layoutNodes, layoutEdges);
  const nodeIds = useMemo(() => nodes.map((n) => n.id), [nodes]);
  const nav = useGraphNav(nodeIds, edges, {
    onActivate,
    ...(onToggle ? { onToggle } : {}),
    focusId: selectedId,
  });

  const rfNodes = useMemo<Node<AtlasNodeData>[]>(
    () =>
      nodes.map((g) => ({
        id: g.id,
        type: "atlas",
        position: positions[g.id] ?? { x: 0, y: 0 },
        data: { g },
        width: NODE_W,
        height: NODE_H,
        draggable: false,
        selectable: false,
        connectable: false,
        focusable: false,
      })),
    [nodes, positions],
  );
  const rfEdges = useMemo<Edge[]>(
    () =>
      edges.map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        ...(e.label !== undefined ? { label: e.label } : {}),
        className: e.className ?? "edge-static",
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        focusable: false,
        selectable: false,
      })),
    [edges],
  );

  return (
    <GraphNavContext.Provider value={{ nav, selectedId, onSelect }}>
      <div className="graph-canvas" data-layout={engine} role="group" aria-label={ariaLabel} aria-describedby="atlas-graph-help">
        <p id="atlas-graph-help" className="sr-only">
          {t("graph.instructions")}
        </p>
        <ReactFlowProvider>
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            elementsSelectable={false}
            disableKeyboardA11y
            fitView
            minZoom={0.2}
          >
            <FitOnLayout engine={engine} />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
    </GraphNavContext.Provider>
  );
}

/** Graph with an accessible table alternative; forced to the table above 500 nodes. */
export function GraphOrList({
  count,
  listView,
  graph,
  list,
  toolbar,
}: {
  count: number;
  listView: boolean;
  graph: () => ReactNode;
  list: () => ReactNode;
  toolbar?: ReactNode;
}) {
  const { t } = useI18n();
  const forced = count > MAX_GRAPH_NODES;
  const showList = forced || listView;
  return (
    <div className="graph-or-list" data-mode={showList ? "list" : "graph"}>
      {toolbar}
      {forced ? (
        <p className="muted" role="note">
          {t("common.autoList", { n: count })}
        </p>
      ) : null}
      {showList ? list() : graph()}
    </div>
  );
}
