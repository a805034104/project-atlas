import path from "node:path";
import { rm } from "node:fs/promises";
import { analyzeWorkspace, readAtlasOverrides, type RootInput } from "../analyze.js";
import { buildAiInput, enrichWithAi, estimateAiCost } from "../enrich.js";
import { docsUrlFor } from "../llm/errors.js";
import { createProvider } from "../llm/providers.js";
import type { AiPhase } from "../llm/pipeline.js";
import type { AtlasGraph, Diagnostic } from "../model/types.js";
import type { AnalysisPhase, AnalysisState, TraceData, UserFacingError } from "../protocol.js";
import { GraphView, loadStoredGraph, saveGraph } from "../store/graph-store.js";
import { shallowClone } from "../workspace/clone.js";
import { phaseChoices, planTitle } from "./cost.js";
import { Emitter } from "./emitter.js";
import { translator, type HostEnv } from "./env.js";

/**
 * Owns the analysis lifecycle and the current graph (shared by the VS Code extension and the
 * local web server).
 *
 *   never ─analyze▶ running(parse→rules→cross-service→history) ─▶ done ─(AI configured?)▶
 *        cost confirmation ─confirm▶ ai running ─▶ done / partial / error
 *                          └decline▶ declined
 *   file changes while done ─▶ markStale ─▶ staleFiles++ (banner) ─analyze▶ running …
 */

const PHASES: AnalysisPhase[] = ["parse", "rules", "cross-service", "history", "ai"];

export interface RuntimeDecorator {
  decorate(graph: AtlasGraph): AtlasGraph;
  traceData(graph: AtlasGraph): TraceData;
}

export interface AnalysisControllerOptions {
  env: HostEnv;
  /** Workspace roots; the first one holds atlas.yaml. */
  roots: () => RootInput[];
  /** Where the map, caches, overrides and traces live (normally <root>/.atlas). */
  atlasDir: string;
  /**
   * Runs the heavy part (parsing with worker threads, rules) under a host-wide lock; hosts that
   * analyze several projects pass one so only one parses at a time. Prompts (clone confirmation,
   * AI cost) and AI calls run outside it, so a question left open never blocks other projects.
   */
  exclusive?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export class AnalysisController {
  private graphValue: AtlasGraph | undefined;
  private viewValue: GraphView | undefined;
  private viewStale = false;
  private running: { cancel: AbortController; promise: Promise<void> } | undefined;
  private decorator: RuntimeDecorator | undefined;
  private readonly changed = new Emitter<void>();
  private readonly stateChanged = new Emitter<AnalysisState>();
  private readonly staleFiles = new Set<string>();
  private readonly env: HostEnv;
  private readonly t: (zh: string, en: string) => string;
  readonly atlasDir: string;
  private readonly roots: () => RootInput[];
  private readonly exclusive: <T>(fn: () => Promise<T>) => Promise<T>;
  state: AnalysisState = { status: "never", completedPhases: [], staleFiles: 0, ai: "none" };

  /** Fired when a new graph is available. */
  readonly onDidChangeGraph = this.changed.event;
  readonly onDidChangeState = this.stateChanged.event;

  constructor(options: AnalysisControllerOptions) {
    this.env = options.env;
    this.t = translator(options.env);
    this.atlasDir = options.atlasDir;
    this.roots = options.roots;
    this.exclusive = options.exclusive ?? ((fn) => fn());
  }

  get graph(): AtlasGraph | undefined {
    return this.graphValue;
  }

  get view(): GraphView | undefined {
    // Built lazily: while spans stream in, the overlay changes every second, but the view
    // (reconcile + applyOverlay over the whole graph) is only rebuilt when something reads it.
    if (this.viewStale) {
      this.viewStale = false;
      this.rebuildView();
    }
    return this.viewValue;
  }

  get busy(): boolean {
    return this.running !== undefined;
  }

  private setGraph(graph: AtlasGraph): void {
    this.graphValue = graph;
    this.rebuildView();
    this.changed.fire();
  }

  /**
   * Runtime overlay (v0.2): observed stats folded into every view and flow. The analysis
   * graph itself stays untouched (it is what gets saved); call again when spans arrive.
   */
  setRuntimeDecorator(decorator: RuntimeDecorator | undefined): void {
    this.decorator = decorator;
    this.invalidateRuntime();
  }

  /** Observed stats changed: the next `view` read rebuilds with the current overlay. */
  invalidateRuntime(): void {
    if (this.graphValue) this.viewStale = true;
  }

  private rebuildView(): void {
    const graph = this.graphValue;
    if (!graph) return;
    this.viewStale = false;
    const decorator = this.decorator;
    this.viewValue = decorator ? new GraphView(decorator.decorate(graph), () => decorator.traceData(graph)) : new GraphView(graph);
  }

  /** Patch the state; keys explicitly set to `undefined` are removed. */
  private setState(patch: { [K in keyof AnalysisState]?: AnalysisState[K] | undefined }): void {
    const next = { ...this.state } as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    this.state = next as unknown as AnalysisState;
    this.stateChanged.fire(this.state);
  }

  /** Load a previous analysis from <atlasDir>/graph (no re-analysis on startup). */
  async restore(): Promise<void> {
    const stored = await loadStoredGraph(this.atlasDir);
    // An analysis started (or finished) while the stored map was loading: never overwrite it.
    if (this.running || this.graphValue) return;
    if (stored.status === "ok") {
      this.setGraph(stored.graph);
      this.setState({ status: "done", completedPhases: [...PHASES], ai: stored.graph.llmUsage.length > 0 ? "done" : "none" });
      this.env.log(`Loaded stored map (${stored.graph.entrypoints.length} entrypoints, analyzed ${stored.graph.project.analyzedAt})`);
    } else if (stored.status === "rebuild") {
      this.env.log(`Stored map ignored: ${stored.reason}`);
    }
  }

  cancel(): void {
    this.running?.cancel.abort();
  }

  /** Start an analysis, or join the one already running. */
  analyze(): Promise<void> {
    if (this.running) return this.running.promise;
    const cancel = new AbortController();
    const promise = this.runAnalysis(cancel).finally(() => {
      this.running = undefined;
    });
    this.running = { cancel, promise };
    return promise;
  }

  private async runAnalysis(cancel: AbortController): Promise<void> {
    const settings = this.env.settings();
    const roots = this.roots();
    if (roots.length === 0) return;
    const firstRoot = roots[0] as RootInput;
    const { overrides } = await readAtlasOverrides(firstRoot.path);
    const cloneDiagnostics = await this.cloneDeclaredServices(overrides.services, roots, cancel.signal);
    this.staleFiles.clear();
    this.setState({ status: "running", completedPhases: [], currentPhase: "parse", progress: 0, staleFiles: 0, error: undefined });
    const started = Date.now();

    try {
      await this.env.progress("Atlas", async (progress) => {
        progress.onCancel(() => cancel.abort());
        let last: AnalysisPhase | undefined;
        this.setState({ queued: true });
        progress.report(this.t("等待其他项目的分析完成…", "Waiting for another project's analysis…"));
        const result = await this.exclusive(async () => {
          // Cancelled while waiting: never start parsing.
          cancel.signal.throwIfAborted();
          this.setState({ queued: false });
          return analyzeWorkspace({
          roots,
          cacheDir: this.atlasDir,
          ...(this.env.assets.wasmDir ? { wasmDir: this.env.assets.wasmDir } : {}),
          ...(this.env.assets.workerPath ? { workerPath: this.env.assets.workerPath } : {}),
          exclude: settings.exclude,
          maxFileSizeKB: settings.maxFileSizeKB,
          // git log honours repo-local config (textconv etc.): only in trusted workspaces.
          history: settings.history && this.env.trusted(),
          overrides,
          signal: cancel.signal,
          onPhase: (phase, value) => {
            const completed = last && last !== phase ? [...new Set([...this.state.completedPhases, last])] : this.state.completedPhases;
            last = phase;
            this.setState({ currentPhase: phase, progress: value, completedPhases: completed });
            progress.report(`${this.phaseLabel(phase)} ${Math.round(value * 100)}%`);
          },
          });
        });
        result.graph.diagnostics.push(...cloneDiagnostics);
        await saveGraph(this.atlasDir, result.graph);
        this.setGraph(result.graph);
        this.setState({ status: "done", completedPhases: ["parse", "rules", "cross-service", "history"], ai: settings.provider === "none" ? "none" : "pending-confirmation" });
        this.env.log(`Deterministic analysis finished in ${Date.now() - started} ms: ${result.graph.services.length} services, ${result.graph.entrypoints.length} entrypoints, ${result.graph.serviceLinks.length} links, ${result.graph.unresolvedCalls.length} unresolved calls`);
        for (const d of result.graph.diagnostics.slice(0, 50)) this.env.log(`  ${d.severity} ${d.code} ${d.message}`);

        if (settings.provider !== "none") await this.runAi(result, cancel.signal, progress);
      });
    } catch (error) {
      if (cancel.signal.aborted) {
        const ai = this.state.ai === "running" || this.state.ai === "pending-confirmation" ? (this.graphValue?.llmUsage.length ? "partial" : "none") : this.state.ai;
        this.setState({ status: this.graphValue ? "done" : "cancelled", currentPhase: undefined, progress: undefined, ai, queued: false });
        this.env.log("Analysis cancelled");
        return;
      }
      const err = toUserFacing(error, this.t);
      this.env.log(`Analysis failed: ${err.code} ${err.problem} — ${err.cause}`);
      this.setState({ status: "error", error: err, queued: false });
      const showLog = this.t("查看日志", "Show log");
      void this.env.notify("error", `${err.code} ${err.problem}`, this.env.showLog ? [showLog] : []).then((pick) => pick === showLog && this.env.showLog?.());
    }
  }

  private async runAi(result: Awaited<ReturnType<typeof analyzeWorkspace>>, signal: AbortSignal, progress: { report(message: string): void }): Promise<void> {
    const settings = this.env.settings();
    const config = await this.env.providerConfig();
    if (!config) {
      this.setState({ ai: "none" });
      return;
    }
    if (!this.env.trusted()) {
      this.setState({ ai: "none" });
      this.env.log("AI analysis skipped: the workspace is not trusted");
      return;
    }
    if (config.provider !== "ollama" && !config.apiKey) {
      this.setState({ ai: "error", error: missingKeyError(this.t) });
      return;
    }
    const input = await buildAiInput(result.graph, result.workspace);
    const provider = createProvider(config);
    const plan = estimateAiCost(input, provider.model, config.provider);
    const zh = this.env.locale().toLowerCase().startsWith("zh");
    const choices = phaseChoices(plan, zh);
    const destination = config.provider === "ollama" ? (config.baseUrl ?? "http://localhost:11434") : (config.baseUrl ?? "https://api.anthropic.com");
    let origin = destination;
    try {
      origin = new URL(destination).origin;
    } catch {
      // keep the raw value; the provider call will fail with a clear error
    }
    const picked = await this.env.choose({ title: `${planTitle(plan, zh)} → ${origin}`, many: true, items: choices.map((c) => ({ id: c.phase, label: c.label, description: c.description, picked: c.picked })) });
    if (!picked || picked.length === 0) {
      this.setState({ ai: "declined" });
      this.env.log("AI analysis declined by the user; deterministic map kept");
      return;
    }
    const skipPhases = choices.filter((c) => !picked.includes(c.phase)).map((c) => c.phase as AiPhase);
    this.setState({ ai: "running", currentPhase: "ai", progress: 0 });
    try {
      const { graph, result: ai } = await enrichWithAi({
        graph: result.graph,
        input,
        provider,
        cacheDir: this.atlasDir,
        language: settings.outputLanguage,
        concurrency: settings.concurrency,
        maxInputTokens: settings.maxInputTokens,
        skipPhases,
        signal,
        onProgress: (p) => {
          this.setState({ progress: p.total ? p.done / p.total : 0 });
          progress.report(`AI ${p.phase} ${p.done}/${p.total}${p.waiting === "rate-limit" ? this.t("（限流等待）", " (rate limited)") : ""}`);
        },
      });
      await saveGraph(this.atlasDir, graph);
      this.setGraph(graph);
      this.setState({ ai: ai.failures.length > 0 ? "partial" : "done", completedPhases: [...PHASES], currentPhase: undefined });
      this.env.log(`AI enrichment: ${ai.usage.reduce((n, u) => n + u.inputTokens, 0)} input tokens, ${ai.failures.length} failures`);
    } catch (error) {
      if (signal.aborted) throw error;
      const err = toUserFacing(error, this.t);
      this.setState({ ai: "error", error: err });
      this.env.log(`AI enrichment failed: ${err.code} ${err.problem}`);
    }
  }

  /**
   * atlas.yaml `services[].git`: shallow-clone into <atlasDir>/clones (trusted workspace + one-time
   * confirmation per URL). A failed clone only fails that service.
   */
  private async cloneDeclaredServices(services: readonly { git?: string; ref?: string; path?: string; name?: string }[], roots: RootInput[], signal: AbortSignal): Promise<Diagnostic[]> {
    const t = this.t;
    const wanted = services.filter((s) => s.git && s.path === undefined);
    if (wanted.length === 0) return [];
    if (!this.env.trusted()) {
      return [{ code: "ATLAS-E030", severity: "warning", message: t("未信任的工作区不会克隆 atlas.yaml 中的仓库", "Repositories in atlas.yaml are not cloned in an untrusted workspace") }];
    }
    const approvedKey = "atlas.approvedCloneUrls";
    const approved = new Set(this.env.memento.get<string[]>(approvedKey, []));
    const pending = wanted.filter((s) => !approved.has(s.git as string));
    if (pending.length > 0) {
      const ok = await this.env.confirm({
        message: t(`atlas.yaml 声明了 ${pending.length} 个远程仓库，需要浅克隆到 .atlas/clones：`, `atlas.yaml declares ${pending.length} remote repositories to shallow-clone into .atlas/clones:`),
        detail: pending.map((s) => s.git).join("\n"),
        action: t("克隆", "Clone"),
      });
      if (!ok) return [{ code: "ATLAS-E030", severity: "info", message: t("已跳过 atlas.yaml 中的远程仓库", "Skipped remote repositories from atlas.yaml") }];
      for (const s of pending) approved.add(s.git as string);
      await this.env.memento.update(approvedKey, [...approved]);
    }
    const diagnostics: Diagnostic[] = [];
    for (const s of wanted) {
      try {
        const dir = await shallowClone({ atlasDir: this.atlasDir, url: s.git as string, ...(s.ref ? { ref: s.ref } : {}), signal });
        roots.push({ path: dir, kind: "clone", git: { url: s.git as string, ...(s.ref ? { ref: s.ref } : {}), shallow: true } });
        this.env.log(`Cloned ${s.git} → ${dir}`);
      } catch (error) {
        const err = toUserFacing(error, t);
        diagnostics.push({ code: err.code, severity: "error", message: `${err.problem}: ${err.cause}` });
        this.env.log(`Clone failed: ${err.problem} — ${err.cause}`);
      }
    }
    return diagnostics;
  }

  /** A watched file changed since the analysis (the host owns the watcher). */
  markStale(file: string): void {
    if (this.state.status === "never") return;
    this.staleFiles.add(file);
    this.setState({ staleFiles: this.staleFiles.size });
  }

  async clearCache(): Promise<void> {
    await rm(path.join(this.atlasDir, "facts"), { recursive: true, force: true });
    await rm(path.join(this.atlasDir, "llm"), { recursive: true, force: true });
  }

  private phaseLabel(phase: AnalysisPhase): string {
    const zh: Record<AnalysisPhase, string> = { parse: "解析", rules: "规则", "cross-service": "跨服务", history: "修改记录", ai: "AI" };
    const en: Record<AnalysisPhase, string> = { parse: "Parsing", rules: "Rules", "cross-service": "Cross-service", history: "History", ai: "AI" };
    return this.t(zh[phase], en[phase]);
  }

  dispose(): void {
    this.cancel();
    this.changed.dispose();
    this.stateChanged.dispose();
  }
}

function missingKeyError(t: (zh: string, en: string) => string): UserFacingError {
  return {
    code: "ATLAS-E020",
    problem: t("没有配置 API Key", "No API key configured"),
    cause: t("已选择 AI 提供方，但没有保存对应的 Key", "An AI provider is selected but no key is stored for it"),
    fix: t("在设置里配置模型和 Key", "Configure the AI model and key in Settings"),
    docsUrl: docsUrlFor("ATLAS-E020"),
    fixCommand: "atlas.configureProvider",
  };
}

export function toUserFacing(error: unknown, t: (zh: string, en: string) => string = (_zh, en) => en): UserFacingError {
  if (error && typeof error === "object" && "toUserFacing" in error && typeof (error as { toUserFacing: unknown }).toUserFacing === "function") {
    return (error as { toUserFacing(): UserFacingError }).toUserFacing();
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "ATLAS-E000",
    problem: t("分析失败", "Analysis failed"),
    cause: message,
    fix: t("导出诊断包并附在 issue 中", "Export diagnostics and attach them to an issue"),
    docsUrl: docsUrlFor("ATLAS-E000").replace(/#atlas-e000$/, ""),
    fixCommand: "atlas.diagnose",
  };
}
