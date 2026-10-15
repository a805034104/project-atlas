import {
  LlmAuthError,
  LlmEmptyError,
  LlmRateLimitError,
  LlmSchemaError,
  LlmTransportError,
  LlmUnreachableError,
  isAbortError,
  scrubSecrets,
  type LlmProviderName,
} from "./errors.js";

/**
 * BYO-key providers over plain `fetch` (no SDK dependencies).
 *
 *   complete(req) ─▶ build body ─▶ fetch (timeout ∧ caller signal)
 *                                    ├─ throws  → unreachable | transport | abort (rethrown as-is)
 *                                    ├─ !ok     → auth | rate-limit | transport | schema(4xx)
 *                                    └─ ok      → parse envelope → { text, usage } | empty
 *
 * The API key only ever travels in request headers; it is never placed in the
 * body, in URLs, or in any error message.
 */

export interface LlmRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
  signal?: AbortSignal;
}

export interface LlmResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmProvider {
  readonly name: LlmProviderName;
  readonly model: string;
  readonly baseUrl: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

export interface ProviderConfig {
  provider: LlmProviderName;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  /** Per-request timeout; defaults to 120 s. */
  timeoutMs?: number;
}

export const DEFAULT_MODELS: Record<LlmProviderName, string | undefined> = {
  anthropic: "claude-sonnet-5-5",
  "openai-compatible": undefined,
  ollama: "qwen2.5-coder:7b",
};

export const DEFAULT_BASE_URLS: Record<LlmProviderName, string | undefined> = {
  anthropic: "https://api.anthropic.com",
  "openai-compatible": undefined,
  ollama: "http://localhost:11434",
};

const DEFAULT_TIMEOUT_MS = 120_000;
const UNREACHABLE_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);

export function createProvider(cfg: ProviderConfig, fetchImpl: typeof fetch = globalThis.fetch): LlmProvider {
  const model = cfg.model ?? DEFAULT_MODELS[cfg.provider];
  if (!model) throw new Error(`createProvider: "model" is required for provider ${cfg.provider}`);
  const rawBase = cfg.baseUrl ?? DEFAULT_BASE_URLS[cfg.provider];
  if (!rawBase) throw new Error(`createProvider: "baseUrl" is required for provider ${cfg.provider}`);
  const baseUrl = rawBase.replace(/\/+$/, "");
  if ((cfg.provider === "anthropic" || cfg.provider === "openai-compatible") && !cfg.apiKey) {
    throw new Error(`createProvider: "apiKey" is required for provider ${cfg.provider}`);
  }
  const dialect = DIALECTS[cfg.provider];
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const secrets = [cfg.apiKey];

  return {
    name: cfg.provider,
    model,
    baseUrl,
    async complete(request: LlmRequest): Promise<LlmResponse> {
      request.signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
      const url = `${baseUrl}${dialect.path}`;

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: dialect.headers(cfg.apiKey),
          body: JSON.stringify(dialect.body(model, request)),
          signal,
        });
      } catch (error) {
        throw classifyFetchFailure(error, cfg.provider, baseUrl, request.signal, timeout, secrets);
      }

      let raw: string;
      try {
        raw = await response.text();
      } catch (error) {
        throw classifyFetchFailure(error, cfg.provider, baseUrl, request.signal, timeout, secrets);
      }

      if (!response.ok) throw classifyHttpError(cfg.provider, response, raw, secrets);

      let envelope: unknown;
      try {
        envelope = JSON.parse(raw);
      } catch {
        throw new LlmTransportError(cfg.provider, "bad-response", "response body is not JSON", response.status);
      }
      return dialect.parse(cfg.provider, envelope);
    },
  };
}

interface Dialect {
  path: string;
  headers(apiKey: string | undefined): Record<string, string>;
  body(model: string, request: LlmRequest): unknown;
  parse(provider: LlmProviderName, envelope: unknown): LlmResponse;
}

const DIALECTS: Record<LlmProviderName, Dialect> = {
  anthropic: {
    path: "/v1/messages",
    headers: (apiKey) => ({
      "content-type": "application/json",
      "x-api-key": apiKey ?? "",
      "anthropic-version": "2023-06-01",
    }),
    body: (model, request) => ({
      model,
      max_tokens: request.maxOutputTokens,
      system: request.system,
      messages: [{ role: "user", content: request.user }],
    }),
    parse(provider, envelope) {
      const env = asRecord(envelope);
      if (env.stop_reason === "refusal") throw new LlmEmptyError(provider, "refusal");
      const content = Array.isArray(env.content) ? env.content : [];
      const text = content
        .map((block) => asRecord(block))
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("");
      const usage = asRecord(env.usage);
      return finish(provider, text, usage.input_tokens, usage.output_tokens, env.stop_reason === "max_tokens");
    },
  },
  "openai-compatible": {
    path: "/chat/completions",
    headers: (apiKey) => ({
      "content-type": "application/json",
      authorization: `Bearer ${apiKey ?? ""}`,
    }),
    body: (model, request) => ({
      model,
      max_tokens: request.maxOutputTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
    }),
    parse(provider, envelope) {
      const env = asRecord(envelope);
      const choice = asRecord(Array.isArray(env.choices) ? env.choices[0] : undefined);
      const message = asRecord(choice.message);
      if (choice.finish_reason === "content_filter" || (typeof message.refusal === "string" && message.refusal)) {
        throw new LlmEmptyError(provider, "refusal");
      }
      const text = typeof message.content === "string" ? message.content : "";
      const usage = asRecord(env.usage);
      return finish(provider, text, usage.prompt_tokens, usage.completion_tokens, choice.finish_reason === "length");
    },
  },
  ollama: {
    path: "/api/chat",
    headers: () => ({ "content-type": "application/json" }),
    body: (model, request) => ({
      model,
      stream: false,
      format: "json",
      options: { num_predict: request.maxOutputTokens },
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
    }),
    parse(provider, envelope) {
      const env = asRecord(envelope);
      const message = asRecord(env.message);
      const text = typeof message.content === "string" ? message.content : "";
      return finish(provider, text, env.prompt_eval_count, env.eval_count, env.done_reason === "length");
    },
  },
};

function finish(
  provider: LlmProviderName,
  text: string,
  inputTokens: unknown,
  outputTokens: unknown,
  truncated: boolean,
): LlmResponse {
  if (text.trim().length === 0) throw new LlmEmptyError(provider, truncated ? "truncated" : "empty");
  return { text, inputTokens: toCount(inputTokens), outputTokens: toCount(outputTokens) };
}

function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function classifyFetchFailure(
  error: unknown,
  provider: LlmProviderName,
  baseUrl: string,
  callerSignal: AbortSignal | undefined,
  timeout: AbortSignal,
  secrets: readonly (string | undefined)[],
): Error {
  if (callerSignal?.aborted) {
    const reason: unknown = callerSignal.reason;
    return reason instanceof Error ? reason : new DOMException("The operation was aborted.", "AbortError");
  }
  if (timeout.aborted || (error instanceof Error && error.name === "TimeoutError")) {
    return new LlmTransportError(provider, "timeout", "no response before the request timeout");
  }
  if (isAbortError(error)) return error as Error;
  const code = errorCode(error);
  if (code && UNREACHABLE_CODES.has(code)) return new LlmUnreachableError(provider, baseUrl, code);
  const message = error instanceof Error ? error.message : String(error);
  return new LlmTransportError(provider, "network", scrubSecrets(code ? `${code}: ${message}` : message, secrets));
}

/** Node's fetch wraps socket errors: TypeError("fetch failed", { cause: { code } }). */
function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function classifyHttpError(
  provider: LlmProviderName,
  response: Response,
  raw: string,
  secrets: readonly (string | undefined)[],
): Error {
  const detail = scrubSecrets(extractErrorMessage(raw), secrets);
  const status = response.status;
  if (status === 401 || status === 403) return new LlmAuthError(provider, status, detail);
  if (status === 429) return new LlmRateLimitError(provider, parseRetryAfter(response.headers.get("retry-after")), detail);
  if (status === 408 || status >= 500) return new LlmTransportError(provider, "server-error", detail, status);
  // Other 4xx (400 bad request, 404 unknown model, 413 too large): the request
  // itself is wrong; retrying the same bytes cannot help.
  return new LlmSchemaError(`${provider} rejected the request (HTTP ${status})${detail ? `: ${detail}` : ""}`);
}

function extractErrorMessage(raw: string): string {
  try {
    const body = asRecord(JSON.parse(raw));
    const err = body.error;
    if (typeof err === "string") return err;
    const message = asRecord(err).message;
    if (typeof message === "string") return message;
    if (typeof body.message === "string") return body.message;
  } catch {
    // not JSON — fall through to the raw text
  }
  return raw.trim();
}

/** `retry-after` is either delta-seconds or an HTTP date. */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}
