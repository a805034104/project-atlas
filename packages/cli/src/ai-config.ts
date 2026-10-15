import { DEFAULT_BASE_URLS, DEFAULT_MODELS, type LlmProviderName, type ProviderConfig } from "@project-atlas/core";
import { PROVIDERS, type AiFlags } from "./args.js";
import { CliError, EXIT_USAGE, usageError } from "./errors.js";

/**
 * Provider selection: flags win over env, and nothing is configured by default
 * (spec: `atlas.llm.provider` defaults to `none`).
 *
 *   --provider | ATLAS_PROVIDER | (ANTHROPIC_API_KEY present → anthropic) | none
 *   --model    | ATLAS_MODEL    | provider default
 *   --base-url | ATLAS_BASE_URL | provider default
 *   key        = ATLAS_API_KEY  | ANTHROPIC_API_KEY (anthropic only)   — env only, never a flag
 */

export type AiSelection = { status: "not-configured" } | { status: "configured"; config: ProviderConfig & { model: string; baseUrl: string } };

function envProvider(env: CliEnv): LlmProviderName | "none" | undefined {
  const raw = env.ATLAS_PROVIDER?.trim();
  if (!raw) return undefined;
  if (raw === "none") return "none";
  if (!(PROVIDERS as readonly string[]).includes(raw)) throw usageError(`ATLAS_PROVIDER must be one of none, ${PROVIDERS.join(", ")} (got "${raw}").`);
  return raw as LlmProviderName;
}

type CliEnv = Readonly<Record<string, string | undefined>>;

function apiKeyFor(provider: LlmProviderName, env: CliEnv): string | undefined {
  return env.ATLAS_API_KEY || (provider === "anthropic" ? env.ANTHROPIC_API_KEY : undefined) || undefined;
}

/** Fill model/baseUrl defaults; usage error when the provider cannot work without them. */
function complete(provider: LlmProviderName, flags: AiFlags, env: CliEnv, requireKey: boolean): ProviderConfig & { model: string; baseUrl: string } {
  const model = flags.model ?? (env.ATLAS_MODEL || undefined) ?? DEFAULT_MODELS[provider];
  if (!model) throw usageError(`Provider ${provider} needs a model.`, "Pass --model <name> or set ATLAS_MODEL.");
  const baseUrl = flags.baseUrl ?? (env.ATLAS_BASE_URL || undefined) ?? DEFAULT_BASE_URLS[provider];
  if (!baseUrl) throw usageError(`Provider ${provider} needs a base URL.`, "Pass --base-url <url> or set ATLAS_BASE_URL.");
  const config: ProviderConfig & { model: string; baseUrl: string } = { provider, model, baseUrl };
  const apiKey = apiKeyFor(provider, env);
  if (apiKey) config.apiKey = apiKey;
  else if (requireKey && provider !== "ollama") {
    throw new CliError(
      {
        code: "ATLAS-E020",
        problem: `Provider ${provider} is selected but no API key is set.`,
        cause: provider === "anthropic" ? "Neither ATLAS_API_KEY nor ANTHROPIC_API_KEY is set." : "ATLAS_API_KEY is not set.",
        fix: "Export the key in the environment (keys are never accepted as flags), or pass --no-ai for the deterministic map only.",
      },
      EXIT_USAGE,
    );
  }
  return config;
}

export function selectProvider(flags: AiFlags, env: CliEnv): AiSelection {
  const fromEnv = envProvider(env);
  const provider = flags.provider ?? (fromEnv === "none" ? undefined : fromEnv) ?? (fromEnv === undefined && env.ANTHROPIC_API_KEY ? "anthropic" : undefined);
  if (!provider) return { status: "not-configured" };
  return { status: "configured", config: complete(provider, flags, env, true) };
}

/** For `estimate`: price the plan even without a configured provider or key (defaults to anthropic). */
export function estimateTarget(flags: AiFlags, env: CliEnv): { provider: LlmProviderName; model: string } {
  const fromEnv = envProvider(env);
  const provider = flags.provider ?? (fromEnv === "none" ? undefined : fromEnv) ?? "anthropic";
  const { model } = complete(provider, { ...flags, baseUrl: flags.baseUrl ?? "unused" }, env, false);
  return { provider, model };
}

/** Origin only: strips any `user:pass@` and paths before a base URL is printed. */
export function displayUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "(invalid URL)";
  }
}
