import type { ReactNode } from "react";
import type { SourceRef, UserFacingError, WebviewCommand } from "@project-atlas/core";
import { asWebviewCommand } from "../bridge.js";
import { useI18n } from "../i18n.js";
import { useApp } from "../state.js";

export function sourceText(ref: SourceRef): string {
  return ref.line !== undefined ? `${ref.file}:${ref.line}` : ref.file;
}

/** Clickable evidence: opens the file beside the panel (host decides the column). */
export function SourceLink({ source, label }: { source: SourceRef; label?: string }) {
  const { send } = useApp();
  const { t } = useI18n();
  const text = sourceText(source);
  return (
    <button
      type="button"
      className="link code"
      title={t("common.open", { file: text })}
      aria-label={t("common.open", { file: text })}
      onClick={() => send({ type: "openSource", ref: source })}
    >
      {label ?? text}
    </button>
  );
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const { send } = useApp();
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="secondary small"
      aria-label={label ?? t("common.copyCommand", { cmd: text })}
      title={label ?? t("common.copyCommand", { cmd: text })}
      onClick={() => send({ type: "copyText", text })}
    >
      {t("common.copy")}
    </button>
  );
}

export function CommandButton({
  command,
  children,
  primary = false,
}: {
  command: WebviewCommand;
  children: ReactNode;
  primary?: boolean;
}) {
  const { send } = useApp();
  return (
    <button type="button" className={primary ? "primary" : "secondary"} onClick={() => send({ type: "runCommand", command })}>
      {children}
    </button>
  );
}

export function Skeleton({ rows = 3, label }: { rows?: number; label?: string }) {
  const { t } = useI18n();
  return (
    <div className="skeleton" role="status" aria-busy="true" aria-label={label ?? t("state.loading")}>
      {Array.from({ length: rows }, (_, i) => (
        <section key={i} className="skeleton-section">
          <div className="skeleton-line wide" />
          <div className="skeleton-line" />
          <div className="skeleton-line short" />
        </section>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
  children,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state" data-state="empty">
      <h2>{title}</h2>
      {body ? <p className="muted">{body}</p> : null}
      {children}
      {action ? <div className="actions">{action}</div> : null}
    </div>
  );
}

export function ErrorPanel({ error, onDismiss }: { error: UserFacingError; onDismiss?: () => void }) {
  const { send, state } = useApp();
  const { t } = useI18n();
  const fix = asWebviewCommand(error.fixCommand);
  const diagnostics = JSON.stringify(
    {
      error,
      analysis: state.analysis
        ? { status: state.analysis.status, completedPhases: state.analysis.completedPhases, ai: state.analysis.ai }
        : null,
      locale: state.locale,
    },
    null,
    2,
  );
  const safeDocs = /^https:\/\//.test(error.docsUrl) ? error.docsUrl : undefined;
  return (
    <div className="error-panel" role="alert" data-state="error">
      <h2>
        <span className="code">{error.code}</span> {error.problem}
      </h2>
      <dl>
        <dt>{t("error.cause")}</dt>
        <dd>{error.cause}</dd>
        <dt>{t("error.fix")}</dt>
        <dd>{error.fix}</dd>
      </dl>
      <div className="actions">
        {fix ? (
          <button type="button" className="primary" onClick={() => send({ type: "runCommand", command: fix })}>
            {t("error.runFix")}
          </button>
        ) : null}
        {safeDocs ? (
          <a href={safeDocs} className="link" target="_blank" rel="noreferrer">
            {t("error.docs")}
          </a>
        ) : null}
        <button type="button" className="secondary" onClick={() => send({ type: "copyText", text: diagnostics })}>
          {t("error.copy")}
        </button>
        {onDismiss ? (
          <button type="button" className="secondary" onClick={onDismiss}>
            {t("error.dismiss")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function Banner({
  kind,
  children,
  action,
}: {
  kind: "stale" | "partial" | "info";
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`banner banner-${kind}`} role="status" data-banner={kind}>
      <span>{children}</span>
      {action}
    </div>
  );
}

/** AI-generated markdown is shown as plain-text paragraphs; never parsed as HTML. */
export function PlainText({ text }: { text: string }) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return (
    <div className="plain-text">
      {paragraphs.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </div>
  );
}

export function ViewToggle({
  listView,
  onChange,
  disabled = false,
  listLabel,
}: {
  listView: boolean;
  onChange(list: boolean): void;
  disabled?: boolean;
  listLabel?: string;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="secondary small"
      aria-pressed={listView}
      disabled={disabled}
      onClick={() => onChange(!listView)}
    >
      {listView ? t("common.graphView") : (listLabel ?? t("common.listView"))}
    </button>
  );
}
