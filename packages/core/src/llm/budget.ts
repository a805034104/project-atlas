import { LlmBudgetExceeded, type LlmProviderName } from "./errors.js";

/**
 * Token estimation, cost planning and the hard input-token guard
 * (spec「AI 分析流程」steps 2 and 7: estimate → user confirms → send; stop at
 * the cap, default 2M input tokens).
 */

export const DEFAULT_MAX_INPUT_TOKENS = 2_000_000;

/** CJK ideographs, kana, hangul and full-width punctuation: ≈ 1 token each. */
const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/u;

export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk++;
    else other++;
  }
  // Code tokenizes densely: chars/3.5 underestimated a real RuoYi run by 28%; err on the high side.
  return cjk + Math.ceil(other / 2.75);
}

export interface ModelPrice {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
}

/**
 * First-party list prices (USD / 1M tokens). Callers may pass their own table
 * (e.g. from settings); unknown models plan with `usd: undefined`.
 */
export const PRICE_TABLE: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20 },
  "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-haiku-5-5": { inputPerMTok: 0.1, outputPerMTok: 0.5 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
};

export interface CostTask {
  phase: string;
  inputTokens: number;
  outputTokens: number;
}

export interface PhaseCost {
  phase: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** undefined when the model has no known price. */
  usd: number | undefined;
}

export interface CostPlan {
  model: string;
  phases: PhaseCost[];
  total: { calls: number; inputTokens: number; outputTokens: number; usd: number | undefined };
}

export interface PlanCostOptions {
  provider?: LlmProviderName;
  priceTable?: Readonly<Record<string, ModelPrice>>;
}

export function planCost(tasks: readonly CostTask[], model: string, options: PlanCostOptions = {}): CostPlan {
  const table = options.priceTable ?? PRICE_TABLE;
  const price: ModelPrice | undefined =
    options.provider === "ollama" ? { inputPerMTok: 0, outputPerMTok: 0 } : table[model];
  const usdOf = (input: number, output: number): number | undefined =>
    price ? (input * price.inputPerMTok + output * price.outputPerMTok) / 1_000_000 : undefined;

  const byPhase = new Map<string, { calls: number; inputTokens: number; outputTokens: number }>();
  for (const task of tasks) {
    const entry = byPhase.get(task.phase) ?? { calls: 0, inputTokens: 0, outputTokens: 0 };
    entry.calls++;
    entry.inputTokens += task.inputTokens;
    entry.outputTokens += task.outputTokens;
    byPhase.set(task.phase, entry);
  }
  const phases: PhaseCost[] = [...byPhase].map(([phase, e]) => ({
    phase,
    ...e,
    usd: usdOf(e.inputTokens, e.outputTokens),
  }));
  const inputTokens = phases.reduce((sum, p) => sum + p.inputTokens, 0);
  const outputTokens = phases.reduce((sum, p) => sum + p.outputTokens, 0);
  const calls = phases.reduce((sum, p) => sum + p.calls, 0);
  return { model, phases, total: { calls, inputTokens, outputTokens, usd: usdOf(inputTokens, outputTokens) } };
}

/**
 * Cumulative input-token guard. `reserve` before a call (with the estimate),
 * `settle` after it with the provider-reported count, `release` if the call
 * never reached the provider.
 */
export class TokenBudget {
  private used = 0;

  constructor(readonly maxInputTokens: number = DEFAULT_MAX_INPUT_TOKENS) {}

  get usedInputTokens(): number {
    return this.used;
  }

  reserve(estimatedInputTokens: number): void {
    if (this.used + estimatedInputTokens > this.maxInputTokens) {
      throw new LlmBudgetExceeded(this.used, estimatedInputTokens, this.maxInputTokens);
    }
    this.used += estimatedInputTokens;
  }

  settle(estimatedInputTokens: number, actualInputTokens: number): void {
    // Providers that report 0 (e.g. Ollama without eval counts) keep the estimate.
    if (actualInputTokens > 0) this.used += actualInputTokens - estimatedInputTokens;
  }

  release(estimatedInputTokens: number): void {
    this.used = Math.max(0, this.used - estimatedInputTokens);
  }
}
