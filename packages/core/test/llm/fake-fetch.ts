export interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  rawBody: string;
  signal: AbortSignal | undefined;
}

export type FakeReply =
  | { status?: number; json?: unknown; text?: string; headers?: Record<string, string> }
  | ((req: RecordedRequest) => Response | Promise<Response>)
  | Error;

/** A fetch stand-in that records every request and replays scripted replies (last one repeats). */
export function fakeFetch(...replies: FakeReply[]): typeof fetch & { calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const rawBody = typeof init?.body === "string" ? init.body : "";
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const req: RecordedRequest = {
      url: String(input),
      headers,
      body: rawBody ? JSON.parse(rawBody) : undefined,
      rawBody,
      signal: init?.signal ?? undefined,
    };
    calls.push(req);
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (reply === undefined) throw new Error("fakeFetch: no reply scripted");
    if (reply instanceof Error) throw reply;
    if (typeof reply === "function") return reply(req);
    const body = reply.text ?? JSON.stringify(reply.json ?? {});
    return new Response(body, { status: reply.status ?? 200, headers: reply.headers ?? {} });
  };
  return Object.assign(impl as typeof fetch, { calls });
}

export function anthropicReply(text: string, usage = { input_tokens: 10, output_tokens: 5 }): FakeReply {
  return { json: { content: [{ type: "text", text }], stop_reason: "end_turn", usage } };
}

export function connectionRefused(): Error {
  const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" });
  return new TypeError("fetch failed", { cause });
}

/** Never resolves until the request's signal aborts, then rejects like real fetch. */
export function hang(): FakeReply {
  return (req) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = req.signal;
      const fail = (): void => reject(signal?.reason instanceof Error ? signal.reason : new DOMException("aborted", "AbortError"));
      if (signal?.aborted) fail();
      signal?.addEventListener("abort", fail, { once: true });
    });
}
