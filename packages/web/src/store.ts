import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { atlasHome, type HostSettings, type ProviderConfig, type ProviderName } from "@project-atlas/core";

/**
 * Files under the ProjectAtlas home (default ~/.project-atlas, PROJECT_ATLAS_HOME overrides):
 *   web-settings.json   AI provider / model / base URL, analysis + runtime options (no secrets)
 *   credentials.json    API keys per provider (mode 0600 on POSIX; on Windows the profile ACL applies)
 *   projects.json       imported projects (see projects.ts)
 * All writes are atomic (tmp + rename).
 */

export async function writeJsonAtomic(file: string, value: unknown, mode?: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // Unpredictable name, created exclusively: nobody can plant or pre-open it.
  const tmp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { flag: "wx", ...(mode !== undefined ? { mode } : {}) });
  await rename(tmp, file);
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export interface WebSettings {
  locale: string;
  provider: ProviderName;
  model: string;
  baseUrl: string;
  maxInputTokens: number;
  concurrency: number;
  outputLanguage: string;
  exclude: string[];
  maxFileSizeKB: number;
  history: boolean;
  runtime: { enabled: boolean; port: number; javaagentPath: string };
}

export function defaultSettings(systemLocale: string): WebSettings {
  return {
    locale: systemLocale,
    provider: "none",
    model: "",
    baseUrl: "",
    maxInputTokens: 2_000_000,
    concurrency: 4,
    outputLanguage: "auto",
    exclude: [],
    maxFileSizeKB: 2048,
    history: true,
    runtime: { enabled: true, port: 43180, javaagentPath: "" },
  };
}

const PROVIDERS: readonly ProviderName[] = ["none", "anthropic", "openai-compatible", "ollama"];

/** What the browser may send (any subset, runtime partially). */
export type SettingsInput = Partial<Omit<WebSettings, "runtime">> & { runtime?: Partial<WebSettings["runtime"]>; apiKey?: string };
type SettingsPatch = Partial<Omit<WebSettings, "runtime">> & { runtime: Partial<WebSettings["runtime"]> };

export class SettingsStore {
  private value: WebSettings;
  /** Each key remembers the endpoint it was entered for; it is only ever sent there. */
  private keys: Partial<Record<ProviderName, StoredKey>> = {};

  private constructor(
    readonly home: string,
    value: WebSettings,
  ) {
    this.value = value;
  }

  static async open(homeDir: string | undefined, systemLocale: string): Promise<SettingsStore> {
    const home = atlasHome(homeDir);
    const defaults = defaultSettings(systemLocale);
    const stored = await readJson<Partial<WebSettings>>(path.join(home, "web-settings.json"), {});
    const store = new SettingsStore(home, { ...defaults, ...stored, runtime: { ...defaults.runtime, ...(stored.runtime ?? {}) } });
    const raw = await readJson<Record<string, unknown>>(path.join(home, "credentials.json"), {});
    for (const p of PROVIDERS) {
      const v = raw[p];
      // 0.3.0-dev stored bare strings: bind them to the provider's default endpoint only.
      if (typeof v === "string") store.keys[p] = { key: v, endpoint: endpointOf("") };
      else if (v && typeof v === "object" && typeof (v as StoredKey).key === "string" && typeof (v as StoredKey).endpoint === "string") store.keys[p] = v as StoredKey;
    }
    return store;
  }

  get(): WebSettings {
    return this.value;
  }

  /** Settings for the UI: never the keys, only whether one is stored. */
  publicView(): WebSettings & { keyStored: Record<string, boolean> } {
    return { ...this.value, keyStored: Object.fromEntries(PROVIDERS.map((p) => [p, this.keyFor(p) !== undefined])) };
  }

  async update(patch: SettingsInput): Promise<void> {
    const { apiKey, ...rest } = patch;
    const clean = sanitize(rest);
    const next: WebSettings = { ...this.value, ...clean, runtime: { ...this.value.runtime, ...clean.runtime } };
    this.value = next;
    await writeJsonAtomic(path.join(this.home, "web-settings.json"), next);
    if (apiKey !== undefined && next.provider !== "none" && next.provider !== "ollama") {
      if (apiKey) this.keys[next.provider] = { key: apiKey.trim(), endpoint: endpointOf(next.baseUrl) };
      else delete this.keys[next.provider];
      await writeJsonAtomic(path.join(this.home, "credentials.json"), this.keys, 0o600);
    }
  }

  /** The stored key, only while the base URL still points where it was entered. */
  private keyFor(provider: ProviderName): string | undefined {
    const k = this.keys[provider];
    return k && k.endpoint === endpointOf(this.value.baseUrl) ? k.key : undefined;
  }

  hostSettings(): HostSettings {
    const v = this.value;
    const outputLanguage = v.outputLanguage === "auto" ? (v.locale.toLowerCase().startsWith("zh") ? "zh-cn" : "en") : v.outputLanguage;
    return { provider: v.provider, model: v.model, baseUrl: v.baseUrl, maxInputTokens: v.maxInputTokens, concurrency: v.concurrency, outputLanguage, exclude: v.exclude, maxFileSizeKB: v.maxFileSizeKB, history: v.history, runtime: v.runtime };
  }

  providerConfig(): ProviderConfig | undefined {
    const v = this.value;
    if (v.provider === "none") return undefined;
    const apiKey = v.provider === "ollama" ? undefined : (process.env["ATLAS_API_KEY"] ?? (v.provider === "anthropic" ? process.env["ANTHROPIC_API_KEY"] : undefined) ?? this.keyFor(v.provider));
    return { provider: v.provider, ...(v.model ? { model: v.model } : {}), ...(v.baseUrl ? { baseUrl: v.baseUrl } : {}), ...(apiKey ? { apiKey } : {}) };
  }
}

interface StoredKey {
  key: string;
  /** Origin of the base URL the key was entered with ("default" = the provider's own). */
  endpoint: string;
}

function endpointOf(baseUrl: string): string {
  if (!baseUrl) return "default";
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl;
  }
}

/** Keep only known keys with the right types (the body comes from the browser). */
function sanitize(input: SettingsInput): SettingsPatch {
  const out: SettingsPatch = { runtime: {} };
  if (typeof input.locale === "string" && /^[a-z]{2}(-[a-z]{2})?$/i.test(input.locale)) out.locale = input.locale;
  if (typeof input.provider === "string" && PROVIDERS.includes(input.provider)) out.provider = input.provider;
  if (typeof input.model === "string") out.model = input.model.slice(0, 200);
  if (typeof input.baseUrl === "string" && (input.baseUrl === "" || /^https?:\/\//.test(input.baseUrl))) out.baseUrl = input.baseUrl.slice(0, 500);
  if (typeof input.outputLanguage === "string" && ["auto", "zh-cn", "en"].includes(input.outputLanguage)) out.outputLanguage = input.outputLanguage;
  if (typeof input.history === "boolean") out.history = input.history;
  if (Number.isInteger(input.maxInputTokens) && (input.maxInputTokens as number) > 0) out.maxInputTokens = input.maxInputTokens as number;
  if (Number.isInteger(input.concurrency) && (input.concurrency as number) >= 1 && (input.concurrency as number) <= 16) out.concurrency = input.concurrency as number;
  if (Number.isInteger(input.maxFileSizeKB) && (input.maxFileSizeKB as number) > 0) out.maxFileSizeKB = input.maxFileSizeKB as number;
  if (Array.isArray(input.exclude)) out.exclude = input.exclude.filter((e): e is string => typeof e === "string").slice(0, 200);
  const r = input.runtime;
  if (r && typeof r === "object") {
    if (typeof r.enabled === "boolean") out.runtime.enabled = r.enabled;
    if (typeof r.port === "number" && Number.isInteger(r.port) && r.port >= 1024 && r.port <= 65535) out.runtime.port = r.port;
    if (typeof r.javaagentPath === "string") out.runtime.javaagentPath = r.javaagentPath.slice(0, 1000);
  }
  return out;
}
