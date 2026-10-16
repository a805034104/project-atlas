import type { UserFacingError } from "../protocol.js";

/**
 * Typed LLM errors (spec CEO Section 2 error table + DX Pass 3 ATLAS-E02x).
 *
 *   status / failure            class                 code        retry policy (retry.ts)
 *   ─────────────────────────   ───────────────────   ─────────   ─────────────────────────
 *   401 / 403                   LlmAuthError          ATLAS-E020  never; aborts the pipeline
 *   ECONNREFUSED / DNS          LlmUnreachableError   ATLAS-E021  never; aborts the pipeline
 *   token budget reached        LlmBudgetExceeded     ATLAS-E022  never; caller asks the user
 *   429                         LlmRateLimitError     ATLAS-E023  retry-after + backoff, 3x
 *   timeout / 5xx / reset       LlmTransportError     ATLAS-E024  2x
 *   invalid JSON / shape        LlmSchemaError        ATLAS-E025  pipeline re-asks once
 *   empty / refusal             LlmEmptyError         ATLAS-E026  pipeline re-asks once
 *
 * Messages never contain the API key: provider bodies are scrubbed before they
 * are quoted (see scrubSecrets).
 */

export const ERRORS_DOCS_BASE = "https://github.com/a805034104/project-atlas/blob/main/docs/errors.md#";

export function docsUrlFor(code: string): string {
  return `${ERRORS_DOCS_BASE}${code.toLowerCase()}`;
}

export type LlmProviderName = "anthropic" | "openai-compatible" | "ollama";

const PROVIDER_LABEL: Record<LlmProviderName, string> = {
  anthropic: "Anthropic",
  "openai-compatible": "OpenAI-compatible endpoint",
  ollama: "Ollama",
};

export function providerLabel(provider: LlmProviderName): string {
  return PROVIDER_LABEL[provider];
}

export abstract class LlmError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }

  abstract toUserFacing(): UserFacingError;
}

export class LlmAuthError extends LlmError {
  readonly code = "ATLAS-E020";

  constructor(
    readonly provider: LlmProviderName,
    readonly status: number,
    readonly detail = "",
    /** 403 issued before the key is checked (unsupported country/region or a blocked network). */
    readonly networkBlocked = false,
  ) {
    super(`${providerLabel(provider)} rejected the ${networkBlocked ? "request" : "API key"} (HTTP ${status})${detail ? `: ${detail}` : ""}`);
  }

  toUserFacing(): UserFacingError {
    if (this.networkBlocked) {
      return {
        code: this.code,
        problem: `${providerLabel(this.provider)} refused the connection (HTTP ${this.status}) before checking the API key.`,
        cause: `${this.detail || "Request not allowed"}: the request left from a country or network the provider does not serve.`,
        fix: "Route the request through a proxy in a supported region (VS Code: `http.proxy`; CLI: set HTTPS_PROXY), or use an OpenAI-compatible or Ollama provider.",
        docsUrl: docsUrlFor(this.code),
      };
    }
    return {
      code: this.code,
      problem: `${providerLabel(this.provider)} returned ${this.status} (API key invalid, revoked or lacking permission).`,
      cause: this.detail || "The configured API key was not accepted.",
      fix: "Run `atlas.configureProvider` to enter a valid key. The deterministic map stays available.",
      docsUrl: docsUrlFor(this.code),
      fixCommand: "atlas.configureProvider",
    };
  }
}

export class LlmUnreachableError extends LlmError {
  readonly code = "ATLAS-E021";

  constructor(
    readonly provider: LlmProviderName,
    readonly baseUrl: string,
    readonly detail = "",
  ) {
    super(`Cannot reach ${providerLabel(provider)} at ${baseUrl}${detail ? ` (${detail})` : ""}`);
  }

  toUserFacing(): UserFacingError {
    const ollama = this.provider === "ollama";
    return {
      code: this.code,
      problem: `Cannot connect to ${this.baseUrl}.`,
      cause: this.detail || "Connection refused or host not found.",
      fix: ollama
        ? "Run `ollama serve`, then retry. Check `atlas.llm.baseUrl` if Ollama listens elsewhere."
        : "Check `atlas.llm.baseUrl` and your network or proxy settings, then retry.",
      docsUrl: docsUrlFor(this.code),
    };
  }
}

export class LlmBudgetExceeded extends LlmError {
  readonly code = "ATLAS-E022";

  constructor(
    readonly usedInputTokens: number,
    readonly requestedInputTokens: number,
    readonly maxInputTokens: number,
  ) {
    super(
      `Token budget reached: ${usedInputTokens} used + ${requestedInputTokens} requested > ${maxInputTokens} max input tokens`,
    );
  }

  toUserFacing(): UserFacingError {
    return {
      code: this.code,
      problem: `This analysis reached its input token limit (${this.maxInputTokens.toLocaleString("en-US")}).`,
      cause: `${this.usedInputTokens.toLocaleString("en-US")} tokens were already sent; the next request needs ${this.requestedInputTokens.toLocaleString("en-US")} more.`,
      fix: "Raise `atlas.llm.maxInputTokens`, or exclude directories via `.atlasignore`.",
      docsUrl: docsUrlFor(this.code),
    };
  }
}

export class LlmRateLimitError extends LlmError {
  readonly code = "ATLAS-E023";

  constructor(
    readonly provider: LlmProviderName,
    /** Parsed from `retry-after`; undefined when the header is absent or unparsable. */
    readonly retryAfterMs: number | undefined,
    readonly detail = "",
  ) {
    super(`${providerLabel(provider)} rate-limited the request (HTTP 429)${detail ? `: ${detail}` : ""}`);
  }

  toUserFacing(): UserFacingError {
    return {
      code: this.code,
      problem: `${providerLabel(this.provider)} is rate-limiting requests (HTTP 429).`,
      cause: this.detail || "Too many requests or tokens per minute for this key.",
      fix: "Atlas backs off automatically. Lower `atlas.llm.concurrency` if this keeps happening.",
      docsUrl: docsUrlFor(this.code),
    };
  }
}

export class LlmTransportError extends LlmError {
  readonly code = "ATLAS-E024";

  constructor(
    readonly provider: LlmProviderName,
    readonly reason: "timeout" | "server-error" | "network" | "bad-response",
    readonly detail = "",
    readonly status?: number,
  ) {
    super(`${providerLabel(provider)} request failed (${reason}${status ? ` ${status}` : ""})${detail ? `: ${detail}` : ""}`);
  }

  toUserFacing(): UserFacingError {
    return {
      code: this.code,
      problem: `A request to ${providerLabel(this.provider)} failed (${this.reason}${this.status ? ` HTTP ${this.status}` : ""}).`,
      cause: this.detail || "Timeout, server error or dropped connection.",
      fix: "Retry the analysis; completed summaries are cached and will not be re-sent.",
      docsUrl: docsUrlFor(this.code),
      fixCommand: "atlas.analyze",
    };
  }
}

export class LlmSchemaError extends LlmError {
  readonly code = "ATLAS-E025";

  constructor(readonly detail: string) {
    super(`LLM output did not match the expected JSON shape: ${detail}`);
  }

  toUserFacing(): UserFacingError {
    return {
      code: this.code,
      problem: "The model returned output Atlas could not use (invalid JSON or wrong shape).",
      cause: this.detail,
      fix: "Retry, or switch to a larger model. This section shows “AI summary unavailable”.",
      docsUrl: docsUrlFor(this.code),
    };
  }
}

export class LlmEmptyError extends LlmError {
  readonly code = "ATLAS-E026";

  constructor(
    readonly provider: LlmProviderName,
    readonly reason: "empty" | "refusal" | "truncated",
  ) {
    super(`${providerLabel(provider)} returned no usable output (${reason})`);
  }

  toUserFacing(): UserFacingError {
    return {
      code: this.code,
      problem: `The model returned no usable output (${this.reason}).`,
      cause:
        this.reason === "refusal"
          ? "The provider declined the request."
          : this.reason === "truncated"
            ? "The output hit the token limit before the JSON was complete."
            : "The response contained no text.",
      fix: "Retry, or switch models. This section shows “AI summary unavailable”.",
      docsUrl: docsUrlFor(this.code),
    };
  }
}

/** Errors after which no further LLM call can succeed: the pipeline aborts. */
export function isFatalLlmError(error: unknown): boolean {
  return (
    error instanceof LlmAuthError || error instanceof LlmUnreachableError || error instanceof LlmBudgetExceeded
  );
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Remove anything key-shaped from text that is about to be quoted in an error.
 * `secrets` are exact strings (the configured key); the patterns catch keys a
 * provider might echo back partially masked (e.g. `sk-abc***xyz`).
 */
export function scrubSecrets(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join("«redacted»");
  }
  out = out.replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_*.-]{4,}/g, "«redacted»");
  out = out.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "«redacted»");
  out = out.replace(/Bearer\s+\S+/gi, "Bearer «redacted»");
  return out.length > 300 ? `${out.slice(0, 300)}…` : out;
}
