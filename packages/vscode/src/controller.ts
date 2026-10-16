import * as vscode from "vscode";
import path from "node:path";
import { AnalysisController, toUserFacing as coreToUserFacing, type HostEnv, type UserFacingError } from "@project-atlas/core";
import { t } from "./settings.js";

/**
 * The shared AnalysisController (core/host) plus what only VS Code provides: the workspace
 * folders as roots and a file watcher that marks the map stale.
 */
export class AtlasController extends AnalysisController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    env: HostEnv,
    readonly workspaceRoot: vscode.Uri,
  ) {
    super({
      env,
      atlasDir: path.join(workspaceRoot.fsPath, ".atlas"),
      roots: () => (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file").map((f) => ({ path: f.uri.fsPath })),
    });
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceRoot, "**/*.{java,vue,js,ts,xml,yml,yaml,properties,json}"));
    const mark = (uri: vscode.Uri) => {
      if (/[\\/](\.atlas|node_modules|target|dist|\.git)[\\/]/.test(uri.fsPath)) return;
      this.markStale(uri.fsPath);
    };
    watcher.onDidChange(mark, undefined, this.disposables);
    watcher.onDidCreate(mark, undefined, this.disposables);
    watcher.onDidDelete(mark, undefined, this.disposables);
    this.disposables.push(watcher);
  }

  override dispose(): void {
    super.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

export function toUserFacing(error: unknown): UserFacingError {
  return coreToUserFacing(error, t);
}
