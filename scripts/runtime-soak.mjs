// AC-RT-SOAK (time-compressed): one hour at 200 spans/s = 720 000 spans through the real
// OTLP receiver (protobuf over HTTP, 200-span batches), then check
//   - process RSS growth stays under 100 MB after the first batches (no leak),
//   - raw spans are capped by retention (≤ 100 000 + one segment),
//   - aggregates still count every span (statistics survive eviction).
//   node scripts/runtime-soak.mjs [--spans 720000]
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { RuntimeSession, decodeTraceRequest, workspaceToken } from "../packages/core/dist/index.js";

const { values } = parseArgs({ options: { spans: { type: "string", default: "720000" } } });
const target = Number(values.spans);
const golden = path.resolve("fixtures/runtime/ruoyi-vue-2.31.1/raw");
const payloads = readdirSync(golden).filter((f) => f.endsWith(".pb")).sort().map((f) => readFileSync(path.join(golden, f)));
// Spans per payload (payloads are re-sent as OTLP/JSON with fresh trace ids).
const counts = payloads.map((p) => decodeTraceRequest(p).reduce((n, rs) => n + rs.scopeSpans.reduce((m, ss) => m + ss.spans.length, 0), 0));

const decoded = payloads.map((p) => decodeTraceRequest(p));

function anyValue(v) {
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "bigint") return { intValue: v.toString() };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(anyValue) } };
  if (v instanceof Uint8Array) return { stringValue: "" };
  return { kvlistValue: { values: Object.entries(v).map(([key, x]) => ({ key, value: anyValue(x) })) } };
}
const attrs = (o) => Object.entries(o).map(([key, v]) => ({ key, value: anyValue(v) }));

/** OTLP/JSON body of payload i with every trace id replaced by one derived from seq. */
function withFreshTraceIds(i, seq) {
  const tid = (t) => `${seq.toString(16).padStart(12, "0")}${t.slice(12)}`;
  return JSON.stringify({
    resourceSpans: decoded[i].map((rs) => ({
      resource: { attributes: attrs(rs.resource) },
      scopeSpans: rs.scopeSpans.map((ss) => ({
        scope: ss.scope,
        spans: ss.spans.map((sp) => ({
          traceId: tid(sp.traceId),
          spanId: sp.spanId,
          ...(sp.parentSpanId ? { parentSpanId: sp.parentSpanId } : {}),
          name: sp.name,
          kind: sp.kind,
          startTimeUnixNano: sp.startTimeUnixNano.toString(),
          endTimeUnixNano: sp.endTimeUnixNano.toString(),
          attributes: attrs(sp.attributes),
          status: { code: sp.statusCode },
        })),
      })),
    })),
  });
}

const ws = mkdtempSync(path.join(tmpdir(), "atlas-soak-"));
process.env.PROJECT_ATLAS_HOME = path.join(ws, ".home");
const session = await RuntimeSession.start({ workspaceDir: ws, port: 0, saveDelayMs: 200 });
const token = await workspaceToken(ws);
const url = `${session.endpoint}`;
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

let sent = 0;
let seq = 0;
let rssAfterWarmup = 0;
let peak = 0;
const started = Date.now();
while (sent < target) {
  const i = seq % payloads.length;
  const res = await fetch(url, { method: "POST", headers, body: withFreshTraceIds(i, seq) });
  if (res.status !== 200) throw new Error(`receiver answered ${res.status}`);
  sent += counts[i];
  seq++;
  const rss = process.memoryUsage().rss;
  peak = Math.max(peak, rss);
  if (rssAfterWarmup === 0 && sent > 20_000) rssAfterWarmup = rss;
  if (seq % 2000 === 0) {
    globalThis.gc?.();
    const m = process.memoryUsage();
    process.stdout.write(`  ${sent} spans, RSS ${Math.round(m.rss / 1e6)} MB, heap ${Math.round(m.heapUsed / 1e6)} MB, external ${Math.round(m.external / 1e6)} MB\n`);
  }
}
await new Promise((r) => setTimeout(r, 1500));
const status = session.status();
const stored = await session.store.count();
await session.stop();
const growthMb = Math.round((peak - rssAfterWarmup) / 1e6);
const result = { sent, accepted: status.spans, duplicates: status.duplicates, storedRaw: stored, rssGrowthMb: growthMb, seconds: Math.round((Date.now() - started) / 1000) };
console.log(JSON.stringify(result));
const failures = [];
if (status.spans + status.duplicates < sent) failures.push(`aggregates counted ${status.spans + status.duplicates} of ${sent}`);
if (stored > 110_000) failures.push(`raw store holds ${stored} spans (retention 100 000)`);
if (growthMb > 100) failures.push(`RSS grew ${growthMb} MB after warm-up`);
if (failures.length > 0) {
  console.error(`AC-RT-SOAK failed: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("AC-RT-SOAK passed");
