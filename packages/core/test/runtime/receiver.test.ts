import { readdirSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { startReceiver, type Receiver } from "../../src/runtime/receiver.js";
import type { SpanRecord } from "../../src/runtime/span-record.js";

const GOLDEN = path.resolve(__dirname, "../../../../fixtures/runtime/ruoyi-vue-2.31.1/raw");
const payload = readFileSync(path.join(GOLDEN, readdirSync(GOLDEN).filter((f) => f.endsWith(".pb")).sort()[0] as string));
const TOKEN = "test-token-0123456789";

interface Reply {
  status: number;
  body: string;
}

function post(port: number, body: Buffer | string, headers: Record<string, string>, host = `127.0.0.1:${port}`, address = "127.0.0.1"): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: address, port, path: "/v1/traces", method: "POST", headers: { host, "content-length": String(Buffer.byteLength(body)), ...headers } }, (res) => {
      let text = "";
      res.on("data", (c: Buffer) => (text += c.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/x-protobuf" };
let receiver: Receiver | undefined;
afterEach(async () => {
  await receiver?.close();
  receiver = undefined;
});

async function start(onSpans: (r: SpanRecord[]) => void = () => {}, extra: { maxBodyBytes?: number; maxInflatedBytes?: number } = {}): Promise<Receiver> {
  receiver = await startReceiver({ token: TOKEN, port: 0, onSpans, ...extra });
  return receiver;
}

describe("OTLP receiver", () => {
  it("accepts a real agent payload (plain and gzip) and acks before processing", async () => {
    const got: SpanRecord[][] = [];
    const r = await start((recs) => void got.push(recs));
    expect((await post(r.port, payload, auth)).status).toBe(200);
    expect((await post(r.port, gzipSync(payload), { ...auth, "content-encoding": "gzip" })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(got).toHaveLength(2);
    expect(got[0]?.length).toBeGreaterThan(0);
    expect(r.stats.spans).toBe((got[0]?.length ?? 0) * 2);
  });

  it("rejects wrong or missing tokens before reading the body", async () => {
    const r = await start();
    expect((await post(r.port, payload, { ...auth, authorization: "Bearer nope" })).status).toBe(401);
    expect((await post(r.port, payload, { "content-type": "application/x-protobuf" })).status).toBe(401);
    // a gzip bomb with a bad token is refused without inflating
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024));
    const started = Date.now();
    expect((await post(r.port, bomb, { ...auth, authorization: "Bearer nope", "content-encoding": "gzip" })).status).toBe(401);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.stats.rejected.token).toBe(3);
  });

  it("rejects browser origins and foreign Host headers (DNS rebinding)", async () => {
    const r = await start();
    expect((await post(r.port, payload, { ...auth, origin: "http://evil.example" })).status).toBe(403);
    expect((await post(r.port, payload, auth, `evil.example:${r.port}`)).status).toBe(403);
    expect((await post(r.port, payload, auth, `localhost:${r.port}`)).status).toBe(200);
    expect(r.stats.rejected).toMatchObject({ origin: 1, host: 1 });
  });

  it("caps body and inflated sizes and reports decode errors", async () => {
    const r = await start(() => {}, { maxBodyBytes: 1024, maxInflatedBytes: 4096 });
    expect((await post(r.port, Buffer.alloc(2048, 1), auth)).status).toBe(413);
    expect((await post(r.port, gzipSync(Buffer.alloc(100_000)), { ...auth, "content-encoding": "gzip" })).status).toBe(413);
    expect((await post(r.port, Buffer.from([0x0a, 0xff, 0xff, 0x03]), auth)).status).toBe(400);
    expect((await post(r.port, "x", { ...auth, "content-type": "text/plain" })).status).toBe(415);
    expect(r.stats.recentRejections[0]?.reason).toBe("content-type");
  });

  it("accepts OTLP/JSON", async () => {
    const got: SpanRecord[] = [];
    const r = await start((recs) => void got.push(...recs));
    const json = JSON.stringify({
      resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "svc" } }] }, scopeSpans: [{ scope: { name: "s" }, spans: [{ traceId: "a".repeat(32), spanId: "b".repeat(16), name: "x", kind: 2, startTimeUnixNano: "1000000", endTimeUnixNano: "3000000" }] }] }],
    });
    const reply = await post(r.port, json, { ...auth, "content-type": "application/json" });
    expect(reply).toEqual({ status: 200, body: "{}" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(got[0]).toMatchObject({ svc: "svc", kind: "server", dur: 2 });
  });

  it("listens on loopback only", async () => {
    const r = await start();
    const external = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
    if (!external) return; // no non-loopback interface on this machine
    await expect(post(r.port, payload, auth, `127.0.0.1:${r.port}`, external)).rejects.toThrow();
  });

  it("moves to the next port when the preferred one is taken", async () => {
    const first = await startReceiver({ token: TOKEN, port: 0, onSpans: () => {} });
    try {
      receiver = await startReceiver({ token: TOKEN, port: first.port, onSpans: () => {} });
      expect(receiver.port).not.toBe(first.port);
      expect(receiver.endpoint).toBe(`http://127.0.0.1:${receiver.port}/v1/traces`);
    } finally {
      await first.close();
    }
  });
});
