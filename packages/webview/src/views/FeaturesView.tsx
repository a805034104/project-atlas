import { useMemo } from "react";
import type { Entrypoint, Feature, FeaturesData } from "@project-atlas/core";
import { useI18n } from "../i18n.js";
import { useApp } from "../state.js";
import { CommandButton, EmptyState } from "../components/common.js";
import { ViewFrame } from "../components/ViewFrame.js";

export function entrypointLabel(ep: Entrypoint): string {
  if (ep.method && ep.path) return `${ep.method} ${ep.path}`;
  return ep.path ?? ep.handler.name;
}

/** `com.x.SysUserController#list(SysUser)` → `SysUser`. */
function handlerGroup(fqn: string): string {
  const cls = fqn.split("#")[0]?.split(".").pop() ?? fqn;
  return cls.replace(/(Controller|Resource|Handler|Api)$/, "") || cls;
}

/** Candidate features when the AI layer has not grouped any: one per handler class (deterministic). */
export function candidateFeatures(data: FeaturesData): Feature[] {
  const groups = new Map<string, string[]>();
  for (const ep of data.entrypoints) {
    if (ep.kind !== "http") continue;
    const key = handlerGroup(ep.handler.fqn);
    groups.set(key, [...(groups.get(key) ?? []), ep.id]);
  }
  return [...groups.entries()]
    .sort(([, a], [, b]) => b.length - a.length)
    .map(([title, entrypointIds]) => ({
      id: `candidate:${title}`,
      title,
      description: "",
      tier: "secondary" as const,
      moduleIds: [],
      entrypointIds,
    }));
}

function FeatureColumn({
  title,
  features,
  data,
  partial = false,
}: {
  title: string;
  features: Feature[];
  data: FeaturesData;
  partial?: boolean;
}) {
  const { t } = useI18n();
  const { state, dispatch, go } = useApp();
  const modules = new Map(data.modules.map((m) => [m.id, m.name]));
  const entrypoints = new Map(data.entrypoints.map((e) => [e.id, e]));
  return (
    <section className="feature-column" aria-label={title} {...(partial ? { "data-partial": "candidates" } : {})}>
      <h2>{title}</h2>
      {features.length === 0 ? <p className="muted">{t("common.none")}</p> : null}
      <ul className="plain-list">
        {features.map((f) => {
          const open = state.selectedFeatureId === f.id;
          return (
            <li key={f.id} className={open ? "selected" : undefined}>
              <button
                type="button"
                className="link feature-title"
                aria-expanded={open}
                onClick={() => dispatch({ type: "selectFeature", id: open ? undefined : f.id })}
              >
                {f.title}
              </button>
              {f.description ? <p className="muted">{f.description}</p> : null}
              {open ? (
                <div className="feature-links">
                  {f.moduleIds.length > 0 ? (
                    <>
                      <h3 className="subtle">{t("features.modules")}</h3>
                      <ul className="plain-list">
                        {f.moduleIds.map((id) => (
                          <li key={id}>
                            <button type="button" className="link code" onClick={() => go("modules", id, f.title)}>
                              {modules.get(id) ?? id}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                  {f.entrypointIds.length > 0 ? (
                    <>
                      <h3 className="subtle">{t("features.entrypoints")}</h3>
                      <ul className="plain-list">
                        {f.entrypointIds.map((id) => {
                          const ep = entrypoints.get(id);
                          return (
                            <li key={id}>
                              <button type="button" className="link code" onClick={() => go("flow", id, f.title)}>
                                {ep ? entrypointLabel(ep) : id}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function FeaturesBody({ data }: { data: FeaturesData }) {
  const { t } = useI18n();
  const candidates = useMemo(() => candidateFeatures(data), [data]);
  if (data.features.length === 0) {
    if (candidates.length === 0) {
      return (
        <EmptyState
          title={t("features.empty.title")}
          body={t("features.empty.body")}
          action={
            <CommandButton command="atlas.configureProvider" primary>
              {t("banner.aiAction")}
            </CommandButton>
          }
        />
      );
    }
    return (
      <div className="columns">
        <FeatureColumn title={t("features.candidates")} features={candidates} data={data} partial />
      </div>
    );
  }
  return (
    <div className="columns">
      <FeatureColumn title={t("features.core")} features={data.features.filter((f) => f.tier === "core")} data={data} />
      <FeatureColumn
        title={t("features.secondary")}
        features={data.features.filter((f) => f.tier === "secondary")}
        data={data}
      />
    </div>
  );
}

export function FeaturesView() {
  return (
    <ViewFrame view="features" aiAware>
      {(data) => <FeaturesBody data={data} />}
    </ViewFrame>
  );
}
