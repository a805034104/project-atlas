// S0 spike: print decoded spans as per-trace trees.
// Usage: node scripts/spike/tree.mjs <captureDir> [filterSubstring]   (filter matches any span name in the trace)
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] ?? 'fixtures/runtime/ruoyi-vue-2.31.1');
const filter = process.argv[3];
const { spans } = JSON.parse(fs.readFileSync(path.join(dir, 'decoded.json'), 'utf8'));
const byTrace = new Map();
for (const s of spans) {
  if (!byTrace.has(s.traceId)) byTrace.set(s.traceId, []);
  byTrace.get(s.traceId).push(s);
}
const SHOW = ['http.route', 'http.request.method', 'url.path', 'http.response.status_code', 'code.namespace', 'code.function', 'code.function.name',
  'db.operation', 'db.operation.name', 'db.sql.table', 'db.collection.name', 'db.statement', 'db.query.text', 'db.query.summary', 'db.system', 'db.system.name'];
const traces = [...byTrace.values()].sort((a, b) => (BigInt(a[0].startTimeUnixNano) < BigInt(b[0].startTimeUnixNano) ? -1 : 1));
for (const list of traces) {
  if (filter && !list.some((s) => s.name.includes(filter))) continue;
  const ids = new Set(list.map((s) => s.spanId));
  const kids = new Map();
  for (const s of list) {
    const p = ids.has(s.parentSpanId) ? s.parentSpanId : '';
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(s);
  }
  for (const k of kids.values()) k.sort((a, b) => (BigInt(a.startTimeUnixNano) < BigInt(b.startTimeUnixNano) ? -1 : 1));
  console.log(`\n=== trace ${list[0].traceId} (${list.length} spans)`);
  const walk = (p, depth) => {
    for (const s of kids.get(p) ?? []) {
      const a = SHOW.filter((k) => s.attributes[k] !== undefined).map((k) => `${k}=${String(s.attributes[k]).slice(0, 90)}`).join(' ');
      const orphan = depth === 0 && s.parentSpanId ? ` [parent ${s.parentSpanId} not in capture]` : '';
      console.log(`${'  '.repeat(depth)}- ${s.name} [${s.kind.replace('SPAN_KIND_', '')}] ${s.durationMs}ms <${s.scope.name.replace('io.opentelemetry.', '')}> ${a}${orphan}`);
      walk(s.spanId, depth + 1);
    }
  };
  walk('', 0);
}
