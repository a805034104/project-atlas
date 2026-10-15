import type { OverviewData } from "@project-atlas/core";
import { useI18n } from "../i18n.js";
import { useApp } from "../state.js";
import { CommandButton, CopyButton, EmptyState, SourceLink, sourceText } from "../components/common.js";
import { ViewFrame } from "../components/ViewFrame.js";

function OverviewBody({ data }: { data: OverviewData }) {
  const { t } = useI18n();
  const { go } = useApp();
  const noStack = data.stacks.length === 0 && data.moduleCount === 0 && data.entrypointCount === 0;
  if (noStack) {
    return (
      <EmptyState
        title={t("overview.empty.title")}
        body={t("overview.empty.body")}
        action={
          <CommandButton command="atlas.diagnose" primary>
            {t("overview.empty.action")}
          </CommandButton>
        }
      />
    );
  }
  const useCandidates = data.coreFeatures.length === 0 && data.candidateFeatures.length > 0;
  const hot = [...data.hotModules].sort((a, b) => b.commits90d - a.commits90d).slice(0, 5);
  const startup = data.primaryStartup;
  const counts = { error: 0, warning: 0, info: 0 };
  for (const d of data.diagnostics) counts[d.severity] += 1;

  return (
    <div className="overview">
      <section aria-labelledby="ov-what" className="ov-section">
        <h2 id="ov-what">{t("overview.what")}</h2>
        <p className="facts">
          <strong>{data.projectName}</strong>
          {data.stacks.length > 0 ? <span className="muted"> · {data.stacks.join(" · ")}</span> : null}
          <br />
          <span className="muted">
            {t("overview.facts", {
              services: data.serviceCount,
              modules: data.moduleCount,
              entrypoints: data.entrypointCount,
            })}
          </span>
        </p>
        {useCandidates ? (
          <>
            <h3 className="subtle" data-partial="candidates">
              {t("overview.candidates")}
            </h3>
            <ul className="plain-list">
              {data.candidateFeatures.map((f) => (
                <li key={f.title}>
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      const ep = f.entrypointIds[0];
                      const mod = f.moduleIds[0];
                      if (mod !== undefined) go("modules", mod, t("tab.overview"));
                      else if (ep !== undefined) go("flow", ep, t("tab.overview"));
                    }}
                  >
                    {f.title}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : data.coreFeatures.length > 0 ? (
          <ul className="plain-list">
            {data.coreFeatures.slice(0, 5).map((f) => (
              <li key={f.id}>
                <button type="button" className="link" onClick={() => go("features", f.id, t("tab.overview"))}>
                  {f.title}
                </button>
                <span className="muted"> — {f.description}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{t("overview.noFeatures")}</p>
        )}
      </section>

      <section aria-labelledby="ov-how" className="ov-section">
        <h2 id="ov-how">{t("overview.how")}</h2>
        {startup && startup.steps.length > 0 ? (
          <>
            <p className="muted code">{startup.target}</p>
            <ol className="command-list">
              {startup.steps.map((s, i) => (
                <li key={i}>
                  <code className="command">{s.command}</code>
                  <CopyButton text={s.command} />
                  <span className="muted"> {s.cwd ? `${t("startup.cwd", { cwd: s.cwd })} · ` : ""}</span>
                  <SourceLink source={s.evidence} />
                </li>
              ))}
            </ol>
          </>
        ) : (
          <p className="muted">
            {t("overview.noStartup")}{" "}
            <button type="button" className="link" onClick={() => go("startup", undefined, t("tab.overview"))}>
              {t("overview.openStartup")}
            </button>
          </p>
        )}
      </section>

      <section aria-labelledby="ov-heat" className="ov-section">
        <h2 id="ov-heat">{t("overview.heat")}</h2>
        {hot.length > 0 && hot.some((h) => h.commits90d > 0) ? (
          <ol className="plain-list">
            {hot.map((h) => (
              <li key={h.module.id}>
                <button type="button" className="link code" onClick={() => go("modules", h.module.id, t("tab.overview"))}>
                  {h.module.name}
                </button>
                <span className="muted"> — {t("overview.commits90d", { n: h.commits90d })}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">{t("overview.noHot")}</p>
        )}
      </section>

      <details className="ov-section diagnostics">
        <summary>
          {t("overview.diagnostics", { n: data.diagnostics.length })}
          {data.diagnostics.length > 0 ? (
            <span className="muted">
              {" "}
              · {t("severity.error")} {counts.error} · {t("severity.warning")} {counts.warning} · {t("severity.info")}{" "}
              {counts.info}
            </span>
          ) : null}
        </summary>
        {data.diagnostics.length === 0 ? (
          <p className="muted">{t("overview.noDiagnostics")}</p>
        ) : (
          <ul className="plain-list">
            {data.diagnostics.map((d, i) => (
              <li key={i} className={`sev-${d.severity}`}>
                <span className="code">{d.code}</span> [{t(`severity.${d.severity}`)}] {d.message}{" "}
                {d.at ? <SourceLink source={d.at} label={sourceText(d.at)} /> : null}
              </li>
            ))}
          </ul>
        )}
        {data.llmUsage.length > 0 ? (
          <>
            <h3 className="subtle">{t("overview.llmUsage")}</h3>
            <ul className="plain-list">
              {data.llmUsage.map((u, i) => (
                <li key={i}>
                  <span className="code">
                    {u.provider}/{u.model}
                  </span>{" "}
                  · {u.phase} · {t("overview.tokens", { in: u.inputTokens, out: u.outputTokens })}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </details>
    </div>
  );
}

export function OverviewView() {
  return (
    <ViewFrame view="overview" aiAware skeletonRows={3}>
      {(data) => <OverviewBody data={data} />}
    </ViewFrame>
  );
}
