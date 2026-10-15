import { LlmRateLimitError, LlmTransportError } from "./errors.js";

/**
 * Retry policy (spec CEO Section 2):
 *
 *   LlmRateLimitError  → wait max(retry-after, backoff), up to 3 retries
 *   LlmTransportError  → wait backoff, up to 2 retries
 *   anything else      → rethrow immediately (auth, unreachable, schema, empty, abort)
 *
 *   backoff(n) = min(maxDelayMs, baseDelayMs · 2^n)       n = 0, 1, 2 …
 */

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface RetryOptions {
  signal?: AbortSignal;
  sleep?: Sleep;
  maxRateLimitRetries?: number;
  maxTransportRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Called before each wait, e.g. to show「限流等待」in progress. */
  onRetry?: (info: { error: Error; attempt: number; delayMs: number }) => void;
}

export const defaultSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

function abortReason(signal: AbortSignal | undefined): unknown {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new DOMException("The operation was aborted.", "AbortError");
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const maxRateLimit = options.maxRateLimitRetries ?? 3;
  const maxTransport = options.maxTransportRetries ?? 2;
  const base = options.baseDelayMs ?? 1_000;
  const cap = options.maxDelayMs ?? 60_000;
  let rateLimitRetries = 0;
  let transportRetries = 0;

  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    try {
      return await fn(attempt);
    } catch (error) {
      let delayMs: number;
      if (error instanceof LlmRateLimitError && rateLimitRetries < maxRateLimit) {
        const backoff = Math.min(cap, base * 2 ** rateLimitRetries);
        delayMs = Math.max(error.retryAfterMs ?? 0, backoff);
        rateLimitRetries++;
      } else if (error instanceof LlmTransportError && transportRetries < maxTransport) {
        delayMs = Math.min(cap, base * 2 ** transportRetries);
        transportRetries++;
      } else {
        throw error;
      }
      options.onRetry?.({ error, attempt, delayMs });
      await sleep(delayMs, options.signal);
    }
  }
}
