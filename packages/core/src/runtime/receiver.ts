import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { gunzip } from "node:zlib";
import { decodeTraceRequest, decodeTraceRequestJson, OtlpDecodeError } from "./otlp-decode.js";
import { toSpanRecords, type SpanRecord } from "./span-record.js";

/**
 * Local OTLP/HTTP trace receiver.
 *
 *   POST /v1/traces ─▶ Host allow-list ─▶ no Origin ─▶ bearer token (constant time)
 *     ─▶ body ≤ 4 MB ─▶ gunzip ≤ 32 MB ─▶ protobuf | JSON decode ─▶ 200 (ack first)
 *     ─▶ onSpans(records)  (async, after the response)
 *
 * Binds 127.0.0.1 only. The token and the Host check run before any byte of
 * the body is read, so unauthenticated callers can't make the extension
 * decompress or parse anything.
 */

export type RejectReason = "host" | "origin" | "token" | "method" | "path" | "content-type" | "too-large" | "decode";

export interface ReceiverStats {
  requests: number;
  spans: number;
  rejected: Partial<Record<RejectReason, number>>;
  /** Most recent rejections (reason + short detail), newest first, ≤ 20. */
  recentRejections: { at: number; reason: RejectReason; detail: string }[];
}

export interface ReceiverOptions {
  token: string;
  /** Preferred port; the next free one in [port, port + 20) is used. 0 = any free port. */
  port?: number;
  onSpans(records: SpanRecord[]): void | Promise<void>;
  onError?(error: unknown): void;
  maxBodyBytes?: number;
  maxInflatedBytes?: number;
}

export interface Receiver {
  readonly port: number;
  readonly endpoint: string;
  readonly stats: ReceiverStats;
  close(): Promise<void>;
}

export const DEFAULT_RECEIVER_PORT = 43180;
const PORT_ATTEMPTS = 20;

class Rejection extends Error {
  constructor(
    readonly status: number,
    readonly reason: RejectReason,
    detail: string,
  ) {
    super(detail);
  }
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const presented = /^Bearer\s+(.+)$/i.exec(header ?? "")?.[1]?.trim() ?? "";
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  // Compare against a same-length buffer so the timing does not leak the token length either.
  const same = a.length === b.length;
  return timingSafeEqual(same ? a : b, b) && same;
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? "0");
    if (declared > limit) {
      reject(new Rejection(413, "too-large", `content-length ${declared}`));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Rejection(413, "too-large", `body over ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function inflate(body: Buffer, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gunzip(body, { maxOutputLength: limit }, (error, out) => {
      if (error) reject(new Rejection((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" ? 413 : 400, error.message.includes("larger") || (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" ? "too-large" : "decode", error.message));
      else resolve(out);
    });
  });
}

export async function startReceiver(options: ReceiverOptions): Promise<Receiver> {
  const maxBody = options.maxBodyBytes ?? 4 * 1024 * 1024;
  const maxInflated = options.maxInflatedBytes ?? 32 * 1024 * 1024;
  const stats: ReceiverStats = { requests: 0, spans: 0, rejected: {}, recentRejections: [] };
  let port = 0;

  const reject = (res: ServerResponse, r: Rejection) => {
    stats.rejected[r.reason] = (stats.rejected[r.reason] ?? 0) + 1;
    stats.recentRejections.unshift({ at: Date.now(), reason: r.reason, detail: r.message.slice(0, 200) });
    if (stats.recentRejections.length > 20) stats.recentRejections.length = 20;
    if (!res.headersSent) {
      res.writeHead(r.status, { "content-type": "text/plain", connection: "close" });
      res.end(r.reason);
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    stats.requests++;
    const host = (req.headers.host ?? "").toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new Rejection(403, "host", `host ${host}`);
    if (req.headers.origin !== undefined) throw new Rejection(403, "origin", `origin ${req.headers.origin}`);
    if (!tokenMatches(req.headers.authorization, options.token)) throw new Rejection(401, "token", "missing or wrong bearer token");
    if (req.method !== "POST") throw new Rejection(405, "method", req.method ?? "");
    if ((req.url ?? "").split("?")[0] !== "/v1/traces") throw new Rejection(404, "path", req.url ?? "");
    const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
    const json = type === "application/json";
    if (!json && type !== "application/x-protobuf") throw new Rejection(415, "content-type", type ?? "");

    let body = await readBody(req, maxBody);
    if ((req.headers["content-encoding"] ?? "").toLowerCase() === "gzip") body = await inflate(body, maxInflated);
    let records: SpanRecord[];
    try {
      records = toSpanRecords(json ? decodeTraceRequestJson(body.toString("utf8")) : decodeTraceRequest(body));
    } catch (error) {
      if (error instanceof OtlpDecodeError) throw new Rejection(400, "decode", error.message);
      throw error;
    }
    // Ack first (empty ExportTraceServiceResponse), process after.
    res.writeHead(200, { "content-type": json ? "application/json" : "application/x-protobuf" });
    res.end(json ? "{}" : Buffer.alloc(0));
    stats.spans += records.length;
    if (records.length > 0) {
      try {
        await options.onSpans(records);
      } catch (error) {
        options.onError?.(error);
      }
    }
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (error instanceof Rejection) {
        req.resume();
        reject(res, error);
        return;
      }
      options.onError?.(error);
      if (!res.headersSent) {
        res.writeHead(500, { connection: "close" });
        res.end();
      }
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;

  const listen = (p: number) =>
    new Promise<number>((resolve, rejectListen) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        rejectListen(error);
      };
      const onListening = () => {
        server.off("error", onError);
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : p);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host: "127.0.0.1", port: p, exclusive: true });
    });

  const preferred = options.port ?? DEFAULT_RECEIVER_PORT;
  let lastError: unknown;
  for (let i = 0; i < (preferred === 0 ? 1 : PORT_ATTEMPTS); i++) {
    try {
      port = await listen(preferred === 0 ? 0 : preferred + i);
      break;
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  if (port === 0) throw lastError ?? new Error("no free port for the trace receiver");

  return {
    port,
    endpoint: `http://127.0.0.1:${port}/v1/traces`,
    stats,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
