// S0 spike: build otel.instrumentation.methods.include from the ProjectAtlas static graph.
// Usage: node gen-methods-include.mjs <repoRoot> <outProperties> [--raw]
// Default applies the spec V4 exclusions (no getters/setters, no domain/entity/vo classes,
// no annotation types); --raw keeps every FlowStep of the selected layers.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(process.argv[2] ?? 'fixtures/repos/ruoyi-vue');
const out = path.resolve(process.argv[3] ?? 'scripts/spike/otel-ruoyi.properties');
const core = await import(pathToFileURL(path.resolve('packages/core/dist/index.js')).href);

const RAW = process.argv.includes('--raw');
const NOISE_CLASS = /\.(domain|entity|vo|annotation|page)\.|\.(AjaxResult|ExcelUtil|RuoYiConfig|ServerConfig)$/;
const NOISE_METHOD = /^(get|set|is)[A-Z]/;
const LAYERS = new Set(['filter', 'interceptor', 'aspect', 'controller', 'service', 'repository']);
const t0 = Date.now();
const { graph } = await core.analyzeWorkspace({ roots: [{ path: repo }], history: false });
console.error(`analyzed in ${Date.now() - t0} ms: ${graph.steps.length} steps, ${graph.flows?.length} flows`);

const byClass = new Map();
const layerCount = {};
const skipped = [];
for (const step of graph.steps) {
  if (!LAYERS.has(step.layer)) continue;
  const fqn = step.symbol.fqn; // e.g. com.ruoyi.web.controller.system.SysUserController#list(SysUser)
  const m = /^([\w.$]+)#([\w$<>]+)/.exec(fqn);
  if (!m) { skipped.push(fqn); continue; }
  const [, cls, method] = m;
  if (!RAW && step.layer !== 'repository' && (NOISE_CLASS.test(cls) || NOISE_METHOD.test(method))) { skipped.push(fqn); continue; }
  if (!byClass.has(cls)) byClass.set(cls, { methods: new Set(), layers: new Set() });
  byClass.get(cls).methods.add(method);
  byClass.get(cls).layers.add(step.layer);
  layerCount[step.layer] = (layerCount[step.layer] ?? 0) + 1;
}
const classes = [...byClass.keys()].sort();
const include = classes.map((c) => `${c}[${[...byClass.get(c).methods].sort().join(',')}]`).join(';');

const props = [
  'otel.service.name=ruoyi-admin',
  'otel.traces.exporter=otlp',
  'otel.metrics.exporter=none',
  'otel.logs.exporter=none',
  'otel.exporter.otlp.protocol=http/protobuf',
  'otel.exporter.otlp.traces.endpoint=http://127.0.0.1:43180/v1/traces',
  'otel.exporter.otlp.headers=authorization=Bearer s0-test-token',
  'otel.bsp.schedule.delay=500',
  'otel.bsp.max.queue.size=8192',
  `otel.instrumentation.methods.include=${include}`,
];
fs.writeFileSync(out, props.join('\n') + '\n');
const summary = {
  classes: classes.length,
  methods: classes.reduce((n, c) => n + byClass.get(c).methods.size, 0),
  includeLength: include.length,
  stepsPerLayer: layerCount,
  raw: RAW,
  skippedCount: skipped.length,
  skipped,
  classLayers: Object.fromEntries(classes.map((c) => [c, [...byClass.get(c).layers]])),
};
fs.writeFileSync(out.replace(/\.properties$/, '.summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, skipped: undefined, classLayers: undefined }, null, 2));
