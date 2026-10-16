import * as vscode from "vscode";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createProvider, renderAtlasMarkdown, type ViewId } from "@project-atlas/core";
import { AtlasCodeLens, entrypointsForFile } from "./codelens.js";
import { AtlasController, toUserFacing } from "./controller.js";
import { initLog, log, recentLog, showLog } from "./log.js";
import { AtlasPanel } from "./panel.js";
import { isChinese, providerConfig, readSettings, storeApiKey, t, type ProviderName } from "./settings.js";
import { RuntimeManager } from "./runtime.js";
import { vscodeEnv } from "./env.js";
import { renderStaticHtml } from "./static-export.js";
import { AtlasTree } from "./tree.js";

/**
 * Activation wiring.
 *
 *   activate ─▶ controller.restore() (.atlas/graph) ─▶ tree, CodeLens, status bar
 *   commands: analyze / incremental / cancel / openPanel / reveal / flow /
 *             configureProvider / testConnection / export html|md / diagnose / clearCache
 */

/** Read-only hooks for the E2E suite (the extension exposes no other API). */
export interface AtlasExtensionApi {
  flowDetail(entrypointId: string): import("@project-atlas/core").FlowDetailData | undefined;
  runtimeState(): import("@project-atlas/core").RuntimeState | undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<AtlasExtensionApi | undefined> {
  context.subscriptions.push(initLog());
  const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === "file");
  if (!folder) return;
  let openPanelRef: ((reveal?: { view: ViewId; nodeId?: string }) => unknown) | undefined;
  const env = vscodeEnv(context, (view, nodeId) => openPanelRef?.({ view, ...(nodeId ? { nodeId } : {}) }));
  AtlasPanel.env = env;
  const controller = new AtlasController(env, folder.uri);
  context.subscriptions.push(controller);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.name = "ProjectAtlas";
  const renderStatus = () => {
    const s = controller.state;
    if (s.status === "running") {
      status.text = `$(sync~spin) Atlas ${s.currentPhase ?? ""}`;
      status.command = "atlas.cancel";
      status.tooltip = t("点击取消分析", "Click to cancel");
    } else if (s.status === "done") {
      status.text = s.staleFiles > 0 ? `$(map) Atlas · ${s.staleFiles}` : "$(map) Atlas";
      status.command = s.staleFiles > 0 ? "atlas.analyzeIncremental" : "atlas.openPanel";
      status.tooltip = s.staleFiles > 0 ? t(`${s.staleFiles} 个文件已变化，点击增量更新`, `${s.staleFiles} file(s) changed, click to update`) : t("打开项目地图", "Open the project map");
    } else {
      status.text = s.status === "error" ? "$(error) Atlas" : "$(map) Atlas: " + t("分析", "Analyze");
      status.command = "atlas.analyze";
      status.tooltip = s.error ? `${s.error.code} ${s.error.problem}` : t("分析工作区（本地运行，不需要 AI Key）", "Analyze workspace (local, no AI key needed)");
    }
    status.show();
  };
  context.subscriptions.push(controller.onDidChangeState(renderStatus));
  renderStatus();
  context.subscriptions.push(status);

  context.subscriptions.push(vscode.window.registerTreeDataProvider("atlas.tree", new AtlasTree(controller)));
  const codeLens = new AtlasCodeLens(controller);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider([{ language: "java" }, { language: "vue" }, { language: "javascript" }, { language: "typescript" }], codeLens),
  );

  const openPanel = (reveal?: { view: ViewId; nodeId?: string }) => AtlasPanel.show(context, controller, reveal);
  openPanelRef = openPanel;
  const register = (id: string, fn: (...args: never[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  // Runtime capture (v0.2): history loads now, the receiver starts on first use.
  const runtime = new RuntimeManager(env, controller);
  AtlasPanel.runtime = runtime;
  context.subscriptions.push(runtime);
  void runtime.restore();
  const runtimeCommand = (fn: () => Promise<void>) => async () => {
    try {
      await fn();
    } catch (error) {
      const uf = (error as { userFacing?: { code: string; problem: string; fix: string } }).userFacing;
      if (uf) void vscode.window.showErrorMessage(`${uf.code} ${uf.problem} ${uf.fix}`);
      else throw error;
    }
  };
  register("atlas.runtime.copyVmOptions", runtimeCommand(async () => void (await runtime.copyVmOptions())));
  register("atlas.runtime.launch", runtimeCommand(() => runtime.launch()));
  register("atlas.runtime.stop", runtimeCommand(() => runtime.stop()));
  register("atlas.runtime.clear", runtimeCommand(() => runtime.clear()));
  register("atlas.openTraceTab", () => openPanel({ view: "trace" }));

  register("atlas.analyze", async () => {
    openPanel();
    await controller.analyze();
  });
  register("atlas.analyzeIncremental", () => controller.analyze());
  register("atlas.cancel", () => controller.cancel());
  register("atlas.showLog", () => showLog());
  register("atlas.openPanel", (reveal?: { view: ViewId; nodeId?: string }) => openPanel(reveal));
  register("atlas.showFlowForSymbol", (entrypointId?: string) => openPanel(entrypointId ? { view: "flow", nodeId: entrypointId } : { view: "flow" }));

  register("atlas.revealInAtlas", async (uri?: vscode.Uri) => {
    const graph = controller.graph;
    const editor = vscode.window.activeTextEditor;
    const target = uri ?? editor?.document.uri;
    if (!graph || !target) {
      openPanel();
      return;
    }
    const cursor = editor && editor.document.uri.toString() === target.toString() ? editor.selection.active.line + 1 : 1;
    const eps = entrypointsForFile(graph, target.fsPath);
    const nearest = eps.filter((e) => (e.handler.line ?? 1) <= cursor).sort((a, b) => (b.handler.line ?? 0) - (a.handler.line ?? 0))[0] ?? eps[0];
    if (nearest) {
      openPanel({ view: "flow", nodeId: nearest.id });
      return;
    }
    const roots = new Map(graph.project.roots.map((r) => [r.id, r.path]));
    const module = graph.modules
      .filter((m) => {
        const service = graph.services.find((s) => s.id === m.serviceId);
        const root = service ? roots.get(service.rootId) : undefined;
        return root !== undefined && path.resolve(target.fsPath).toLowerCase().startsWith(path.resolve(root, m.path).toLowerCase());
      })
      .sort((a, b) => b.path.length - a.path.length)[0];
    openPanel(module ? { view: "modules", nodeId: module.id } : undefined);
  });

  register("atlas.configureProvider", async () => {
    const items: (vscode.QuickPickItem & { id: ProviderName })[] = [
      { id: "anthropic", label: "Anthropic", description: "claude-sonnet-5-5" },
      { id: "openai-compatible", label: t("OpenAI 兼容接口", "OpenAI-compatible"), description: "DeepSeek / Qwen / Moonshot / OpenAI" },
      { id: "ollama", label: t("Ollama（本地，代码不出本机）", "Ollama (local, code never leaves this machine)"), description: "qwen2.5-coder:7b" },
      { id: "none", label: t("不使用 AI", "No AI"), description: t("只保留确定性地图", "Deterministic map only") },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: t("选择 AI 提供方", "Choose an AI provider") });
    if (!pick) return;
    const config = vscode.workspace.getConfiguration("atlas");
    await config.update("llm.provider", pick.id, vscode.ConfigurationTarget.Global);
    if (pick.id === "openai-compatible") {
      const baseUrl = await vscode.window.showInputBox({ title: "Base URL", value: config.get<string>("llm.baseUrl") || "https://api.deepseek.com/v1", ignoreFocusOut: true });
      if (baseUrl) await config.update("llm.baseUrl", baseUrl, vscode.ConfigurationTarget.Global);
      const model = await vscode.window.showInputBox({ title: t("模型 ID", "Model id"), value: config.get<string>("llm.model") || "deepseek-chat", ignoreFocusOut: true });
      if (model) await config.update("llm.model", model, vscode.ConfigurationTarget.Global);
    }
    if (pick.id === "anthropic" || pick.id === "openai-compatible") {
      const key = await vscode.window.showInputBox({ title: t("API Key（保存在 SecretStorage，不会写入 settings.json）", "API key (stored in SecretStorage, never in settings.json)"), password: true, ignoreFocusOut: true });
      if (key) await storeApiKey(context.secrets, pick.id, key.trim());
    }
    if (pick.id !== "none") {
      const test = t("测试连接", "Test connection");
      if ((await vscode.window.showInformationMessage(t("模型已配置。", "AI model configured."), test)) === test) await vscode.commands.executeCommand("atlas.testConnection");
    }
  });

  register("atlas.testConnection", async () => {
    const config = await providerConfig(context.secrets, readSettings());
    if (!config) {
      void vscode.window.showInformationMessage(t("当前未启用 AI（atlas.llm.provider = none）。", "AI is disabled (atlas.llm.provider = none)."));
      return;
    }
    try {
      const provider = createProvider({ ...config, timeoutMs: 30_000 });
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t("正在测试模型连接…", "Testing AI connection…") }, () =>
        provider.complete({ system: 'Reply with the JSON object {"ok": true} and nothing else.', user: "ping", maxOutputTokens: 16 }),
      );
      void vscode.window.showInformationMessage(t(`连接成功：${provider.model}`, `Connected: ${provider.model}`));
    } catch (error) {
      const err = toUserFacing(error);
      const fix = err.fixCommand ? t("修复", "Fix") : undefined;
      const pick = await vscode.window.showErrorMessage(`${err.code} ${err.problem}: ${err.cause}. ${err.fix}`, ...(fix ? [fix] : []));
      if (pick && err.fixCommand) await vscode.commands.executeCommand(err.fixCommand);
    }
  });

  register("atlas.exportMarkdown", async () => {
    const graph = controller.graph;
    if (!graph) return void vscode.window.showWarningMessage(t("请先分析工作区。", "Analyze the workspace first."));
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(folder.uri, "ATLAS.md"), filters: { Markdown: ["md"] } });
    if (!target) return;
    await writeFile(target.fsPath, renderAtlasMarkdown(graph, { language: isChinese() ? "zh-cn" : "en" }));
    void vscode.window.showTextDocument(target, { preview: true });
  });

  register("atlas.exportHtml", async () => {
    const graph = controller.graph;
    if (!graph) return void vscode.window.showWarningMessage(t("请先分析工作区。", "Analyze the workspace first."));
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(folder.uri, `${graph.project.name}-atlas.html`), filters: { HTML: ["html"] } });
    if (!target) return;
    const dir = vscode.Uri.joinPath(context.extensionUri, "dist", "webview").fsPath;
    const [js, css] = await Promise.all([readFile(path.join(dir, "webview.js"), "utf8"), readFile(path.join(dir, "webview.css"), "utf8")]);
    await writeFile(target.fsPath, renderStaticHtml(graph, { js, css }, vscode.env.language));
    const open = t("在浏览器中打开", "Open in browser");
    if ((await vscode.window.showInformationMessage(t("已导出单文件 HTML，可离线打开。", "Exported a single offline HTML file."), open)) === open) await vscode.env.openExternal(target);
  });

  register("atlas.diagnose", async () => {
    const graph = controller.graph;
    const stats = graph && {
      analyzerVersion: graph.analyzerVersion,
      schemaVersion: graph.schemaVersion,
      analyzedAt: graph.project.analyzedAt,
      stacks: graph.project.stacks,
      roots: graph.project.roots.length,
      services: graph.services.map((s) => ({ kind: s.kind, stack: s.stack })),
      counts: { modules: graph.modules.length, entrypoints: graph.entrypoints.length, steps: graph.steps.length, edges: graph.edges.length, links: graph.serviceLinks.length, unresolved: graph.unresolvedCalls.length },
      unresolvedReasons: graph.unresolvedCalls.reduce<Record<string, number>>((acc, u) => ({ ...acc, [u.reason]: (acc[u.reason] ?? 0) + 1 }), {}),
      diagnostics: graph.diagnostics.map((d) => ({ code: d.code, severity: d.severity })),
      llmUsage: graph.llmUsage,
    };
    const settings = readSettings();
    const report = {
      generatedAt: new Date().toISOString(),
      extensionVersion: context.extension.packageJSON.version as string,
      vscode: vscode.version,
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      settings: { ...settings, model: settings.model ? "(set)" : "", baseUrl: settings.baseUrl ? "(set)" : "" },
      state: controller.state,
      graph: stats ?? null,
      log: recentLog().slice(-400),
    };
    const dir = path.join(controller.atlasDir, "diagnostics");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `atlas-diagnostics-${Date.now()}.json`);
    await writeFile(file, JSON.stringify(report, null, 2));
    log(`Diagnostics written to ${file}`);
    await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
    void vscode.window.showInformationMessage(t("诊断包不包含源码和密钥，可直接附在 issue 中。", "The diagnostics file contains no source code or secrets; attach it to an issue."));
  });

  register("atlas.clearCache", async () => {
    await controller.clearCache();
    void vscode.window.showInformationMessage(t("缓存已清除，下次分析会重新解析并重新请求 AI。", "Cache cleared; the next analysis re-parses everything and re-requests AI."));
  });

  await controller.restore();
  return {
    flowDetail: (entrypointId) => controller.view?.flowDetail(entrypointId),
    runtimeState: () => runtime.state,
  };
}

export function deactivate(): void {
  // Disposables registered on the context handle cleanup.
}
