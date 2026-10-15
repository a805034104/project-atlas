import * as vscode from "vscode";

/** "ProjectAtlas" output channel. Never log API keys, prompts or source contents. */

let channel: vscode.LogOutputChannel | undefined;
const recent: string[] = [];

export function initLog(): vscode.LogOutputChannel {
  channel ??= vscode.window.createOutputChannel("ProjectAtlas", { log: true });
  return channel;
}

export function log(message: string): void {
  recent.push(`${new Date().toISOString()} ${message}`);
  if (recent.length > 2000) recent.splice(0, recent.length - 2000);
  channel?.info(message);
}

export function recentLog(): readonly string[] {
  return recent;
}

export function showLog(): void {
  channel?.show(true);
}
