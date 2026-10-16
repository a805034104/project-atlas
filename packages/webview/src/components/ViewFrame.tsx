import type { ReactNode } from "react";
import type { AnalysisState, ViewId } from "@project-atlas/core";
import { useI18n } from "../i18n.js";
import { useApp, VIEW_PHASE, type ViewDataMap } from "../state.js";
import { Banner, CommandButton, EmptyState, ErrorPanel, Skeleton } from "./common.js";

/** True when a view's data can be requested (its phase finished, or the run is over). */
export function viewReady(view: ViewId, analysis: AnalysisState | undefined): boolean {
  if (!analysis) return false;
  return analysis.completedPhases.includes(VIEW_PHASE[view]) || analysis.status === "done";
}

function AnalyzingSkeleton({ analysis, rows }: { analysis: AnalysisState; rows: number }) {
  const { t } = useI18n();
  const phase = analysis.currentPhase ? t(`phase.${analysis.currentPhase}`) : "";
  const pct = analysis.progress !== undefined ? `${Math.round(analysis.progress * 100)}%` : "";
  return (
    <div>
      {analysis.status === "running" ? (
        <div className="progress-line" role="status">
          <span>{analysis.queued ? t("state.queued") : t("state.analyzing", { phase, pct })}</span>
          <CommandButton command="atlas.cancel">{t("state.cancel")}</CommandButton>
        </div>
      ) : null}
      <Skeleton rows={rows} />
    </div>
  );
}

export function AiBanner() {
  const { state } = useApp();
  const { t } = useI18n();
  const ai = state.analysis?.ai;
  if (ai === "none" || ai === "declined") {
    return (
      <Banner kind="partial" action={<CommandButton command="atlas.configureProvider">{t("banner.aiAction")}</CommandButton>}>
        {t("banner.ai")}
      </Banner>
    );
  }
  if (ai === "error") {
    return (
      <Banner kind="partial" action={<CommandButton command="atlas.configureProvider">{t("banner.aiAction")}</CommandButton>}>
        {t("banner.aiError")}
      </Banner>
    );
  }
  return null;
}

/**
 * Implements the shared rows of the spec's state matrix for one view:
 * never analyzed → empty + Analyze; phase pending → skeleton (+ progress, cancel);
 * analysis error before the phase → UserFacingError; cancelled → empty + retry;
 * otherwise renders the view with its data. View-specific empty/partial states
 * live in the views themselves.
 */
export function ViewFrame<V extends ViewId>({
  view,
  aiAware = false,
  skeletonRows = 3,
  children,
}: {
  view: V;
  aiAware?: boolean;
  skeletonRows?: number;
  children: (data: ViewDataMap[V]) => ReactNode;
}) {
  const { state } = useApp();
  const { t } = useI18n();
  const analysis = state.analysis;
  if (!state.initialized || !analysis) return <Skeleton rows={skeletonRows} />;

  if (!viewReady(view, analysis)) {
    switch (analysis.status) {
      case "never":
        return (
          <EmptyState
            title={t("state.never.title")}
            body={t("state.never.body")}
            action={
              <CommandButton command="atlas.analyze" primary>
                {t("state.never.action")}
              </CommandButton>
            }
          />
        );
      case "error":
        return analysis.error ? (
          <ErrorPanel error={analysis.error} />
        ) : (
          <EmptyState
            title={t("state.cancelled.title")}
            action={
              <CommandButton command="atlas.analyze" primary>
                {t("state.cancelled.action")}
              </CommandButton>
            }
          />
        );
      case "cancelled":
        return (
          <EmptyState
            title={t("state.cancelled.title")}
            action={
              <CommandButton command="atlas.analyze" primary>
                {t("state.cancelled.action")}
              </CommandButton>
            }
          />
        );
      default:
        return <AnalyzingSkeleton analysis={analysis} rows={skeletonRows} />;
    }
  }

  const data = state.data[view] as ViewDataMap[V] | undefined;
  if (data === undefined) return <AnalyzingSkeleton analysis={analysis} rows={skeletonRows} />;

  return (
    <>
      {aiAware ? <AiBanner /> : null}
      {children(data)}
    </>
  );
}
