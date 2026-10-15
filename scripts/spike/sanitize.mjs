// Scrub captured OTLP payloads before they are committed as golden fixtures:
// resource keeps only service.name / telemetry.sdk.*; UUIDs and user paths in span
// attributes are replaced. Rewrites <dir>/raw/*.pb in place.
// Usage: node scripts/spike/sanitize.mjs <captureDir>
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "package.json"));
const protobuf = require("protobufjs");

const dir = path.resolve(process.argv[2] ?? "fixtures/runtime/ruoyi-vue-2.31.1");
const root = new protobuf.Root();
root.resolvePath = (_origin, target) => path.join(here, "proto", target);
root.loadSync("opentelemetry/proto/collector/trace/v1/trace_service.proto", { keepCase: false });
const Req = root.lookupType("opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest");

const KEEP_RESOURCE = /^(service\.name|telemetry\.sdk\.)/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const USER_PATH = /[A-Za-z]:[\\/]+Users[\\/]+[^\\/"\s]+/g;

const scrubValue = (v) => {
  if (v && typeof v.stringValue === "string") v.stringValue = v.stringValue.replace(UUID, "00000000-0000-0000-0000-000000000000").replace(USER_PATH, "C:/Users/user");
  for (const inner of v?.arrayValue?.values ?? []) scrubValue(inner);
  for (const kv of v?.kvlistValue?.values ?? []) scrubValue(kv.value);
};

let files = 0;
for (const file of fs.readdirSync(path.join(dir, "raw")).filter((f) => f.endsWith(".pb"))) {
  const full = path.join(dir, "raw", file);
  const msg = Req.decode(fs.readFileSync(full));
  for (const rs of msg.resourceSpans ?? []) {
    if (rs.resource) rs.resource.attributes = (rs.resource.attributes ?? []).filter((kv) => KEEP_RESOURCE.test(kv.key));
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        span.attributes = (span.attributes ?? []).filter((kv) => !/^(client\.address|network\.peer\.|user_agent\.original|thread\.id)/.test(kv.key));
        for (const kv of span.attributes) scrubValue(kv.value);
        for (const ev of span.events ?? []) for (const kv of ev.attributes ?? []) scrubValue(kv.value);
      }
    }
  }
  fs.writeFileSync(full, Req.encode(msg).finish());
  files++;
}
console.log(`sanitized ${files} payloads in ${dir}`);
