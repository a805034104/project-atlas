import * as vscode from "vscode";
import type { ProviderConfig } from "@project-atlas/core";

/** Settings + SecretStorage access. API keys never touch settings.json or logs. */

export type ProviderName = "none" | "anthropic" | "openai-compatible" | "ollama";

export interface AtlasSettings {
  provider: ProviderName;
  model: string;
  baseUrl: string;
  maxInputTokens: number;
  concurrency: number;
  outputLanguage: string;
  exclude: string[];
  maxFileSizeKB: number;
  history: boolean;
  codeLens: boolean;
}

export function readSettings(): AtlasSettings {
  const c = vscode.workspace.getConfiguration("atlas");
  const language = c.get<string>("llm.outputLanguage", "auto");
  return {
    provider: c.get<ProviderName>("llm.provider", "none"),
    model: c.get<string>("llm.model", ""),
    baseUrl: c.get<string>("llm.baseUrl", ""),
    maxInputTokens: c.get<number>("llm.maxInputTokens", 2_000_000),
    concurrency: c.get<number>("llm.concurrency", 4),
    outputLanguage: language === "auto" ? (vscode.env.language.toLowerCase().startsWith("zh") ? "zh-cn" : "en") : language,
    exclude: c.get<string[]>("analysis.exclude", []),
    maxFileSizeKB: c.get<number>("analysis.maxFileSizeKB", 2048),
    history: c.get<boolean>("analysis.history", true),
    codeLens: c.get<boolean>("codeLens.enabled", true),
  };
}

const secretKey = (provider: ProviderName) => `atlas.llm.apiKey.${provider}`;

export async function providerConfig(secrets: vscode.SecretStorage, settings: AtlasSettings): Promise<ProviderConfig | undefined> {
  if (settings.provider === "none") return undefined;
  const apiKey = settings.provider === "ollama" ? undefined : await secrets.get(secretKey(settings.provider));
  return {
    provider: settings.provider,
    ...(settings.model ? { model: settings.model } : {}),
    ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
}

export async function storeApiKey(secrets: vscode.SecretStorage, provider: ProviderName, key: string): Promise<void> {
  await secrets.store(secretKey(provider), key);
}

export function isChinese(): boolean {
  return vscode.env.language.toLowerCase().startsWith("zh");
}

/** Bilingual runtime strings (package.nls covers static contributions). */
export function t(zh: string, en: string): string {
  return isChinese() ? zh : en;
}
