import type { CostPlan } from "@project-atlas/core";

/**
 * Pure formatting for the AI cost confirmation (spec Design Pass 3: show
 * tokens + money per phase and let the user deselect phases). No vscode import
 * so it is unit-testable.
 */

export interface PhaseChoice {
  phase: string;
  label: string;
  description: string;
  picked: boolean;
}

const PHASE_LABELS: Record<string, { zh: string; en: string }> = {
  "file-summary": { zh: "文件摘要", en: "File summaries" },
  "module-summary": { zh: "模块摘要", en: "Module summaries" },
  features: { zh: "功能清单", en: "Feature list" },
  startup: { zh: "启动方式", en: "Startup guide" },
  history: { zh: "演进摘要", en: "Change history summaries" },
};

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatUsd(usd: number | undefined, zh: boolean): string {
  if (usd === undefined) return zh ? "价格未知" : "price unknown";
  if (usd === 0) return zh ? "免费（本地）" : "free (local)";
  return usd < 0.01 ? "< $0.01" : `≈ $${usd.toFixed(2)}`;
}

export function phaseChoices(plan: CostPlan, zh: boolean): PhaseChoice[] {
  return plan.phases.map((p) => ({
    phase: p.phase,
    label: (zh ? PHASE_LABELS[p.phase]?.zh : PHASE_LABELS[p.phase]?.en) ?? p.phase,
    description: `${p.calls} ${zh ? "次请求" : "calls"} · ${formatTokens(p.inputTokens)} in / ${formatTokens(p.outputTokens)} out · ${formatUsd(p.usd, zh)}`,
    picked: true,
  }));
}

export function planTitle(plan: CostPlan, zh: boolean): string {
  const total = `${formatTokens(plan.total.inputTokens)} + ${formatTokens(plan.total.outputTokens)} tokens · ${formatUsd(plan.total.usd, zh)}`;
  return zh ? `AI 分析预估（${plan.model}）：${total}。取消勾选不需要的阶段，确认后才会发送。` : `AI analysis estimate (${plan.model}): ${total}. Untick phases you don't want; nothing is sent until you confirm.`;
}
