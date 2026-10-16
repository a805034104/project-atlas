import * as vscode from "vscode";
import { RuntimeHost, type HostEnv, type RuntimeState } from "@project-atlas/core";
import type { AtlasController } from "./controller.js";
import { t } from "./settings.js";

/**
 * The shared RuntimeHost (core/host) plus the VS Code status bar item (separate from the
 * analysis item, hidden until first use) and workspace-trust tracking.
 */
export class RuntimeManager extends RuntimeHost implements vscode.Disposable {
  private readonly status: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(env: HostEnv, controller: AtlasController) {
    super({ env, controller, workspaceDir: controller.workspaceRoot.fsPath });
    this.status = vscode.window.createStatusBarItem("atlas.runtime", vscode.StatusBarAlignment.Left, 99);
    this.status.name = t("Atlas 运行时追踪", "Atlas runtime tracing");
    this.status.command = "atlas.openTraceTab";
    const sub = this.onDidChangeState((s) => this.renderStatus(s));
    this.disposables.push(this.status, { dispose: () => sub.dispose() }, vscode.workspace.onDidGrantWorkspaceTrust(() => this.trustChanged()));
  }

  private renderStatus(s: RuntimeState): void {
    if (s.status === "off" && s.spans === 0) {
      this.status.hide();
      return;
    }
    const pct = s.agent?.total ? ` ${Math.floor((s.agent.received / s.agent.total) * 100)}%` : "";
    this.status.text =
      s.status === "downloading"
        ? `$(cloud-download) Agent${pct}`
        : s.status === "waiting"
          ? `$(debug-start) ${t("等待请求", "Waiting for requests")}`
          : s.status === "receiving"
            ? `$(pulse) ${s.spans} spans${s.rejected ? ` · ${s.rejected} ${t("已拒绝", "rejected")}` : ""}`
            : s.status === "error"
              ? `$(error) ${t("追踪接收器", "Trace receiver")}`
              : s.status === "starting"
                ? `$(loading~spin) ${t("追踪", "Tracing")}`
                : `$(debug-disconnect) ${s.spans} spans`;
    this.status.tooltip = [s.port ? `127.0.0.1:${s.port}` : t("接收器未运行", "Receiver not running"), s.since ? `${t("开始于", "since")} ${new Date(s.since).toLocaleTimeString()}` : "", s.error ? `${s.error.code} ${s.error.problem}` : ""].filter(Boolean).join("\n");
    this.status.backgroundColor = s.status === "error" ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined;
    this.status.show();
  }

  override dispose(): void {
    super.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
