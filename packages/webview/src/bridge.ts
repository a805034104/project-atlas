/**
 * Typed host ⇄ webview messaging over the contract in @project-atlas/core.
 *
 * Host → webview messages arrive as `message` events on `window` (VS Code's
 * webview transport; the dev mock host uses `window.postMessage` too).
 * Webview → host messages go through the VS Code API wrapper.
 */

import type { HostToWebview, WebviewCommand, WebviewToHost } from "@project-atlas/core";
import { getVsCodeApi, type VsCodeApi } from "./vscode.js";

export type HostListener = (message: HostToWebview) => void;

export interface Bridge {
  send(message: WebviewToHost): void;
  /** Subscribes to host messages; returns an unsubscribe function. */
  onMessage(listener: HostListener): () => void;
}

const HOST_TYPES: ReadonlySet<string> = new Set<HostToWebview["type"]>([
  "init",
  "analysisState",
  "viewData",
  "flowDetail",
  "reveal",
  "error",
]);

/** Shallow structural check: drops foreign messages (e.g. devtools, extensions). */
export function isHostMessage(data: unknown): data is HostToWebview {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as { type?: unknown }).type === "string" &&
    HOST_TYPES.has((data as { type: string }).type)
  );
}

const COMMANDS: ReadonlySet<string> = new Set<WebviewCommand>([
  "atlas.analyze",
  "atlas.analyzeIncremental",
  "atlas.cancel",
  "atlas.configureProvider",
  "atlas.exportHtml",
  "atlas.exportMarkdown",
  "atlas.diagnose",
]);

/** `UserFacingError.fixCommand` is a free string; only allow-listed commands are runnable. */
export function asWebviewCommand(command: string | undefined): WebviewCommand | undefined {
  return command !== undefined && COMMANDS.has(command) ? (command as WebviewCommand) : undefined;
}

export function createBridge(api: VsCodeApi = getVsCodeApi(), target: Window = window): Bridge {
  return {
    send(message) {
      api.postMessage(message);
    },
    onMessage(listener) {
      const handler = (event: MessageEvent<unknown>): void => {
        if (isHostMessage(event.data)) listener(event.data);
      };
      target.addEventListener("message", handler);
      return () => target.removeEventListener("message", handler);
    },
  };
}
