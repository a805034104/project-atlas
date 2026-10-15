// AC#13 acceptance: real AI provider end to end on the RuoYi fixtures.
// The key is read from the environment only and never printed or written.
//
//   ANTHROPIC_API_KEY=... node scripts/ai-acceptance.mjs                (Anthropic, claude-sonnet-5-5)
//   ATLAS_PROVIDER=openai-compatible ATLAS_BASE_URL=https://api.deepseek.com/v1 ATLAS_MODEL=deepseek-chat ATLAS_API_KEY=... node scripts/ai-acceptance.mjs
//   ATLAS_PROVIDER=ollama ATLAS_MODEL=qwen2.5-coder:7b node scripts/ai-acceptance.mjs
//
// Options (env): ATLAS_MAX_INPUT_TOKENS (default 1500000: the run is skipped if the estimate exceeds it),
// ATLAS_ROOTS (comma-separated, default RuoYi-Vue + RuoYi-Vue3).
// Writes a secret-free report to .atlas-acceptance/ai-report.json.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  analyzeWorkspace,
  buildAiInput,
  createProvider,
  enrichWithAi,
  estimateAiCost,
} from "../packages/core/dist/index.js";

const provider = process.env.ATLAS_PROVIDER ?? "anthropic";
const apiKey = process.env.ATLAS_API_KEY ?? process.env.ANTHROPIC_API_KEY;
const model = process.env.ATLAS_MODEL || undefined;
const baseUrl = process.env.ATLAS_BASE_URL || undefined;
const maxInput = Number(process.env.ATLAS_MAX_INPUT_TOKENS ?? 1_500_000);
const roots = (process.env.ATLAS_ROOTS ?? "fixtures/repos/ruoyi-vue,fixtures/repos/ruoyi-vue3").split(",").map((p) => ({ path: p.trim() }));
const scrub = (text) => (apiKey ? String(text).split(apiKey).join("«key»") : String(text)).replace(/sk-ant-[\w-]+/g, "«key»");
const log = (...parts) => console.log(scrub(parts.join(" ")));

if (provider !== "ollama" && !apiKey) {
  log("No key in ANTHROPIC_API_KEY / ATLAS_API_KEY; aborting.");
  process.exit(2);
}

const config = { provider, ...(model ? { model } : {}), ...(baseUrl ? { baseUrl } : {}), ...(apiKey ? { apiKey } : {}), timeoutMs: 120_000 };
const llm = createProvider(config);

// 1. Connectivity
try {
  const r = await llm.complete({ system: 'Reply with the JSON object {"ok": true} and nothing else.', user: "ping", maxOutputTokens: 16 });
  log(`[1/4] connection OK — ${provider} ${llm.model} (${r.inputTokens} in / ${r.outputTokens} out)`);
} catch (error) {
  const u = typeof error.toUserFacing === "function" ? error.toUserFacing() : { code: "ATLAS-E000", problem: error.message, cause: "" };
  log(`[1/4] connection FAILED — ${u.code} ${u.problem} | ${u.cause ?? ""}`);
  process.exit(1);
}

// 2. Deterministic analysis
const started = Date.now();
const { graph, workspace } = await analyzeWorkspace({ roots, history: true });
log(`[2/4] deterministic map in ${Date.now() - started} ms: ${graph.services.length} services, ${graph.modules.length} modules, ${graph.entrypoints.length} entrypoints`);

// 3. Estimate (nothing sent yet)
const input = await buildAiInput(graph, workspace);
const plan = estimateAiCost(input, llm.model, provider);
for (const p of plan.phases) log(`      ${p.phase.padEnd(15)} ${String(p.calls).padStart(4)} calls  ${String(p.inputTokens).padStart(8)} in  ${String(p.outputTokens).padStart(7)} out  ${p.usd === undefined ? "price unknown" : "$" + p.usd.toFixed(2)}`);
log(`[3/4] estimate: ${plan.total.inputTokens} input tokens, ${plan.total.usd === undefined ? "price unknown" : "≈ $" + plan.total.usd.toFixed(2)}`);
if (plan.total.inputTokens > maxInput) {
  log(`Estimate exceeds ATLAS_MAX_INPUT_TOKENS=${maxInput}; nothing was sent. Raise the limit to proceed.`);
  process.exit(3);
}

// 4. AI enrichment
const cacheDir = path.resolve(".atlas-acceptance");
mkdirSync(cacheDir, { recursive: true });
const t = Date.now();
let lastPhase = "";
const { graph: enriched, result } = await enrichWithAi({
  graph,
  input,
  provider: llm,
  cacheDir,
  language: process.env.ATLAS_LANG ?? "zh-cn",
  concurrency: 4,
  maxInputTokens: maxInput,
  onProgress: (p) => {
    if (p.phase !== lastPhase || p.done === p.total) log(`      ${p.phase} ${p.done}/${p.total}${p.waiting ? " (" + p.waiting + ")" : ""}`);
    lastPhase = p.phase;
  },
});
const usedIn = result.usage.reduce((n, u) => n + u.inputTokens, 0);
const usedOut = result.usage.reduce((n, u) => n + u.outputTokens, 0);
log(`[4/4] AI done in ${Math.round((Date.now() - t) / 1000)} s: ${usedIn} in / ${usedOut} out tokens, ${result.failures.length} failures`);

const report = {
  provider,
  model: llm.model,
  estimate: plan.total,
  actual: { inputTokens: usedIn, outputTokens: usedOut },
  failures: result.failures.map((f) => ({ phase: f.phase, key: f.key, code: f.error.code, problem: scrub(f.error.problem) })),
  evidenceRejected: result.evidenceRejected,
  excludedFiles: result.excludedFiles,
  moduleSummaries: enriched.modules.filter((m) => m.summary).map((m) => ({ module: m.name, summary: m.summary })),
  features: enriched.features.map((f) => ({ tier: f.tier, title: f.title, description: f.description, modules: f.moduleIds.length, entrypoints: f.entrypointIds.length })),
  startup: enriched.startup.map((g) => ({ target: g.target, steps: g.steps.map((s) => `${s.command} (${s.evidence.file}:${s.evidence.line ?? ""})`), prerequisites: g.prerequisites.map((p) => p.name) })),
  historySummaries: enriched.history.filter((h) => h.aiSummary).length,
};
writeFileSync(path.join(cacheDir, "ai-report.json"), scrub(JSON.stringify(report, null, 2)));
log(`Report: .atlas-acceptance/ai-report.json — ${report.features.length} features (${report.features.filter((f) => f.tier === "core").length} core), ${report.moduleSummaries.length} module summaries, ${report.historySummaries} history summaries`);
