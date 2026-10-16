import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { HostSession, type HostEnv, type HostToWebview, type ViewId, type WebviewToHost } from "@project-atlas/core";
import type { AtlasController } from "./controller.js";
import type { RuntimeManager } from "./runtime.js";

/**
 * Singleton Atlas panel: the webview plus a shared HostSession (core/host/dispatch.ts) that
 * answers its messages. Only the editor opening and command execution are VS Code specific.
 */

const highlight = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
  isWholeLine: true,
});

export class AtlasPanel implements vscode.Disposable {
  private static current: AtlasPanel | undefined;
  /** Runtime capture (set on activation); absent in tests that only exercise the map. */
  static runtime: RuntimeManager | undefined;
  /** Host environment (set on activation). */
  static env: HostEnv | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly session: HostSession;

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
    controller: AtlasController,
  ) {
    const env = AtlasPanel.env;
    if (!env) throw new Error("AtlasPanel.env is not set");
    this.session = new HostSession({
      env,
      controller,
      ...(AtlasPanel.runtime ? { runtime: AtlasPanel.runtime } : {}),
      bufferUntilReady: true,
      post: (m) => void this.panel.webview.postMessage(m),
      runCommand: async (command) => void (await vscode.commands.executeCommand(command)),
      openSource: (file, line) => this.openEditor(file, line),
    });
    panel.webview.html = this.html();
    panel.webview.onDidReceiveMessage(
      (m: WebviewToHost) =>
        void this.session.handle(m).then((replies) => {
          for (const r of replies) void this.panel.webview.postMessage(r);
        }),
      undefined,
      this.disposables,
    );
    panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
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
    this.session.send(message);
  }

  private async openEditor(file: string, line?: number): Promise<void> {
    try {
      const editor = await vscode.window.showTextDocument(vscode.Uri.file(file), { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true, preview: true });
      if (line) {
        const at = Math.max(0, line - 1);
        const range = new vscode.Range(at, 0, at, 0);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        editor.setDecorations(highlight, [range]);
        setTimeout(() => editor.setDecorations(highlight, []), 2000);
      }
    } catch (error) {
      void vscode.window.showWarningMessage(`${file}: ${(error as Error).message}`);
    }
  }

  dispose(): void {
    AtlasPanel.current = undefined;
    this.session.dispose();
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}
