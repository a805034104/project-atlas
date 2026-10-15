import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { HostToWebview, SourceRef, ViewId, WebviewCommand, WebviewToHost } from "@project-atlas/core";
import type { AtlasController } from "./controller.js";
import { log } from "./log.js";
import { addEdgeRemoval } from "./overrides-writer.js";
import { t } from "./settings.js";

/**
 * Singleton Atlas panel.
 *
 *   webview ── ready ─▶ init(locale, state, showTopology)
 *           ── requestView / requestFlow ─▶ GraphView slices (never the whole graph)
 *           ── openSource ─▶ editor beside, preserveFocus, line highlight 2 s
 *           ── markEdgeWrong ─▶ .atlas/overrides.yaml edges.remove ─▶ re-analyze prompt
 *           ── runCommand ─▶ allow-listed atlas.* commands only
 */

const ALLOWED_COMMANDS: ReadonlySet<WebviewCommand> = new Set([
  "atlas.analyze",
  "atlas.analyzeIncremental",
  "atlas.cancel",
  "atlas.configureProvider",
  "atlas.exportHtml",
  "atlas.exportMarkdown",
  "atlas.diagnose",
]);

const highlight = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
  isWholeLine: true,
});

export class AtlasPanel implements vscode.Disposable {
  private static current: AtlasPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private pending: HostToWebview[] = [];

  static show(context: vscode.ExtensionContext, controller: AtlasController, reveal?: { view: ViewId; nodeId?: string }): AtlasPanel {
    if (AtlasPanel.current) {
      AtlasPanel.current.panel.reveal(undefined, false);
    } else {
      const panel = vscode.window.createWebviewPanel("atlas.panel", "Atlas", vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist", "webview")],
      });
      panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "atlas.svg");
      AtlasPanel.current = new AtlasPanel(panel, context, controller);
    }
    if (reveal) AtlasPanel.current.post({ type: "reveal", view: reveal.view, ...(reveal.nodeId ? { nodeId: reveal.nodeId } : {}) });
    return AtlasPanel.current;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly controller: AtlasController,
  ) {
    panel.webview.html = this.html();
    panel.webview.onDidReceiveMessage((m: WebviewToHost) => void this.handle(m), undefined, this.disposables);
    panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    controller.onDidChangeState((state) => this.post({ type: "analysisState", state }), undefined, this.disposables);
    controller.onDidChangeGraph(() => this.post({ type: "init", locale: vscode.env.language, state: controller.state, showTopology: (controller.graph?.services.length ?? 0) > 1 }), undefined, this.disposables);
  }

  private html(): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString("base64");
    const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview", name));
    const csp = [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      "worker-src blob:",
    ].join("; ");
    return `<!doctype html>
<html lang="${vscode.env.language}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${asset("webview.css").toString()}">
<title>Atlas</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${asset("webview.js").toString()}"></script>
</body>
</html>`;
  }

  post(message: HostToWebview): void {
    if (!this.ready && message.type !== "init") {
      this.pending.push(message);
      return;
    }
    void this.panel.webview.postMessage(message);
  }

  private async handle(message: WebviewToHost): Promise<void> {
    const view = this.controller.view;
    switch (message.type) {
      case "ready": {
        this.ready = true;
        void this.panel.webview.postMessage({ type: "init", locale: vscode.env.language, state: this.controller.state, showTopology: (this.controller.graph?.services.length ?? 0) > 1 } satisfies HostToWebview);
        for (const m of this.pending.splice(0)) void this.panel.webview.postMessage(m);
        return;
      }
      case "requestView":
        if (view) this.post({ type: "viewData", payload: view.view(message.view) });
        return;
      case "requestFlow": {
        const detail = view?.flowDetail(message.entrypointId, message.depth);
        if (detail) this.post({ type: "flowDetail", data: detail });
        return;
      }
      case "openSource":
        await this.openSource(message.ref);
        return;
      case "runCommand":
        if (ALLOWED_COMMANDS.has(message.command)) await vscode.commands.executeCommand(message.command);
        return;
      case "copyText":
        await vscode.env.clipboard.writeText(message.text);
        void vscode.window.setStatusBarMessage(t("已复制", "Copied"), 1500);
        return;
      case "markEdgeWrong":
        await this.markEdgeWrong(message.edgeId);
        return;
    }
  }

  private async openSource(ref: SourceRef): Promise<void> {
    const root = this.controller.graph?.project.roots.find((r) => r.id === ref.rootId);
    if (!root) return;
    const target = path.resolve(root.path, ref.file);
    const relative = path.relative(root.path, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      log(`Refused to open a path outside the workspace root: ${ref.file}`);
      return;
    }
    const uri = vscode.Uri.file(target);
    try {
      const editor = await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true, preview: true });
      if (ref.line) {
        const line = Math.max(0, ref.line - 1);
        const range = new vscode.Range(line, 0, line, 0);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        editor.setDecorations(highlight, [range]);
        setTimeout(() => editor.setDecorations(highlight, []), 2000);
      }
    } catch (error) {
      void vscode.window.showWarningMessage(t(`无法打开 ${ref.file}`, `Cannot open ${ref.file}`) + `: ${(error as Error).message}`);
    }
  }

  private async markEdgeWrong(edgeId: string): Promise<void> {
    const graph = this.controller.graph;
    const edge = graph?.edges.find((e) => e.id === edgeId);
    if (!graph || !edge) return;
    const steps = new Map(graph.steps.map((s) => [s.id, s]));
    const from = steps.get(edge.from)?.symbol.fqn ?? edge.from;
    const to = steps.get(edge.to)?.symbol.fqn ?? edge.to;
    const file = path.join(this.controller.atlasDir, "overrides.yaml");
    let existing: string | undefined;
    try {
      existing = await readFile(file, "utf8");
    } catch {
      existing = undefined;
    }
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, addEdgeRemoval(existing, from, to, `marked wrong ${new Date().toISOString().slice(0, 10)}`));
    log(`Edge marked wrong: ${from} → ${to}`);
    const reanalyze = t("重新分析", "Re-analyze");
    const pick = await vscode.window.showInformationMessage(t("已记录到 .atlas/overrides.yaml（可提交到 git 与团队共享）", "Saved to .atlas/overrides.yaml (commit it to share with your team)"), reanalyze);
    if (pick === reanalyze) await vscode.commands.executeCommand("atlas.analyze");
  }

  dispose(): void {
    AtlasPanel.current = undefined;
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}
