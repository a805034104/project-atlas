import { createLimiter } from "../util/collections.js";
import type { UserFacingError } from "../protocol.js";
import { stableId } from "../model/ids.js";
import type { Feature, LlmUsage, StartupGuide } from "../model/types.js";
import { TokenBudget, estimateTokens } from "./budget.js";
import { cacheKey, sha256, type LlmCache } from "./cache.js";
import { LlmEmptyError, LlmError, LlmRateLimitError, LlmSchemaError, isAbortError, isFatalLlmError } from "./errors.js";
import {
  PROMPT_VERSION,
  featuresPrompt,
  fileSummaryPrompt,
  historySummaryPrompt,
  moduleSummaryPrompt,
  startupPrompt,
  type OutputLanguage,
  type Prompt,
} from "./prompt.js";
import type { LlmProvider } from "./providers.js";
import { isExcludedFromAI, redactText } from "./redact.js";
import { withRetry, type Sleep } from "./retry.js";
import {
  checkFeatures,
  checkStartup,
  parseJsonObject,
  validateFeatures,
  validateStartup,
  validateSummary,
} from "./validate.js";

/**
 * AI map-reduce over the deterministic graph (spec「AI 分析流程」3–5).
 *
 *   hub files ──map──▶ file summaries ──reduce──▶ module summaries ──▶ features
 *   startup evidence ─────────────────────────────────────────────────▶ startup guides
 *   git log per module (messages + file lists) ───────────────────────▶ history summaries
 *
 * Invalidation DAG (ENG-A10): every node is cached under its INPUT hash.
 *
 *   file.inputHash   = H(path, content hash, language)
 *   module.inputHash = H(module, sorted child file.inputHash …)     ← not child summary text
 *   features         = H(modules + module.inputHash, entrypoints)
 *
 * so an unchanged subtree is a cache hit even though LLM output is
 * nondeterministic. Each call:
 *
 *   prompt ─▶ cache? ─hit─▶ value
 *              │miss
 *              ▼
 *   budget.reserve ─▶ provider.complete (withRetry) ─▶ parse ─▶ validate ─▶ cache.set
 *                                                         └─ schema/empty: re-ask once with the error
 *
 * Auth / unreachable / budget errors and cancellation abort everything
 * (in-flight fetches included); every other LLM error is recorded in
 * `failures` and the pipeline continues with partial results.
 */

export const LLM_ANALYZER_VERSION = "0.1.0";
const DEFAULT_CONCURRENCY = 4;
const MAX_HISTORY_COMMITS = 50;
/** Hub files longer than this are cut (and marked) before sending. */
const MAX_FILE_CHARS = 60_000;
/** Ceiling for the one retry after a truncated response (non-streaming requests stay well under HTTP timeouts). */
const MAX_OUTPUT_TOKENS = 16_000;

export type AiPhase = "file-summary" | "module-summary" | "features" | "startup" | "history";

export interface AiProgress {
  phase: AiPhase;
  done: number;
  total: number;
  /** Set while a call waits for a retry (rate-limit → 「限流等待」). */
  waiting?: "rate-limit" | "retry";
}

export interface AiFileInput {
  rootId: string;
  path: string;
  content: string;
  /** Content hash of the file (as computed by ingest). */
  hash: string;
  moduleId: string;
  /** Only hub files are summarized; the caller picks them (entrypoints, services, PageRank top 20). */
  hub: boolean;
}

export interface AiPipelineInput {
  provider: LlmProvider;
  cache: LlmCache;
  budget?: TokenBudget;
  concurrency?: number;
  language: OutputLanguage;
  signal?: AbortSignal;
  onProgress?: (progress: AiProgress) => void;
  analyzerVersion?: string;
  /** Injectable for tests (retry backoff). */
  sleep?: Sleep;
  files: AiFileInput[];
  modules: { id: string; name: string; path: string }[];
  entrypoints: { id: string; label: string; moduleId?: string }[];
  startupEvidence: { rootId: string; file: string; content: string }[];
  historyByModule: Record<string, { message: string; files: string[] }[]>;
}

export interface AiFailure {
  phase: AiPhase;
  key: string;
  error: UserFacingError;
}

export interface AiPipelineResult {
  fileSummaries: Record<string, string>;
  moduleSummaries: Record<string, string>;
  features: Feature[];
  startup: StartupGuide[];
  historySummaries: Record<string, string>;
  usage: LlmUsage[];
  failures: AiFailure[];
  /** Items dropped by the evidence check (spec: EvidenceRejected, shown as a count). */
  evidenceRejected: { features: number; startup: number };
  /** Hub files never sent because they match the AI exclusion list. */
  excludedFiles: string[];
}

interface CallSpec<T> {
  phase: AiPhase;
  key: string;
  inputHash: string;
  /** undefined = nothing to send; only a cache hit can produce a value. */
  prompt: Prompt | undefined;
  validate: (value: unknown) => T;
}

export async function runAiPipeline(input: AiPipelineInput): Promise<AiPipelineResult> {
  input.signal?.throwIfAborted();
  const { provider, cache, language } = input;
  const budget = input.budget ?? new TokenBudget();
  const analyzerVersion = input.analyzerVersion ?? LLM_ANALYZER_VERSION;
  const modelKey = `${provider.name}:${provider.model}`;
  const limit = createLimiter(Math.max(1, input.concurrency ?? DEFAULT_CONCURRENCY));

  // One controller for the whole run: caller cancellation and fatal errors both trip it.
  const run = new AbortController();
  const onCallerAbort = (): void => run.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", onCallerAbort, { once: true });

  const failures: AiFailure[] = [];
  const usageByPhase = new Map<AiPhase, LlmUsage>();
  const progress = new Map<AiPhase, { done: number; total: number }>();

  const report = (phase: AiPhase, waiting?: AiProgress["waiting"]): void => {
    const p = progress.get(phase) ?? { done: 0, total: 0 };
    input.onProgress?.(waiting ? { phase, ...p, waiting } : { phase, ...p });
  };
  const startPhase = (phase: AiPhase, total: number): void => {
    progress.set(phase, { done: 0, total });
    report(phase);
  };
  const tick = (phase: AiPhase): void => {
    const p = progress.get(phase);
    if (p) p.done++;
    report(phase);
  };

  async function ask<T>(phase: AiPhase, prompt: Prompt, validate: (value: unknown) => T): Promise<T> {
    let maxOutputTokens = prompt.maxOutputTokens;
    for (;;) {
      const response = await send(phase, prompt, maxOutputTokens);
      if (!response.truncated) return validate(parseJsonObject(response.text));
      // Cut off at the output limit: the JSON is incomplete. Retry once with a larger limit.
      if (maxOutputTokens >= MAX_OUTPUT_TOKENS) throw new LlmEmptyError(provider.name, "truncated");
      maxOutputTokens = Math.min(maxOutputTokens * 4, MAX_OUTPUT_TOKENS);
    }
  }

  async function send(phase: AiPhase, prompt: Prompt, maxOutputTokens: number) {
    const estimate = estimateTokens(prompt.system) + estimateTokens(prompt.user);
    budget.reserve(estimate);
    let response;
    try {
      response = await withRetry(
        () =>
          provider.complete({
            system: prompt.system,
            user: prompt.user,
            maxOutputTokens,
            signal: run.signal,
          }),
        {
          signal: run.signal,
          ...(input.sleep ? { sleep: input.sleep } : {}),
          onRetry: ({ error }) => report(phase, error instanceof LlmRateLimitError ? "rate-limit" : "retry"),
        },
      );
    } catch (error) {
      budget.release(estimate);
      throw error;
    }
    budget.settle(estimate, response.inputTokens);
    const usage = usageByPhase.get(phase) ?? {
      provider: provider.name,
      model: provider.model,
      phase,
      inputTokens: 0,
      outputTokens: 0,
    };
    usage.inputTokens += response.inputTokens;
    usage.outputTokens += response.outputTokens;
    usageByPhase.set(phase, usage);
    return response;
  }

  async function call<T>(spec: CallSpec<T>): Promise<T | undefined> {
    return limit(async () => {
      run.signal.throwIfAborted();
      const key = cacheKey({
        phase: spec.phase,
        inputHash: spec.inputHash,
        analyzerVersion,
        promptVersion: PROMPT_VERSION,
        model: modelKey,
      });
      const cached = await cache.get(key);
      if (cached !== undefined) {
        try {
          return spec.validate(cached);
        } catch {
          await cache.delete(key);
        }
      }
      if (!spec.prompt) return undefined;

      try {
        let prompt = spec.prompt;
        for (let attempt = 0; ; attempt++) {
          try {
            const value = await ask(spec.phase, prompt, spec.validate);
            await cache.set(key, value);
            return value;
          } catch (error) {
            const reAsk = (error instanceof LlmSchemaError || error instanceof LlmEmptyError) && attempt === 0;
            if (!reAsk) throw error;
            prompt = {
              ...prompt,
              user: `${prompt.user}\n\nYour previous reply was rejected: ${error.message}. Reply again with ONLY one JSON object of the required shape.`,
            };
          }
        }
      } catch (error) {
        if (isFatalLlmError(error) || isAbortError(error) || run.signal.aborted || !(error instanceof LlmError)) {
          if (!run.signal.aborted) run.abort(error);
          throw error;
        }
        failures.push({ phase: spec.phase, key: spec.key, error: error.toUserFacing() });
        return undefined;
      }
    });
  }

  // ── inputs ────────────────────────────────────────────────────────────────
  const fileKey = (f: { rootId: string; path: string }): string => `${f.rootId}:${f.path}`;
  const hubFiles = input.files.filter((f) => f.hub);
  const excludedFiles = hubFiles.filter((f) => isExcludedFromAI(f.path)).map(fileKey);
  const sendable = hubFiles.filter((f) => !isExcludedFromAI(f.path));
  const fileInputHash = new Map(
    sendable.map((f) => [fileKey(f), sha256(["file", f.rootId, f.path, f.hash, language].join("\0"))] as const),
  );

  const fileSummaries: Record<string, string> = {};
  const moduleSummaries: Record<string, string> = {};
  const moduleInputHash = new Map<string, string>();
  const historySummaries: Record<string, string> = {};
  let features: Feature[] = [];
  let startup: StartupGuide[] = [];
  const evidenceRejected = { features: 0, startup: 0 };

  // ── phase chains ──────────────────────────────────────────────────────────
  async function summarizeFiles(): Promise<void> {
    startPhase("file-summary", sendable.length);
    await Promise.all(
      sendable.map(async (f) => {
        const k = fileKey(f);
        const content = f.content.length > MAX_FILE_CHARS ? `${f.content.slice(0, MAX_FILE_CHARS)}\n…[truncated by Atlas]` : f.content;
        const value = await call({
          phase: "file-summary",
          key: k,
          inputHash: fileInputHash.get(k) ?? "",
          prompt: fileSummaryPrompt({ path: f.path, content: redactText(content).text, language }),
          validate: validateSummary,
        });
        if (value) fileSummaries[k] = value.summary;
        tick("file-summary");
      }),
    );
  }

  async function summarizeModules(): Promise<void> {
    const work = input.modules
      .map((m) => ({ module: m, children: sendable.filter((f) => f.moduleId === m.id) }))
      .filter((w) => w.children.length > 0);
    startPhase("module-summary", work.length);
    await Promise.all(
      work.map(async ({ module, children }) => {
        const childHashes = children.map((f) => fileInputHash.get(fileKey(f)) ?? "").sort();
        const inputHash = sha256(["module", module.id, module.name, module.path, language, ...childHashes].join("\0"));
        moduleInputHash.set(module.id, inputHash);
        const summaries = children
          .filter((f) => fileSummaries[fileKey(f)] !== undefined)
          .map((f) => ({ path: f.path, summary: fileSummaries[fileKey(f)] ?? "" }));
        const value = await call({
          phase: "module-summary",
          key: module.id,
          inputHash,
          prompt: summaries.length > 0 ? moduleSummaryPrompt({ module, fileSummaries: summaries, language }) : undefined,
          validate: validateSummary,
        });
        if (value) moduleSummaries[module.id] = value.summary;
        tick("module-summary");
      }),
    );
  }

  async function deriveFeatures(): Promise<void> {
    if (input.modules.length === 0 && input.entrypoints.length === 0) return;
    startPhase("features", 1);
    const modules = [...input.modules].sort((a, b) => a.id.localeCompare(b.id));
    const entrypoints = [...input.entrypoints].sort((a, b) => a.id.localeCompare(b.id));
    const inputHash = sha256(
      JSON.stringify({
        language,
        modules: modules.map((m) => [m.id, m.name, moduleInputHash.get(m.id) ?? ""]),
        entrypoints: entrypoints.map((e) => [e.id, e.label, e.moduleId ?? ""]),
      }),
    );
    const value = await call({
      phase: "features",
      key: "features",
      inputHash,
      prompt: featuresPrompt({
        modules: modules.map((m) => {
          const summary = moduleSummaries[m.id];
          return summary === undefined ? { id: m.id, name: m.name } : { id: m.id, name: m.name, summary };
        }),
        entrypoints: entrypoints.map((e) =>
          e.moduleId === undefined ? { id: e.id, label: e.label } : { id: e.id, label: e.label, moduleId: e.moduleId },
        ),
        language,
      }),
      validate: validateFeatures,
    });
    tick("features");
    if (!value) return;
    const checked = checkFeatures(value.features, {
      moduleIds: new Set(input.modules.map((m) => m.id)),
      entrypointIds: new Set(input.entrypoints.map((e) => e.id)),
    });
    evidenceRejected.features = checked.rejected;
    const seen = new Set<string>();
    features = [];
    for (const f of checked.kept) {
      const id = stableId("feature", "", f.title);
      if (seen.has(id)) continue;
      seen.add(id);
      features.push({ id, title: f.title, description: f.description, tier: f.tier, moduleIds: f.moduleIds, entrypointIds: f.entrypointIds });
    }
  }

  async function deriveStartup(): Promise<void> {
    const evidence = input.startupEvidence.filter((e) => !isExcludedFromAI(e.file));
    if (evidence.length === 0) return;
    startPhase("startup", 1);
    const counts = new Map<string, number>();
    for (const e of evidence) counts.set(e.file, (counts.get(e.file) ?? 0) + 1);
    const byLabel = new Map(
      evidence.map((e) => [(counts.get(e.file) ?? 0) > 1 ? `${e.rootId}:${e.file}` : e.file, e] as const),
    );
    const labels = [...byLabel.keys()].sort();
    const inputHash = sha256(
      JSON.stringify({ language, files: labels.map((l) => [l, sha256(byLabel.get(l)?.content ?? "")]) }),
    );
    const value = await call({
      phase: "startup",
      key: "startup",
      inputHash,
      prompt: startupPrompt({
        evidence: labels.map((l) => ({ path: l, content: redactText(byLabel.get(l)?.content ?? "").text })),
        language,
      }),
      validate: validateStartup,
    });
    tick("startup");
    if (!value) return;
    const checked = await checkStartup(value.guides, {
      rootIdOf: (label) => byLabel.get(label)?.rootId,
      pathOf: (label) => byLabel.get(label)?.file ?? label,
      readFile: (rootId, file) => evidence.find((e) => e.rootId === rootId && e.file === file)?.content,
    });
    evidenceRejected.startup = checked.rejected;
    startup = checked.kept;
  }

  async function summarizeHistory(): Promise<void> {
    const names = new Map(input.modules.map((m) => [m.id, m.name]));
    const work = Object.entries(input.historyByModule).filter(([, commits]) => commits.length > 0);
    startPhase("history", work.length);
    await Promise.all(
      work.map(async ([moduleId, all]) => {
        const commits = all.slice(0, MAX_HISTORY_COMMITS).map((c) => ({
          message: redactText(c.message).text,
          files: [...c.files],
        }));
        const name = names.get(moduleId) ?? moduleId;
        const inputHash = sha256(JSON.stringify({ language, moduleId, name, commits }));
        const value = await call({
          phase: "history",
          key: moduleId,
          inputHash,
          prompt: historySummaryPrompt({ module: { name }, commits, language }),
          validate: validateSummary,
        });
        if (value) historySummaries[moduleId] = value.summary;
        tick("history");
      }),
    );
  }

  try {
    await Promise.all([
      (async () => {
        await summarizeFiles();
        await summarizeModules();
        await deriveFeatures();
      })(),
      deriveStartup(),
      summarizeHistory(),
    ]);
  } catch (error) {
    if (!run.signal.aborted) run.abort(error);
    throw error;
  } finally {
    input.signal?.removeEventListener("abort", onCallerAbort);
  }

  return {
    fileSummaries,
    moduleSummaries,
    features,
    startup,
    historySummaries,
    usage: [...usageByPhase.values()],
    failures,
    evidenceRejected,
    excludedFiles,
  };
}

/**
 * Tiny FIFO semaphore. A finishing task hands its slot directly to the next
 * waiter, so the number of running tasks never exceeds `max`.
 */

export { createLimiter };
