import type { ProviderConfig } from "../llm/providers.js";
import type { ViewId } from "../protocol.js";

/**
 * What a host (the VS Code extension, the local web server) provides to the shared host logic.
 * Everything that needs a UI or platform API goes through here; the logic in this folder never
 * imports `vscode` or `node:http`.
 */

export type ProviderName = "none" | "anthropic" | "openai-compatible" | "ollama";

export interface HostSettings {
  provider: ProviderName;
  model: string;
  baseUrl: string;
  maxInputTokens: number;
  concurrency: number;
  /** "zh-cn" | "en" (already resolved from "auto"). */
  outputLanguage: string;
  exclude: string[];
  maxFileSizeKB: number;
  history: boolean;
  runtime: { enabled: boolean; port: number; javaagentPath: string };
}

export interface ChooseItem {
  id: string;
  label: string;
  description?: string;
  picked?: boolean;
}

export interface Progress {
  report(message: string, increment?: number): void;
  /** Called when the user cancels from the host's progress UI. */
  onCancel(cb: () => void): void;
}

export interface HostEnv {
  /** UI language, e.g. "zh-cn", "en". */
  locale(): string;
  settings(): HostSettings;
  /** Provider settings plus the stored key (never logged). undefined when AI is off. */
  providerConfig(): Promise<ProviderConfig | undefined>;
  /** May repository content drive actions (git history, AI, clones, launching)? */
  trusted(): boolean;
  /** Parse worker + tree-sitter wasm; pass both or analysis silently runs single-threaded. */
  assets: { wasmDir?: string; workerPath?: string };
  log(line: string): void;
  progress<T>(title: string, fn: (progress: Progress) => Promise<T>): Promise<T>;
  /** Pick one or several items; undefined when dismissed. */
  choose(request: { title: string; items: ChooseItem[]; many: boolean }): Promise<string[] | undefined>;
  /** Modal confirmation; true only when the user picked `action`. */
  confirm(request: { message: string; detail?: string; action: string }): Promise<boolean>;
  input(request: { prompt: string; value?: string }): Promise<string | undefined>;
  /** Non-blocking notice with optional actions; resolves with the picked action. */
  notify(level: "info" | "warning" | "error", message: string, actions?: string[]): Promise<string | undefined>;
  clipboard(text: string): Promise<void>;
  /** Show the host's log (the extension's output channel); absent where there is none to show. */
  showLog?(): void;
  /** Small per-project key/value store (approved clone URLs…). */
  memento: { get<T>(key: string, fallback: T): T; update(key: string, value: unknown): Promise<void> };
  /** Bring a view of the map to the front. */
  reveal(view: ViewId, nodeId?: string): void;
  /** Run a command in a terminal the user can see (VS Code only). */
  runInTerminal?(request: { name: string; command: string; cwd?: string; env: Record<string, string> }): void;
}

/** Bilingual string for the host's locale. */
export function translator(env: Pick<HostEnv, "locale">): (zh: string, en: string) => string {
  return (zh, en) => (env.locale().toLowerCase().startsWith("zh") ? zh : en);
}
