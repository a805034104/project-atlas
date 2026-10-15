import { pushTo } from "./util/collections.js";
import { readFile } from "node:fs/promises";
import { decodeSource } from "./ingest/decode.js";
import { estimateTokens, planCost, TokenBudget, type CostPlan, type CostTask } from "./llm/budget.js";
import { FileLlmCache, MemoryLlmCache, type LlmCache } from "./llm/cache.js";
import { runAiPipeline, type AiFileInput, type AiPhase, type AiPipelineInput, type AiPipelineResult, type AiProgress } from "./llm/pipeline.js";
import type { LlmProviderName } from "./llm/errors.js";
import type { LlmProvider } from "./llm/providers.js";
import type { AtlasGraph, Diagnostic, Module, StartupGuide } from "./model/types.js";
import { entrypointLabel } from "./overrides/apply.js";
import type { Workspace } from "./workspace/load.js";

/**
 * AI enrichment on top of the deterministic graph.
 *
 *   graph + workspace ─▶ buildAiInput (hub files only, evidence texts, commit messages)
 *        ─▶ estimateAiCost (shown to the user BEFORE anything is sent)
 *        ─▶ runAiPipeline (redaction, untrusted wrapping, evidence check, cache)
 *        ─▶ mergeAiResult: module summaries, features, startup additions, history summaries, usage
 */

export const HUBS_PER_MODULE = 20;
const MAX_EVIDENCE_CHARS = 20_000;
const HUB_LAYERS = new Set(["controller", "service", "repository", "frontend", "external-http"]);

export type AiInput = Omit<AiPipelineInput, "provider" | "cache" | "budget" | "language" | "signal" | "onProgress" | "concurrency">;

function moduleFor(modules: readonly Module[], rootOf: (m: Module) => string | undefined, rootId: string, relPath: string): Module | undefined {
  let best: Module | undefined;
  for (const m of modules) {
    if (rootOf(m) !== rootId) continue;
    if (m.path !== "" && relPath !== m.path && !relPath.startsWith(`${m.path}/`)) continue;
    if (!best || m.path.length > best.path.length) best = m;
  }
  return best;
}

/** Pick hub files: files hosting entrypoints or call-graph steps, ranked by graph degree, top N per module. */
export async function buildAiInput(graph: AtlasGraph, workspace: Workspace): Promise<AiInput> {
  const serviceRoot = new Map(graph.services.map((s) => [s.id, s.rootId]));
  const rootOf = (m: Module) => serviceRoot.get(m.serviceId);
  const degree = new Map<string, number>();
  const stepFile = new Map(graph.steps.map((s) => [s.id, `${s.symbol.rootId}:${s.symbol.file}`]));
  for (const s of graph.steps) {
    if (!HUB_LAYERS.has(s.layer)) continue;
    const key = `${s.symbol.rootId}:${s.symbol.file}`;
    degree.set(key, (degree.get(key) ?? 0) + 1);
  }
  for (const e of graph.edges) {
    for (const id of [e.from, e.to]) {
      const key = stepFile.get(id);
      if (key && degree.has(key)) degree.set(key, (degree.get(key) ?? 0) + 1);
    }
  }
  for (const ep of graph.entrypoints) {
    const key = `${ep.handler.rootId}:${ep.handler.file}`;
    degree.set(key, (degree.get(key) ?? 0) + 5);
  }

  const perModule = new Map<string, { file: (typeof workspace.files)[number]; score: number }[]>();
  for (const file of workspace.files) {
    const score = degree.get(`${file.rootId}:${file.relPath}`);
    if (!score) continue;
    const module = moduleFor(graph.modules, rootOf, file.rootId, file.relPath);
    if (!module) continue;
    pushTo(perModule, module.id, { file, score });
  }

  const files: AiFileInput[] = [];
  for (const [moduleId, candidates] of perModule) {
    const hubs = candidates.sort((a, b) => b.score - a.score).slice(0, HUBS_PER_MODULE);
    for (const { file } of hubs) {
      const content = file.text ?? decodeSource(await readFile(file.absPath)).text;
      files.push({ rootId: file.rootId, path: file.relPath, content, hash: file.hash, moduleId, hub: true });
    }
  }

  const evidenceFiles = workspace.files.filter(
    (f) =>
      f.text &&
      (/^(readme(\.[\w-]+)?\.md)$/i.test(f.relPath.split("/").pop() ?? "") ||
        f.kind === "npm-manifest" ||
        f.kind === "dockerfile" ||
        f.kind === "compose" ||
        (f.kind === "maven-pom" && !f.relPath.includes("/")) ||
        (f.kind === "shell" && !f.relPath.includes("/")) ||
        /src\/main\/resources\/(application|bootstrap)[\w-]*\.(ya?ml|properties)$/.test(f.relPath)),
  );
  const startupEvidence = evidenceFiles.map((f) => ({ rootId: f.rootId, file: f.relPath, content: (f.text ?? "").slice(0, MAX_EVIDENCE_CHARS) }));

  const historyByModule: AiInput["historyByModule"] = {};
  for (const h of graph.history) historyByModule[h.moduleId] = h.commits.slice(0, 50).map((c) => ({ message: c.message, files: c.files }));

  const entrypoints = graph.entrypoints
    .filter((e) => e.kind !== "frontend-route")
    .map((e) => {
      const module = moduleFor(graph.modules, rootOf, e.handler.rootId, e.handler.file);
      return { id: e.id, label: `${entrypointLabel(e)} → ${e.handler.name}`, ...(module ? { moduleId: module.id } : {}) };
    });

  return {
    files,
    modules: graph.modules.map((m) => ({ id: m.id, name: m.name, path: m.path })),
    entrypoints,
    startupEvidence,
    historyByModule,
  };
}

const OUTPUT_ESTIMATE: Record<AiPhase, number> = { "file-summary": 250, "module-summary": 400, features: 5000, startup: 1500, history: 400 };
const PROMPT_OVERHEAD = 400;

/** Upper-bound cost estimate per phase, shown in the confirmation dialog before any request is sent. */
export function estimateAiCost(input: AiInput, model: string, provider?: LlmProviderName): CostPlan {
  const tasks: CostTask[] = [];
  const summaryTokensPerModule = new Map<string, number>();
  for (const f of input.files) {
    tasks.push({ phase: "file-summary", inputTokens: estimateTokens(f.content) + PROMPT_OVERHEAD, outputTokens: OUTPUT_ESTIMATE["file-summary"] });
    summaryTokensPerModule.set(f.moduleId, (summaryTokensPerModule.get(f.moduleId) ?? 0) + OUTPUT_ESTIMATE["file-summary"]);
  }
  for (const [, tokens] of summaryTokensPerModule) tasks.push({ phase: "module-summary", inputTokens: tokens + PROMPT_OVERHEAD, outputTokens: OUTPUT_ESTIMATE["module-summary"] });
  tasks.push({
    phase: "features",
    inputTokens: summaryTokensPerModule.size * OUTPUT_ESTIMATE["module-summary"] + input.entrypoints.reduce((n, e) => n + estimateTokens(e.label) + 8, 0) + PROMPT_OVERHEAD,
    outputTokens: OUTPUT_ESTIMATE.features,
  });
  tasks.push({ phase: "startup", inputTokens: input.startupEvidence.reduce((n, e) => n + estimateTokens(e.content), 0) + PROMPT_OVERHEAD, outputTokens: OUTPUT_ESTIMATE.startup });
  for (const commits of Object.values(input.historyByModule)) {
    if (commits.length === 0) continue;
    tasks.push({ phase: "history", inputTokens: commits.reduce((n, c) => n + estimateTokens(c.message) + c.files.length * 6, 0) + PROMPT_OVERHEAD, outputTokens: OUTPUT_ESTIMATE.history });
  }
  return planCost(tasks, model, provider ? { provider } : {});
}

export interface EnrichOptions {
  graph: AtlasGraph;
  input: AiInput;
  provider: LlmProvider;
  /** `.atlas` directory for the LLM cache; omitted → in-memory cache. */
  cacheDir?: string;
  language: string;
  concurrency?: number;
  maxInputTokens?: number;
  /** Phases the user deselected in the cost dialog. */
  skipPhases?: readonly AiPhase[];
  signal?: AbortSignal;
  onProgress?: (progress: AiProgress) => void;
}

export async function enrichWithAi(options: EnrichOptions): Promise<{ graph: AtlasGraph; result: AiPipelineResult }> {
  const skip = new Set(options.skipPhases ?? []);
  const input = options.input;
  const cache: LlmCache = options.cacheDir ? new FileLlmCache(options.cacheDir) : new MemoryLlmCache();
  const result = await runAiPipeline({
    provider: options.provider,
    cache,
    budget: new TokenBudget(options.maxInputTokens),
    language: options.language,
    ...(options.concurrency ? { concurrency: options.concurrency } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    files: skip.has("file-summary") ? [] : input.files,
    modules: skip.has("module-summary") ? [] : input.modules,
    entrypoints: skip.has("features") ? [] : input.entrypoints,
    startupEvidence: skip.has("startup") ? [] : input.startupEvidence,
    historyByModule: skip.has("history") ? {} : input.historyByModule,
  });
  return { graph: mergeAiResult(options.graph, result), result };
}

/** Deterministic startup guides stay; AI guides only add steps/prerequisites/ports not already present. */
function mergeStartup(base: readonly StartupGuide[], ai: readonly StartupGuide[]): StartupGuide[] {
  const out = base.map((g) => ({ ...g, prerequisites: [...g.prerequisites], steps: [...g.steps], ports: [...g.ports] }));
  const files = (g: StartupGuide): Set<string> =>
    new Set([...g.steps, ...g.ports, ...g.prerequisites].map((x) => x.evidence.file));
  // The model names targets freely ("后端（ruoyi-admin）"), so match on the exact name, a name
  // mention, or shared evidence files before treating a guide as new.
  const sameTarget = (g: StartupGuide, guide: StartupGuide): boolean => {
    if (g.target === guide.target || guide.target.toLowerCase().includes(g.target.toLowerCase())) return true;
    const cited = files(guide);
    return [...files(g)].some((f) => cited.has(f));
  };
  for (const guide of ai) {
    const target = out.find((g) => sameTarget(g, guide));
    if (!target) {
      out.push(guide);
      continue;
    }
    for (const p of guide.prerequisites) if (!target.prerequisites.some((x) => x.name.toLowerCase() === p.name.toLowerCase())) target.prerequisites.push(p);
    for (const s of guide.steps) if (!target.steps.some((x) => normalizeCommand(x.command) === normalizeCommand(s.command))) target.steps.push(s);
    for (const p of guide.ports) if (!target.ports.some((x) => x.port === p.port)) target.ports.push(p);
  }
  return out;
}

/** `./ry.sh start` and `sh ry.sh start` are the same step. */
function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ").replace(/^(?:sh|bash) /, "").replace(/(^|\s)\.\//g, "$1");
}

export function mergeAiResult(graph: AtlasGraph, result: AiPipelineResult): AtlasGraph {
  const diagnostics: Diagnostic[] = [...graph.diagnostics.filter((d) => !d.code.startsWith("ATLAS-AI"))];
  if (result.failures.length > 0) {
    diagnostics.push({ code: "ATLAS-AI01", severity: "warning", message: `${result.failures.length} AI request(s) failed; retry with Atlas: Analyze (cached results are reused)` });
  }
  if (result.evidenceRejected.features + result.evidenceRejected.startup > 0) {
    diagnostics.push({
      code: "ATLAS-AI02",
      severity: "info",
      message: `Evidence check dropped ${result.evidenceRejected.features} feature(s) and ${result.evidenceRejected.startup} startup item(s) without repository evidence`,
    });
  }
  if (result.excludedFiles.length > 0) {
    diagnostics.push({ code: "ATLAS-AI03", severity: "info", message: `${result.excludedFiles.length} file(s) were never sent to the AI (secrets exclusion list)` });
  }
  return {
    ...graph,
    modules: graph.modules.map((m) => {
      const summary = result.moduleSummaries[m.id];
      return summary ? { ...m, summary } : m;
    }),
    features: result.features.length > 0 ? result.features : graph.features,
    startup: mergeStartup(graph.startup, result.startup),
    history: graph.history.map((h) => {
      const aiSummary = result.historySummaries[h.moduleId];
      return aiSummary ? { ...h, aiSummary } : h;
    }),
    llmUsage: result.usage,
    diagnostics,
  };
}
