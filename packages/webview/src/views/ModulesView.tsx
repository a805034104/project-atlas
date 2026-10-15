import { useMemo } from "react";
import type { ModulesData } from "@project-atlas/core";
import { useI18n } from "../i18n.js";
import { useApp } from "../state.js";
import { EmptyState, PlainText, ViewToggle } from "../components/common.js";
import { ViewFrame } from "../components/ViewFrame.js";
import { GraphCanvas, GraphOrList, type GEdge, type GNode, type Tone } from "../components/GraphCanvas.js";

/** 90-day heat → chart token. The number is always shown too (never colour alone). */
export function heatTone(commits: number): Tone {
  if (commits <= 0) return "none";
  if (commits < 5) return "blue";
  if (commits < 15) return "yellow";
  if (commits < 30) return "orange";
  return "red";
}

function ModulesBody({ data }: { data: ModulesData }) {
  const { t } = useI18n();
  const { state, dispatch, go } = useApp();
  const listView = state.persisted.listView.modules ?? false;
  const serviceFilter = state.persisted.filters.moduleServiceId;
  const modules = useMemo(
    () => data.modules.filter((m) => !serviceFilter || m.serviceId === serviceFilter),
    [data.modules, serviceFilter],
  );
  const serviceNames = useMemo(() => new Map(data.services.map((s) => [s.id, s.name])), [data.services]);
  const moduleNames = useMemo(() => new Map(data.modules.map((m) => [m.id, m.name])), [data.modules]);
  const visible = useMemo(() => new Set(modules.map((m) => m.id)), [modules]);

  const nodes = useMemo<GNode[]>(
    () =>
      modules.map((m) => {
        const commits = data.commits90d[m.id] ?? 0;
        const deps = m.dependsOn.filter((d) => visible.has(d)).length;
        return {
          id: m.id,
          label: m.name,
          sublabel: serviceNames.get(m.serviceId) ?? "",
          badge: String(commits),
          tone: heatTone(commits),
          ariaLabel: `${t("graph.nodeLabel", { name: m.name, kind: m.kind, n: deps })}, ${t("modules.heat", { n: commits })}`,
        };
      }),
    [modules, data.commits90d, serviceNames, visible, t],
  );
  const edges = useMemo<GEdge[]>(
    () =>
      modules.flatMap((m) =>
        m.dependsOn.filter((d) => visible.has(d)).map((d) => ({ id: `${m.id}->${d}`, from: m.id, to: d })),
      ),
    [modules, visible],
  );

  if (data.modules.length === 0) {
    return <EmptyState title={t("modules.empty.title")} body={t("modules.empty.body")} />;
  }

  const selected = data.modules.find((m) => m.id === state.persisted.selectedModuleId);
  const select = (id: string) => dispatch({ type: "persist", patch: { selectedModuleId: id } });

  return (
    <div className="split">
      <div className="split-main">
        <GraphOrList
          count={nodes.length}
          listView={listView}
          toolbar={
            <div className="toolbar">
              <label>
                {t("modules.filterService")}{" "}
                <select
                  value={serviceFilter}
                  onChange={(e) =>
                    dispatch({
                      type: "persist",
                      patch: { filters: { ...state.persisted.filters, moduleServiceId: e.target.value } },
                    })
                  }
                >
                  <option value="">{t("modules.allServices")}</option>
                  {data.services.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <ViewToggle
                listView={listView}
                onChange={(v) => dispatch({ type: "persist", patch: { listView: { ...state.persisted.listView, modules: v } } })}
              />
            </div>
          }
          graph={() => (
            <GraphCanvas
              nodes={nodes}
              edges={edges}
              ariaLabel={t("modules.graph")}
              selectedId={state.persisted.selectedModuleId}
              onSelect={select}
              onActivate={select}
            />
          )}
          list={() => (
            <table className="data-table">
              <caption className="sr-only">{t("modules.graph")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("col.name")}</th>
                  <th scope="col">{t("col.service")}</th>
                  <th scope="col">{t("col.files")}</th>
                  <th scope="col">{t("col.loc")}</th>
                  <th scope="col">{t("col.commits")}</th>
                  <th scope="col">{t("col.dependsOn")}</th>
                </tr>
              </thead>
              <tbody>
                {modules.map((m) => (
                  <tr key={m.id} aria-selected={m.id === selected?.id}>
                    <td>
                      <button type="button" className="link code" onClick={() => select(m.id)}>
                        {m.name}
                      </button>
                    </td>
                    <td>{serviceNames.get(m.serviceId) ?? m.serviceId}</td>
                    <td className="num">{m.fileCount}</td>
                    <td className="num">{m.loc}</td>
                    <td className="num">{data.commits90d[m.id] ?? 0}</td>
                    <td className="code">{m.dependsOn.map((d) => moduleNames.get(d) ?? d).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        />
      </div>
      {selected ? (
        <aside className="split-side details" aria-label={selected.name}>
          <h2 className="code">{selected.name}</h2>
          <p className="muted code">{selected.path}</p>
          <p>
            {t("modules.size", { files: selected.fileCount, loc: selected.loc })}
            <br />
            {t("modules.heat", { n: data.commits90d[selected.id] ?? 0 })}
          </p>
          <h3 className="subtle">{t("modules.summary")}</h3>
          {selected.summary ? <PlainText text={selected.summary} /> : <p className="muted">{t("modules.noSummary")}</p>}
          {selected.dependsOn.length > 0 ? (
            <>
              <h3 className="subtle">{t("col.dependsOn")}</h3>
              <ul className="plain-list">
                {selected.dependsOn.map((d) => (
                  <li key={d}>
                    <button type="button" className="link code" onClick={() => select(d)}>
                      {moduleNames.get(d) ?? d}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <button type="button" className="secondary" onClick={() => go("history", selected.id, selected.name)}>
            {t("modules.viewHistory")}
          </button>
        </aside>
      ) : null}
    </div>
  );
}

export function ModulesView() {
  return (
    <ViewFrame view="modules" aiAware>
      {(data) => <ModulesBody data={data} />}
    </ViewFrame>
  );
}
