// S0 spike: decode captured OTLP/HTTP protobuf payloads into a flat span list.
// Usage: node scripts/spike/decode.mjs <captureDir>   (reads <dir>/raw/*.pb, writes <dir>/decoded.json)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, 'package.json'));
const protobuf = require('protobufjs');

const dir = path.resolve(process.argv[2] ?? 'fixtures/runtime/ruoyi-vue-2.31.1');
const protoRoot = path.join(here, 'proto');
const root = new protobuf.Root();
root.resolvePath = (_origin, target) => path.join(protoRoot, target);
root.loadSync('opentelemetry/proto/collector/trace/v1/trace_service.proto', { keepCase: false });
const Req = root.lookupType('opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest');

const hex = (b) => (b && b.length ? Buffer.from(b).toString('hex') : '');
const anyValue = (v) => {
  if (!v) return null;
  if (v.stringValue !== undefined && v.stringValue !== null && v.value === 'stringValue') return v.stringValue;
  if (v.value === 'boolValue') return v.boolValue;
  if (v.value === 'intValue') return v.intValue.toString();
  if (v.value === 'doubleValue') return v.doubleValue;
  if (v.value === 'arrayValue') return (v.arrayValue.values ?? []).map(anyValue);
  if (v.value === 'kvlistValue') return Object.fromEntries((v.kvlistValue.values ?? []).map((kv) => [kv.key, anyValue(kv.value)]));
  if (v.value === 'bytesValue') return { bytes: hex(v.bytesValue) };
  return null;
};
const attrs = (list) => Object.fromEntries((list ?? []).map((kv) => [kv.key, anyValue(kv.value)]));

const files = fs.readdirSync(path.join(dir, 'raw')).filter((f) => f.endsWith('.pb')).sort();
const spans = [];
for (const file of files) {
  const msg = Req.decode(fs.readFileSync(path.join(dir, 'raw', file)));
  const obj = Req.toObject(msg, { longs: String, enums: String, oneofs: true, defaults: false, bytes: Array });
  for (const rs of obj.resourceSpans ?? []) {
    const resource = attrs(rs.resource?.attributes);
    for (const ss of rs.scopeSpans ?? []) {
      for (const s of ss.spans ?? []) {
        spans.push({
          file,
          traceId: hex(s.traceId),
          spanId: hex(s.spanId),
          parentSpanId: hex(s.parentSpanId),
          name: s.name,
          kind: s.kind ?? 'SPAN_KIND_UNSPECIFIED',
          startTimeUnixNano: String(s.startTimeUnixNano),
          endTimeUnixNano: String(s.endTimeUnixNano),
          durationMs: Number((BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano)) / 1000n) / 1000,
          attributes: attrs(s.attributes),
          status: s.status ? { code: s.status.code ?? 'STATUS_CODE_UNSET', message: s.status.message } : null,
          events: (s.events ?? []).map((e) => ({ name: e.name, attributes: attrs(e.attributes) })),
          scope: { name: ss.scope?.name, version: ss.scope?.version },
          scopeSchemaUrl: ss.schemaUrl,
          serviceName: resource['service.name'],
          processPid: resource['process.pid'],
        });
      }
    }
  }
}
const resourceOnce = (() => {
  const msg = Req.toObject(Req.decode(fs.readFileSync(path.join(dir, 'raw', files[0]))), { longs: String, oneofs: true });
  return attrs(msg.resourceSpans?.[0]?.resource?.attributes);
})();
fs.writeFileSync(path.join(dir, 'decoded.json'), JSON.stringify({ files: files.length, spanCount: spans.length, resource: resourceOnce, spans }, null, 2));
console.log(`decoded ${spans.length} spans from ${files.length} payloads -> ${path.join(dir, 'decoded.json')}`);
