import { useMemo, useState } from "react";
import type { ServiceLinkKind, TopologyData } from "@project-atlas/core";
import { useI18n } from "../i18n.js";
import { useApp } from "../state.js";
import { EmptyState, SourceLink, ViewToggle } from "../components/common.js";
import { ViewFrame } from "../components/ViewFrame.js";
import { GraphCanvas, GraphOrList, type GEdge, type GNode, type Tone } from "../components/GraphCanvas.js";
import { PROVENANCE_MARK } from "../components/Legend.js";

const KIND_TONE: Record<ServiceLinkKind, Tone> = {
  http: "blue",
  "gateway-route": "purple",
  "frontend-proxy": "green",
  mq: "orange",
  grpc: "yellow",
  dubbo: "red",
};

const SERVICE_TONE = { backend: "blue", gateway: "purple", frontend: "green", worker: "orange" } as const;

function TopologyBody({ data }: { data: TopologyData }) {
  const { t } = useI18n();
  const { state, dispatch, send } = useApp();
  const [showAi, setShowAi] = useState(true);
  const listView = state.persisted.listView.topology ?? false;
  const aiLinks = data.links.filter((l) => l.provenance === "ai-inferred").length;
  const links = useMemo(() => data.links.filter((l) => showAi || l.provenance !== "ai-inferred"), [data.links, showAi]);
  const names = useMemo(() => new Map(data.services.map((s) => [s.id, s.name])), [data.services]);

  const nodes = useMemo<GNode[]>(
    () =>
      data.services.map((s) => {
        const outCount = links.filter((l) => l.fromServiceId === s.id).length;
        return {
          id: s.id,
          label: s.name,
          sublabel: t(`service.${s.kind}`),
          tone: SERVICE_TONE[s.kind],
          ariaLabel: t("graph.nodeLabel", { name: s.name, kind: t(`service.${s.kind}`), n: outCount }),
        };
      }),
    [data.services, links, t],
  );
  const edges = useMemo<GEdge[]>(
    () =>
      links.map((l) => ({
        id: l.id,
        from: l.fromServiceId,
        to: l.toServiceId,
        label: `${PROVENANCE_MARK[l.provenance]} ${l.kind} ${l.channel}`,
        className: `edge-${l.provenance} tone-${KIND_TONE[l.kind]}`,
      })),
    [links],
  );

  if (data.links.length === 0) {
    return <EmptyState title={t("topology.empty.title")} body={t("topology.empty.body")} />;
  }

  const selected = data.services.find((s) => s.id === state.selectedServiceId);

  return (
    <GraphOrList
      count={nodes.length}
      listView={listView}
      toolbar={
        <div className="toolbar">
          <ViewToggle
            listView={listView}
            onChange={(v) => dispatch({ type: "persist", patch: { listView: { ...state.persisted.listView, topology: v } } })}
          />
          {data.unresolvedCount > 0 || aiLinks > 0 ? (
            <label className="checkbox" data-partial="ai-links">
              <input type="checkbox" checked={showAi} onChange={(e) => setShowAi(e.target.checked)} />
              {t("topology.aiToggle", { n: aiLinks + data.unresolvedCount })}
            </label>
          ) : null}
          {selected ? <SourceLink source={selected.evidence} label={`${selected.name} · ${selected.evidence.file}`} /> : null}
        </div>
      }
      graph={() => (
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          ariaLabel={t("topology.graph")}
          selectedId={state.selectedServiceId}
          onSelect={(id) => dispatch({ type: "selectService", id })}
          onActivate={(id) => {
            const svc = data.services.find((s) => s.id === id);
            if (svc) send({ type: "openSource", ref: svc.evidence });
          }}
        />
      )}
      list={() => (
        <table className="data-table">
          <caption className="sr-only">{t("topology.graph")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("col.from")}</th>
              <th scope="col">{t("col.to")}</th>
              <th scope="col">{t("col.kind")}</th>
              <th scope="col">{t("col.channel")}</th>
              <th scope="col">{t("col.provenance")}</th>
            </tr>
          </thead>
          <tbody>
            {links.map((l) => (
              <tr key={l.id}>
                <td className="code">{names.get(l.fromServiceId) ?? l.fromServiceId}</td>
                <td className="code">{names.get(l.toServiceId) ?? l.toServiceId}</td>
                <td>{l.kind}</td>
                <td className="code">{l.channel}</td>
                <td>
                  {PROVENANCE_MARK[l.provenance]}{" "}
                  {t(`prov.${l.provenance}`, { pct: `${Math.round(l.confidence * 100)}%` })}
                  {l.evidence[0] ? (
                    <>
                      {" "}
                      <SourceLink source={l.evidence[0]} />
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    />
  );
}

export function TopologyView() {
  return <ViewFrame view="topology">{(data) => <TopologyBody data={data} />}</ViewFrame>;
}
