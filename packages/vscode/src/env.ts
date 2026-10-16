import * as vscode from "vscode";
import type { HostEnv, HostSettings, ViewId } from "@project-atlas/core";
import { log } from "./log.js";
import { providerConfig, readSettings } from "./settings.js";

/**
 * HostEnv for the VS Code extension: settings + SecretStorage, workspace trust, QuickPick /
 * modal dialogs, notification progress, clipboard, workspaceState.
 */
export function vscodeEnv(context: vscode.ExtensionContext, reveal: (view: ViewId, nodeId?: string) => void): HostEnv {
  const settings = (): HostSettings => {
    const s = readSettings();
    const c = vscode.workspace.getConfiguration("atlas");
    return {
      ...s,
      runtime: { enabled: c.get<boolean>("runtime.enabled", true), port: c.get<number>("runtime.port", 43180), javaagentPath: c.get<string>("runtime.javaagentPath", "") },
    };
  };
  return {
    locale: () => vscode.env.language,
    settings,
    providerConfig: () => providerConfig(context.secrets, readSettings()),
    trusted: () => vscode.workspace.isTrusted,
    assets: {
      wasmDir: vscode.Uri.joinPath(context.extensionUri, "dist", "wasm").fsPath,
      workerPath: vscode.Uri.joinPath(context.extensionUri, "dist", "worker.js").fsPath,
    },
    log,
    progress: (title, fn) =>
      Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (progress, token) =>
        fn({
          report: (message, increment) => progress.report({ message, ...(increment !== undefined ? { increment } : {}) }),
          onCancel: (cb) => token.onCancellationRequested(cb),
        }),
      )),
    choose: async ({ title, items, many }) => {
      const quick = items.map((i) => ({ label: i.label, ...(i.description ? { description: i.description } : {}), picked: i.picked ?? false, id: i.id }));
      if (many) {
        const picked = await vscode.window.showQuickPick(quick, { canPickMany: true, title, ignoreFocusOut: true });
        return picked?.map((p) => p.id);
      }
      const picked = await vscode.window.showQuickPick(quick, { title });
      return picked ? [picked.id] : undefined;
    },
    confirm: async ({ message, detail, action }) => (await vscode.window.showWarningMessage(message, { modal: true, ...(detail ? { detail } : {}) }, action)) === action,
    input: ({ prompt, value }) => Promise.resolve(vscode.window.showInputBox({ prompt, ...(value !== undefined ? { value } : {}) })),
    notify: (level, message, actions = []) => {
      const show = level === "error" ? vscode.window.showErrorMessage : level === "warning" ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
      return Promise.resolve(show(message, ...actions));
    },
    clipboard: async (text) => {
      await vscode.env.clipboard.writeText(text);
      void vscode.window.setStatusBarMessage(vscode.env.language.toLowerCase().startsWith("zh") ? "已复制" : "Copied", 1500);
    },
    memento: {
      get: (key, fallback) => context.workspaceState.get(key, fallback),
      update: (key, value) => Promise.resolve(context.workspaceState.update(key, value)),
    },
    reveal,
    runInTerminal: ({ name, command, cwd, env }) => {
      const terminal = vscode.window.createTerminal({ name, ...(cwd ? { cwd } : {}), env });
      terminal.show();
      terminal.sendText(command);
    },
  };
}
