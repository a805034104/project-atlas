import { describe, expect, it } from "vitest";
import {
  LlmAuthError,
  LlmEmptyError,
  LlmRateLimitError,
  LlmSchemaError,
  LlmTransportError,
  LlmUnreachableError,
  createProvider,
  parseRetryAfter,
} from "../../src/llm/index.js";
import { anthropicReply, connectionRefused, fakeFetch, hang } from "./fake-fetch.js";

const KEY = "sk-ant-api03-SUPERSECRETKEY0123456789abcdef";
const req = { system: "SYS", user: "USER", maxOutputTokens: 123 };

async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected rejection");
}

function assertNoKey(error: Error): void {
  expect(error.message).not.toContain(KEY);
  expect(JSON.stringify((error as { toUserFacing?: () => unknown }).toUserFacing?.() ?? {})).not.toContain(KEY);
  expect(error.message).not.toContain("SUPERSECRET");
}

describe("anthropic provider", () => {
  it("maps request and response", async () => {
    const fetch = fakeFetch({
      json: {
        content: [
          { type: "text", text: '{"summary":' },
          { type: "thinking", thinking: "" },
          { type: "text", text: '"x"}' },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 42, output_tokens: 7 },
      },
    });
    const provider = createProvider({ provider: "anthropic", apiKey: KEY }, fetch);
    expect(provider.model).toBe("claude-sonnet-5-5");
    const res = await provider.complete(req);
    expect(res).toEqual({ text: '{"summary":"x"}', inputTokens: 42, outputTokens: 7 });

    const call = fetch.calls[0]!;
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.headers["x-api-key"]).toBe(KEY);
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.body).toEqual({
      model: "claude-sonnet-5-5",
      max_tokens: 123,
      system: "SYS",
      messages: [{ role: "user", content: "USER" }],
    });
    // the key travels only in headers
    expect(call.rawBody).not.toContain(KEY);
    expect(call.url).not.toContain(KEY);
  });

  it("honors baseUrl and model overrides", async () => {
    const fetch = fakeFetch(anthropicReply("{}"));
    const provider = createProvider(
      { provider: "anthropic", apiKey: KEY, baseUrl: "https://proxy.example/", model: "claude-opus-5-5" },
      fetch,
    );
    await provider.complete(req);
    expect(fetch.calls[0]!.url).toBe("https://proxy.example/v1/messages");
    expect((fetch.calls[0]!.body as { model: string }).model).toBe("claude-opus-5-5");
  });

  it("treats refusal as LlmEmptyError", async () => {
    const fetch = fakeFetch({ json: { content: [], stop_reason: "refusal", usage: {} } });
    const error = await caught(createProvider({ provider: "anthropic", apiKey: KEY }, fetch).complete(req));
    expect(error).toBeInstanceOf(LlmEmptyError);
    expect((error as LlmEmptyError).reason).toBe("refusal");
  });

  it("treats empty content as LlmEmptyError", async () => {
    const fetch = fakeFetch({ json: { content: [{ type: "text", text: "  " }], stop_reason: "end_turn" } });
    const error = await caught(createProvider({ provider: "anthropic", apiKey: KEY }, fetch).complete(req));
    expect(error).toBeInstanceOf(LlmEmptyError);
    expect((error as LlmEmptyError).code).toBe("ATLAS-E026");
  });
});

describe("openai-compatible provider", () => {
  it("maps request and response", async () => {
    const fetch = fakeFetch({
      json: {
        choices: [{ message: { role: "assistant", content: '{"a":1}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 11, completion_tokens: 3 },
      },
    });
    const provider = createProvider(
      { provider: "openai-compatible", apiKey: KEY, baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
      fetch,
    );
    expect(await provider.complete(req)).toEqual({ text: '{"a":1}', inputTokens: 11, outputTokens: 3 });
    const call = fetch.calls[0]!;
    expect(call.url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call.body).toEqual({
      model: "deepseek-chat",
      max_tokens: 123,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "SYS" },
        { role: "user", content: "USER" },
      ],
    });
    expect(call.rawBody).not.toContain(KEY);
  });

  it("requires baseUrl, model and key", () => {
    expect(() => createProvider({ provider: "openai-compatible", apiKey: KEY, model: "m" })).toThrow(/baseUrl/);
    expect(() => createProvider({ provider: "openai-compatible", apiKey: KEY, baseUrl: "https://x" })).toThrow(/model/);
    expect(() => createProvider({ provider: "openai-compatible", baseUrl: "https://x", model: "m" })).toThrow(/apiKey/);
  });

  it("maps content_filter to refusal", async () => {
    const fetch = fakeFetch({ json: { choices: [{ message: { content: "" }, finish_reason: "content_filter" }] } });
    const provider = createProvider({ provider: "openai-compatible", apiKey: KEY, baseUrl: "https://x", model: "m" }, fetch);
    const error = await caught(provider.complete(req));
    expect(error).toBeInstanceOf(LlmEmptyError);
  });
});

describe("ollama provider", () => {
  it("maps request and response", async () => {
    const fetch = fakeFetch({
      json: { message: { role: "assistant", content: '{"x":true}' }, done: true, prompt_eval_count: 99, eval_count: 9 },
    });
    const provider = createProvider({ provider: "ollama" }, fetch);
    expect(provider.model).toBe("qwen2.5-coder:7b");
    expect(await provider.complete(req)).toEqual({ text: '{"x":true}', inputTokens: 99, outputTokens: 9 });
    const call = fetch.calls[0]!;
    expect(call.url).toBe("http://localhost:11434/api/chat");
    expect(call.headers.authorization).toBeUndefined();
    expect(call.body).toMatchObject({
      model: "qwen2.5-coder:7b",
      stream: false,
      format: "json",
      messages: [
        { role: "system", content: "SYS" },
        { role: "user", content: "USER" },
      ],
    });
  });

  it("maps connection refused to ATLAS-E021 with an `ollama serve` hint", async () => {
    const error = await caught(createProvider({ provider: "ollama" }, fakeFetch(connectionRefused())).complete(req));
    expect(error).toBeInstanceOf(LlmUnreachableError);
    const uf = (error as LlmUnreachableError).toUserFacing();
    expect(uf.code).toBe("ATLAS-E021");
    expect(uf.fix).toContain("ollama serve");
    expect(uf.problem).toContain("http://localhost:11434");
    expect(uf.docsUrl).toBe("https://github.com/project-atlas/project-atlas/blob/main/docs/errors.md#atlas-e021");
  });
});

describe("HTTP error mapping", () => {
  const anthropic = (fetch: typeof globalThis.fetch) => createProvider({ provider: "anthropic", apiKey: KEY }, fetch);

  it.each([401, 403])("%i → LlmAuthError (ATLAS-E020), key never echoed", async (status) => {
    const fetch = fakeFetch({
      status,
      json: { type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${KEY}` } },
    });
    const error = await caught(anthropic(fetch).complete(req));
    expect(error).toBeInstanceOf(LlmAuthError);
    const uf = (error as LlmAuthError).toUserFacing();
    expect(uf.code).toBe("ATLAS-E020");
    expect(uf.fixCommand).toBe("atlas.configureProvider");
    expect(uf.docsUrl).toMatch(/errors\.md#atlas-e020$/);
    assertNoKey(error);
  });

  it("scrubs partially masked keys echoed by OpenAI-style errors", async () => {
    const fetch = fakeFetch({ status: 401, json: { error: { message: "Incorrect API key provided: sk-SUPERSE********cdef" } } });
    const provider = createProvider({ provider: "openai-compatible", apiKey: KEY, baseUrl: "https://x", model: "m" }, fetch);
    const error = await caught(provider.complete(req));
    expect(error.message).not.toContain("sk-SUPERSE");
  });

  it("429 → LlmRateLimitError with retryAfterMs", async () => {
    const fetch = fakeFetch({ status: 429, headers: { "retry-after": "7" }, json: { error: { message: "slow down" } } });
    const error = await caught(anthropic(fetch).complete(req));
    expect(error).toBeInstanceOf(LlmRateLimitError);
    expect((error as LlmRateLimitError).retryAfterMs).toBe(7000);
    expect((error as LlmRateLimitError).toUserFacing().code).toBe("ATLAS-E023");
  });

  it("500 → LlmTransportError", async () => {
    const error = await caught(anthropic(fakeFetch({ status: 500, text: "upstream exploded" })).complete(req));
    expect(error).toBeInstanceOf(LlmTransportError);
    expect((error as LlmTransportError).status).toBe(500);
  });

  it("400 → LlmSchemaError (request rejected, retry cannot help)", async () => {
    const error = await caught(anthropic(fakeFetch({ status: 400, json: { error: { message: "bad" } } })).complete(req));
    expect(error).toBeInstanceOf(LlmSchemaError);
  });

  it("non-JSON 200 body → LlmTransportError", async () => {
    const error = await caught(anthropic(fakeFetch({ text: "<html>gateway</html>" })).complete(req));
    expect(error).toBeInstanceOf(LlmTransportError);
  });

  it("timeout → LlmTransportError(timeout)", async () => {
    const provider = createProvider({ provider: "anthropic", apiKey: KEY, timeoutMs: 20 }, fakeFetch(hang()));
    const error = await caught(provider.complete(req));
    expect(error).toBeInstanceOf(LlmTransportError);
    expect((error as LlmTransportError).reason).toBe("timeout");
  });

  it("other network errors → LlmTransportError(network) without the key", async () => {
    const reset = new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
    const error = await caught(anthropic(fakeFetch(reset)).complete(req));
    expect(error).toBeInstanceOf(LlmTransportError);
    expect((error as LlmTransportError).reason).toBe("network");
    assertNoKey(error);
  });

  it("caller abort propagates as AbortError, not a transport error", async () => {
    const controller = new AbortController();
    const pending = anthropic(fakeFetch(hang())).complete({ ...req, signal: controller.signal });
    controller.abort();
    const error = await caught(pending);
    expect(error.name).toBe("AbortError");
  });
});

describe("parseRetryAfter", () => {
  it("parses seconds and HTTP dates", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter("0.5")).toBe(500);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
    const now = Date.parse("2026-10-15T14:00:00Z");
    expect(parseRetryAfter("Thu, 15 Oct 2026 14:00:30 GMT", now)).toBe(30_000);
  });
});
