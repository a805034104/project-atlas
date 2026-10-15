import type { StartupData, StartupGuide } from "@project-atlas/core";
import { useI18n } from "../i18n.js";

import { CommandButton, CopyButton, EmptyState, SourceLink, sourceText } from "../components/common.js";
import { ViewFrame } from "../components/ViewFrame.js";

function Guide({ guide, index }: { guide: StartupGuide; index: number }) {
  const { t } = useI18n();
  const id = `startup-${index}`;
  return (
    <section className="startup-guide" aria-labelledby={id}>
      <h2 id={id} className="code">
        {guide.target}
      </h2>

      <h3 className="subtle">{t("startup.prereqs")}</h3>
      {guide.prerequisites.length === 0 ? (
        <p className="muted">{t("common.none")}</p>
      ) : (
        <ul className="plain-list">
          {guide.prerequisites.map((p, i) => (
            <li key={i}>
              {p.name}
              {p.version ? <span className="code"> {p.version}</span> : null}
              <span className="muted"> · </span>
              <SourceLink source={p.evidence} />
            </li>
          ))}
        </ul>
      )}

      <h3 className="subtle">{t("startup.steps")}</h3>
      {guide.steps.length === 0 ? (
        <p className="muted">{t("common.none")}</p>
      ) : (
        <ol className="command-list">
          {guide.steps.map((s, i) => (
            <li key={i}>
              <code className="command">{s.command}</code>
              <CopyButton text={s.command} />
              <span className="muted"> {s.cwd ? `${t("startup.cwd", { cwd: s.cwd })} · ` : ""}</span>
              <SourceLink source={s.evidence} />
            </li>
          ))}
        </ol>
      )}

      <h3 className="subtle">{t("startup.ports")}</h3>
      {guide.ports.length === 0 ? (
        <p className="muted">{t("common.none")}</p>
      ) : (
        <ul className="plain-list">
          {guide.ports.map((p, i) => (
            <li key={i}>
              <span className="code">{p.port}</span>
              <span className="muted"> · </span>
              <SourceLink source={p.evidence} />
            </li>
          ))}
        </ul>
      )}

      <h3 className="subtle">{t("startup.config")}</h3>
      {guide.configFiles.length === 0 ? (
        <p className="muted">{t("common.none")}</p>
      ) : (
        <ul className="plain-list">
          {guide.configFiles.map((f, i) => (
            <li key={i}>
              <SourceLink source={f} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StartupBody({ data }: { data: StartupData }) {
  const { t } = useI18n();
  if (data.guides.length === 0) {
    return (
      <EmptyState
        title={t("startup.empty.title")}
        action={
          <CommandButton command="atlas.analyze" primary>
            {t("startup.empty.action")}
          </CommandButton>
        }
      >
        {data.inspectedFiles.length > 0 ? (
          <>
            <p className="muted">{t("startup.empty.body")}</p>
            <ul className="plain-list">
              {data.inspectedFiles.map((f) => (
                <li key={sourceText(f)}>
                  <SourceLink source={f} />
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </EmptyState>
    );
  }
  return (
    <div className="startup">
      {data.guides.map((g, i) => (
        <Guide key={`${g.target}-${i}`} guide={g} index={i} />
      ))}
    </div>
  );
}

export function StartupView() {
  return <ViewFrame view="startup">{(data) => <StartupBody data={data} />}</ViewFrame>;
}
