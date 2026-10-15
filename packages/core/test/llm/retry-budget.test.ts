import { describe, expect, it } from "vitest";
import {
  LlmAuthError,
  LlmBudgetExceeded,
  LlmRateLimitError,
  LlmTransportError,
  PRICE_TABLE,
  TokenBudget,
  estimateTokens,
  planCost,
  withRetry,
} from "../../src/llm/index.js";

function recorder() {
  const waits: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    waits.push(ms);
    return Promise.resolve();
  };
  return { waits, sleep };
}

describe("withRetry", () => {
  it("honors retry-after on 429 and gives up after 3 retries", async () => {
    const { waits, sleep } = recorder();
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls++;
          return Promise.reject(new LlmRateLimitError("anthropic", 5000));
        },
        { sleep, baseDelayMs: 1000 },
      ),
    ).rejects.toBeInstanceOf(LlmRateLimitError);
    expect(calls).toBe(4);
    expect(waits).toEqual([5000, 5000, 5000]);
  });

  it("uses exponential backoff when retry-after is absent, then succeeds", async () => {
    const { waits, sleep } = recorder();
    let calls = 0;
    const value = await withRetry(
      () => (++calls < 3 ? Promise.reject(new LlmRateLimitError("anthropic", undefined)) : Promise.resolve("ok")),
      { sleep, baseDelayMs: 100 },
    );
    expect(value).toBe("ok");
    expect(waits).toEqual([100, 200]);
  });

  it("retries transport errors twice", async () => {
    const { waits, sleep } = recorder();
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls++;
          return Promise.reject(new LlmTransportError("anthropic", "server-error", "", 503));
        },
        { sleep, baseDelayMs: 10 },
      ),
    ).rejects.toBeInstanceOf(LlmTransportError);
    expect(calls).toBe(3);
    expect(waits).toEqual([10, 20]);
  });

  it("never retries auth errors", async () => {
    const { waits, sleep } = recorder();
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls++;
          return Promise.reject(new LlmAuthError("anthropic", 401));
        },
        { sleep },
      ),
    ).rejects.toBeInstanceOf(LlmAuthError);
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it("aborts while waiting with the real sleep", async () => {
    const controller = new AbortController();
    const pending = withRetry(() => Promise.reject(new LlmRateLimitError("anthropic", 60_000)), {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("estimateTokens", () => {
  it("counts CJK as one token per char and other text at ~2.75 chars/token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("用户管理")).toBe(4);
    expect(estimateTokens("abcdefg")).toBe(3);
    expect(estimateTokens("用户 list")).toBe(2 + Math.ceil(5 / 2.75));
  });
});

describe("planCost", () => {
  const tasks = [
    { phase: "file-summary", inputTokens: 600_000, outputTokens: 100_000 },
    { phase: "file-summary", inputTokens: 400_000, outputTokens: 0 },
    { phase: "features", inputTokens: 1_000, outputTokens: 2_000 },
  ];

  it("aggregates per phase with USD from the price table", () => {
    const plan = planCost(tasks, "claude-sonnet-5-5");
    const price = PRICE_TABLE["claude-sonnet-5-5"]!;
    expect(plan.phases[0]).toEqual({
      phase: "file-summary",
      calls: 2,
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      usd: price.inputPerMTok + 0.1 * price.outputPerMTok,
    });
    expect(plan.total.inputTokens).toBe(1_001_000);
    expect(plan.total.calls).toBe(3);
    expect(plan.total.usd).toBeCloseTo(price.inputPerMTok * 1.001 + price.outputPerMTok * 0.102, 10);
  });

  it("returns usd undefined for unknown models and 0 for ollama", () => {
    expect(planCost(tasks, "mystery-model").total.usd).toBeUndefined();
    expect(planCost(tasks, "mystery-model").phases[0]!.usd).toBeUndefined();
    expect(planCost(tasks, "qwen2.5-coder:7b", { provider: "ollama" }).total.usd).toBe(0);
  });

  it("accepts a custom price table", () => {
    const plan = planCost(tasks, "deepseek-chat", { priceTable: { "deepseek-chat": { inputPerMTok: 1, outputPerMTok: 0 } } });
    expect(plan.total.usd).toBeCloseTo(1.001, 10);
  });
});

describe("TokenBudget", () => {
  it("throws LlmBudgetExceeded (ATLAS-E022) when cumulative input would exceed the cap", () => {
    const budget = new TokenBudget(100);
    budget.reserve(60);
    budget.settle(60, 50);
    expect(budget.usedInputTokens).toBe(50);
    budget.reserve(50);
    expect(() => budget.reserve(1)).toThrow(LlmBudgetExceeded);
    try {
      budget.reserve(1);
    } catch (error) {
      expect((error as LlmBudgetExceeded).toUserFacing().code).toBe("ATLAS-E022");
    }
    budget.release(50);
    expect(budget.usedInputTokens).toBe(50);
  });

  it("defaults to 2M input tokens", () => {
    expect(new TokenBudget().maxInputTokens).toBe(2_000_000);
  });
});
