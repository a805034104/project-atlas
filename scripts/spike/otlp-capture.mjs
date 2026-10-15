// S0 spike: minimal OTLP/HTTP trace capture server.
// Usage: node otlp-capture.mjs <outDir> [port]
//   POST /v1/traces -> saves body (gunzipped if needed) as <outDir>/raw/NNN.pb,
//   appends request metadata (headers minus secrets) to <outDir>/requests.jsonl,
//   replies 200 with an empty ExportTraceServiceResponse.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const outDir = path.resolve(process.argv[2] ?? 'fixtures/runtime/ruoyi-vue-2.31.1');
const port = Number(process.argv[3] ?? 43180);
const rawDir = path.join(outDir, 'raw');
fs.mkdirSync(rawDir, { recursive: true });

const SECRET_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'x-api-key']);
let seq = fs.readdirSync(rawDir).filter((f) => f.endsWith('.pb')).length;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const receivedAt = new Date().toISOString();
    if (req.method !== 'POST' || req.url !== '/v1/traces') {
      res.writeHead(404).end();
      return;
    }
    let body = Buffer.concat(chunks);
    const wireBytes = body.length;
    const enc = (req.headers['content-encoding'] ?? '').toLowerCase();
    try {
      if (enc === 'gzip') body = zlib.gunzipSync(body);
    } catch (e) {
      res.writeHead(400).end();
      return;
    }
    seq += 1;
    const name = String(seq).padStart(3, '0') + '.pb';
    fs.writeFileSync(path.join(rawDir, name), body);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k] = SECRET_HEADERS.has(k) ? `<redacted len=${String(v).length}>` : v;
    }
    const auth = req.headers['authorization'];
    const meta = {
      file: name,
      receivedAt,
      wireBytes,
      bodyBytes: body.length,
      contentEncoding: enc || null,
      authorizationMatchesTestToken: auth === 'Bearer s0-test-token',
      headers,
    };
    fs.appendFileSync(path.join(outDir, 'requests.jsonl'), JSON.stringify(meta) + '\n');
    console.log(`${receivedAt} ${name} ${body.length}B enc=${enc || 'none'}`);
    // Empty ExportTraceServiceResponse (all fields default) == zero-length protobuf message.
    res.writeHead(200, { 'content-type': 'application/x-protobuf', 'content-length': '0' });
    res.end();
  });
});
server.listen(port, '127.0.0.1', () => console.log(`otlp-capture listening on 127.0.0.1:${port} -> ${outDir}`));
