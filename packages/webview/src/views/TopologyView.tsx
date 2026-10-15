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

  // Message channels (topic / queue / stream) are nodes of their own: producers → channel → consumers.
  const channels = useMemo(() => {
    const out = new Map<string, { broker: string; name: string; producers: Set<string>; consumers: Set<string> }>();
    for (const l of links) {
      if (l.kind !== "mq") continue;
      const colon = l.channel.indexOf(":");
      const entry = out.get(l.channel) ?? { broker: l.channel.slice(0, colon), name: l.channel.slice(colon + 1), producers: new Set(), consumers: new Set() };
      entry.producers.add(l.fromServiceId);
      entry.consumers.add(l.toServiceId);
      out.set(l.channel, entry);
    }
    return out;
  }, [links]);

  const nodes = useMemo<GNode[]>(
    () => [
      ...data.services.map((s) => {
        const outCount = links.filter((l) => l.fromServiceId === s.id).length;
        return {
          id: s.id,
          label: s.name,
          sublabel: t(`service.${s.kind}`),
          tone: SERVICE_TONE[s.kind],
          ariaLabel: t("graph.nodeLabel", { name: s.name, kind: t(`service.${s.kind}`), n: outCount }),
        };
      }),
      ...[...channels].map(([channel, c]) => ({
        id: `mq:${channel}`,
        label: c.name,
        sublabel: c.broker,
        tone: "orange" as Tone,
        shape: "pill" as const,
        ariaLabel: t("topology.channel", { broker: c.broker, name: c.name, producers: c.producers.size, consumers: c.consumers.size }),
      })),
    ],
    [data.services, links, channels, t],
  );
  const edges = useMemo<GEdge[]>(() => {
    const out: GEdge[] = links
      .filter((l) => l.kind !== "mq")
      .map((l) => ({
        id: l.id,
        from: l.fromServiceId,
        to: l.toServiceId,
        label: `${PROVENANCE_MARK[l.provenance]} ${l.kind} ${l.channel}`,
        className: `edge-${l.provenance} tone-${KIND_TONE[l.kind]}`,
      }));
    for (const [channel, c] of channels) {
      for (const p of c.producers) out.push({ id: `mq-in:${p}:${channel}`, from: p, to: `mq:${channel}`, label: `${PROVENANCE_MARK["framework-rule"]} ${t("topology.produce")}`, className: "edge-framework-rule tone-orange" });
      for (const s of c.consumers) out.push({ id: `mq-out:${channel}:${s}`, from: `mq:${channel}`, to: s, label: `⇢ ${t("topology.consume")}`, className: "edge-framework-rule tone-orange async" });
    }
    return out;
  }, [links, channels, t]);

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
