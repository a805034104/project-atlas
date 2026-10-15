import * as vscode from "vscode";
import path from "node:path";
import { rm } from "node:fs/promises";
import {
  analyzeWorkspace,
  buildAiInput,
  readAtlasOverrides,
  shallowClone,
  type Diagnostic,
  type RootInput,
  createProvider,
  enrichWithAi,
  estimateAiCost,
  GraphView,
  loadStoredGraph,
  saveGraph,
  type AiPhase,
  type AnalysisPhase,
  type AnalysisState,
  type AtlasGraph,
  type UserFacingError,
} from "@project-atlas/core";
import { phaseChoices, planTitle } from "./cost.js";
import { log } from "./log.js";
import { isChinese, providerConfig, readSettings, t } from "./settings.js";

/**
 * Owns the analysis lifecycle and the current graph.
 *
 *   never ─analyze▶ running(parse→rules→cross-service→history) ─▶ done ─(AI configured?)▶
 *        cost dialog ─confirm▶ ai running ─▶ done / partial / error
 *                    └decline▶ declined
 *   file changes while done ─▶ staleFiles++ (banner) ─analyzeIncremental▶ running …
 */

const PHASES: AnalysisPhase[] = ["parse", "rules", "cross-service", "history", "ai"];

export class AtlasController implements vscode.Disposable {
  private graphValue: AtlasGraph | undefined;
  private viewValue: GraphView | undefined;
  private running: { cancel: AbortController; promise: Promise<void> } | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly stateChanged = new vscode.EventEmitter<AnalysisState>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly staleFiles = new Set<string>();
  state: AnalysisState = { status: "never", completedPhases: [], staleFiles: 0, ai: "none" };

  /** Fired when a new graph is available. */
  readonly onDidChangeGraph = this.changed.event;
  readonly onDidChangeState = this.stateChanged.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    readonly workspaceRoot: vscode.Uri,
  ) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceRoot, "**/*.{java,vue,js,ts,xml,yml,yaml,properties,json}"));
    const mark = (uri: vscode.Uri) => {
      if (/[\\/](\.atlas|node_modules|target|dist|\.git)[\\/]/.test(uri.fsPath) || this.state.status !== "done") return;
      this.staleFiles.add(uri.fsPath);
      this.setState({ staleFiles: this.staleFiles.size });
    };
    watcher.onDidChange(mark, undefined, this.disposables);
    watcher.onDidCreate(mark, undefined, this.disposables);
    watcher.onDidDelete(mark, undefined, this.disposables);
    this.disposables.push(watcher, this.changed, this.stateChanged);
  }

  get atlasDir(): string {
    return path.join(this.workspaceRoot.fsPath, ".atlas");
  }

  get graph(): AtlasGraph | undefined {
    return this.graphValue;
  }

  get view(): GraphView | undefined {
    return this.viewValue;
  }

  private setGraph(graph: AtlasGraph): void {
    this.graphValue = graph;
    this.viewValue = new GraphView(graph);
    this.changed.fire();
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

  /** Load a previous analysis from .atlas/graph (no re-analysis on startup). */
  async restore(): Promise<void> {
    const stored = await loadStoredGraph(this.atlasDir);
    if (stored.status === "ok") {
      this.setGraph(stored.graph);
      this.setState({ status: "done", completedPhases: [...PHASES], ai: stored.graph.llmUsage.length > 0 ? "done" : "none" });
      log(`Loaded stored map (${stored.graph.entrypoints.length} entrypoints, analyzed ${stored.graph.project.analyzedAt})`);
    } else if (stored.status === "rebuild") {
      log(`Stored map ignored: ${stored.reason}`);
    }
  }

  cancel(): void {
    this.running?.cancel.abort();
  }

  async analyze(): Promise<void> {
    if (this.running) return this.running.promise; // single analysis at a time; callers just await it
    const cancel = new AbortController();
    const promise = this.runAnalysis(cancel).finally(() => {
      this.running = undefined;
    });
    this.running = { cancel, promise };
    return promise;
  }

  private async runAnalysis(cancel: AbortController): Promise<void> {
    const settings = readSettings();
    const roots: RootInput[] = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file").map((f) => ({ path: f.uri.fsPath }));
    if (roots.length === 0) return;
    const firstRoot = roots[0] as RootInput;
    const { overrides } = await readAtlasOverrides(firstRoot.path);
    const cloneDiagnostics = await this.cloneDeclaredServices(overrides.services, roots, cancel.signal);
    this.staleFiles.clear();
    this.setState({ status: "running", completedPhases: [], currentPhase: "parse", progress: 0, staleFiles: 0, error: undefined });
    const started = Date.now();
    const wasmDir = vscode.Uri.joinPath(this.context.extensionUri, "dist", "wasm").fsPath;
    const workerPath = vscode.Uri.joinPath(this.context.extensionUri, "dist", "worker.js").fsPath;

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "Atlas", cancellable: true },
        async (progress, token) => {
          token.onCancellationRequested(() => cancel.abort());
          let last: AnalysisPhase | undefined;
          const result = await analyzeWorkspace({
            roots,
            cacheDir: this.atlasDir,
            wasmDir,
            workerPath,
            exclude: settings.exclude,
            maxFileSizeKB: settings.maxFileSizeKB,
            // git log honours repo-local config (textconv etc.): only in trusted workspaces.
            history: settings.history && vscode.workspace.isTrusted,
            overrides,
            signal: cancel.signal,
            onPhase: (phase, value) => {
              const completed = last && last !== phase ? [...new Set([...this.state.completedPhases, last])] : this.state.completedPhases;
              last = phase;
              this.setState({ currentPhase: phase, progress: value, completedPhases: completed });
              progress.report({ message: `${phaseLabel(phase)} ${Math.round(value * 100)}%` });
            },
          });
          result.graph.diagnostics.push(...cloneDiagnostics);
          await saveGraph(this.atlasDir, result.graph);
          this.setGraph(result.graph);
          this.setState({ status: "done", completedPhases: ["parse", "rules", "cross-service", "history"], ai: settings.provider === "none" ? "none" : "pending-confirmation" });
          log(`Deterministic analysis finished in ${Date.now() - started} ms: ${result.graph.services.length} services, ${result.graph.entrypoints.length} entrypoints, ${result.graph.serviceLinks.length} links, ${result.graph.unresolvedCalls.length} unresolved calls`);
          for (const d of result.graph.diagnostics.slice(0, 50)) log(`  ${d.severity} ${d.code} ${d.message}`);

          if (settings.provider !== "none") await this.runAi(result, settings, cancel.signal, progress);
        },
      );
    } catch (error) {
      if (cancel.signal.aborted) {
        this.setState({ status: this.graphValue ? "done" : "cancelled", currentPhase: undefined });
        log("Analysis cancelled");
        return;
      }
      const err = toUserFacing(error);
      log(`Analysis failed: ${err.code} ${err.problem} — ${err.cause}`);
      this.setState({ status: "error", error: err });
      void vscode.window.showErrorMessage(`${err.code} ${err.problem}`, t("查看日志", "Show log")).then((pick) => pick && vscode.commands.executeCommand("atlas.showLog"));
    }
  }

  private async runAi(
    result: Awaited<ReturnType<typeof analyzeWorkspace>>,
    settings: ReturnType<typeof readSettings>,
    signal: AbortSignal,
    progress: vscode.Progress<{ message?: string }>,
  ): Promise<void> {
    const config = await providerConfig(this.context.secrets, settings);
    if (!config) return;
    if (!vscode.workspace.isTrusted) {
      this.setState({ ai: "none" });
      log("AI analysis skipped: workspace is not trusted (Restricted Mode)");
      return;
    }
    if (config.provider !== "ollama" && !config.apiKey) {
      this.setState({ ai: "error", error: missingKeyError() });
      return;
    }
    const input = await buildAiInput(result.graph, result.workspace);
    const provider = createProvider(config);
    const plan = estimateAiCost(input, provider.model, config.provider);
    const zh = isChinese();
    const choices = phaseChoices(plan, zh);
    const destination = config.provider === "ollama" ? config.baseUrl ?? "http://localhost:11434" : config.baseUrl ?? "https://api.anthropic.com";
    let origin = destination;
    try {
      origin = new URL(destination).origin;
    } catch {
      // keep the raw value; the provider call will fail with a clear error
    }
    const picked = await vscode.window.showQuickPick(choices, { canPickMany: true, title: `${planTitle(plan, zh)} → ${origin}`, ignoreFocusOut: true });
    if (!picked || picked.length === 0) {
      this.setState({ ai: "declined" });
      log("AI analysis declined by the user; deterministic map kept");
      return;
    }
    const skipPhases = choices.filter((c) => !picked.includes(c)).map((c) => c.phase as AiPhase);
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
          progress.report({ message: `AI ${p.phase} ${p.done}/${p.total}${p.waiting === "rate-limit" ? t("（限流等待）", " (rate limited)") : ""}` });
        },
      });
      await saveGraph(this.atlasDir, graph);
      this.setGraph(graph);
      this.setState({ ai: ai.failures.length > 0 ? "partial" : "done", completedPhases: [...PHASES], currentPhase: undefined });
      log(`AI enrichment: ${ai.usage.reduce((n, u) => n + u.inputTokens, 0)} input tokens, ${ai.failures.length} failures`);
    } catch (error) {
      if (signal.aborted) throw error;
      const err = toUserFacing(error);
      this.setState({ ai: "error", error: err });
      log(`AI enrichment failed: ${err.code} ${err.problem}`);
    }
  }

  /**
   * atlas.yaml `services[].git`: shallow-clone into .atlas/clones (trusted workspace + one-time
   * confirmation per URL). A failed clone only fails that service.
   */
  private async cloneDeclaredServices(services: readonly { git?: string; ref?: string; path?: string; name?: string }[], roots: RootInput[], signal: AbortSignal): Promise<Diagnostic[]> {
    const wanted = services.filter((s) => s.git && s.path === undefined);
    if (wanted.length === 0) return [];
    if (!vscode.workspace.isTrusted) {
      return [{ code: "ATLAS-E030", severity: "warning", message: t("受限模式下不会克隆 atlas.yaml 中的仓库", "Repositories in atlas.yaml are not cloned in Restricted Mode") }];
    }
    const approvedKey = "atlas.approvedCloneUrls";
    const approved = new Set(this.context.workspaceState.get<string[]>(approvedKey, []));
    const pending = wanted.filter((s) => !approved.has(s.git as string));
    if (pending.length > 0) {
      const ok = t("克隆", "Clone");
      const pick = await vscode.window.showWarningMessage(
        t(`atlas.yaml 声明了 ${pending.length} 个远程仓库，需要浅克隆到 .atlas/clones：`, `atlas.yaml declares ${pending.length} remote repositories to shallow-clone into .atlas/clones:`) + "\n" + pending.map((s) => s.git).join("\n"),
        { modal: true },
        ok,
      );
      if (pick !== ok) return [{ code: "ATLAS-E030", severity: "info", message: t("已跳过 atlas.yaml 中的远程仓库", "Skipped remote repositories from atlas.yaml") }];
      for (const s of pending) approved.add(s.git as string);
      await this.context.workspaceState.update(approvedKey, [...approved]);
    }
    const diagnostics: Diagnostic[] = [];
    for (const s of wanted) {
      try {
        const dir = await shallowClone({ atlasDir: this.atlasDir, url: s.git as string, ...(s.ref ? { ref: s.ref } : {}), signal });
        roots.push({ path: dir, kind: "clone", git: { url: s.git as string, ...(s.ref ? { ref: s.ref } : {}), shallow: true } });
        log(`Cloned ${s.git} → ${dir}`);
      } catch (error) {
        const err = toUserFacing(error);
        diagnostics.push({ code: err.code, severity: "error", message: `${err.problem}: ${err.cause}` });
        log(`Clone failed: ${err.problem} — ${err.cause}`);
      }
    }
    return diagnostics;
  }

  markStale(file: string): void {
    this.staleFiles.add(file);
    this.setState({ staleFiles: this.staleFiles.size });
  }

  async clearCache(): Promise<void> {
    await rm(path.join(this.atlasDir, "facts"), { recursive: true, force: true });
    await rm(path.join(this.atlasDir, "llm"), { recursive: true, force: true });
  }

  dispose(): void {
    this.cancel();
    for (const d of this.disposables) d.dispose();
  }
}

function phaseLabel(phase: AnalysisPhase): string {
  const zh: Record<AnalysisPhase, string> = { parse: "解析", rules: "规则", "cross-service": "跨服务", history: "修改记录", ai: "AI" };
  const en: Record<AnalysisPhase, string> = { parse: "Parsing", rules: "Rules", "cross-service": "Cross-service", history: "History", ai: "AI" };
  return isChinese() ? zh[phase] : en[phase];
}

function missingKeyError(): UserFacingError {
  return {
    code: "ATLAS-E020",
    problem: t("没有配置 API Key", "No API key configured"),
    cause: t("已选择 AI 提供方，但 SecretStorage 中没有对应的 Key", "An AI provider is selected but no key is stored for it"),
    fix: t("运行「Atlas: 配置模型」", "Run “Atlas: Configure AI Model”"),
    docsUrl: "https://github.com/project-atlas/project-atlas/blob/main/docs/errors.md#atlas-e020",
    fixCommand: "atlas.configureProvider",
  };
}

export function toUserFacing(error: unknown): UserFacingError {
  if (error && typeof error === "object" && "toUserFacing" in error && typeof (error as { toUserFacing: unknown }).toUserFacing === "function") {
    return (error as { toUserFacing(): UserFacingError }).toUserFacing();
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "ATLAS-E000",
    problem: t("分析失败", "Analysis failed"),
    cause: message,
    fix: t("运行「Atlas: 导出诊断包」并附在 issue 中", "Run “Atlas: Export Diagnostics” and attach it to an issue"),
    docsUrl: "https://github.com/project-atlas/project-atlas/blob/main/docs/errors.md",
    fixCommand: "atlas.diagnose",
  };
}
