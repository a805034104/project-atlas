import { parseArgs } from "node:util";
import type { LlmProviderName } from "@project-atlas/core";
import { usageError } from "./errors.js";

/**
 * argv → typed command, with node:util parseArgs only (no dependencies).
 *
 *   argv ─▶ first positional = command ─▶ parseArgs(strict) ─▶ per-command
 *           option allow-list ─▶ value validation ─▶ Command | CliError(E060)
 */

export const PROVIDERS: readonly LlmProviderName[] = ["anthropic", "openai-compatible", "ollama"];
export const LANGUAGES = ["zh-cn", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

export interface AiFlags {
  provider?: LlmProviderName;
  model?: string;
  baseUrl?: string;
  maxInputTokens?: number;
}

export interface AnalyzeCommand extends AiFlags {
  command: "analyze";
  paths: string[];
  out?: string;
  json: boolean;
  noAi: boolean;
  noHistory: boolean;
  markdown?: string;
  lang?: Language;
  yes: boolean;
}

export interface EstimateCommand extends AiFlags {
  command: "estimate";
  paths: string[];
  out?: string;
  json: boolean;
  noHistory: boolean;
}

export interface ShowCommand {
  command: "show";
  entrypoint: string;
  dir?: string;
  depth?: number;
  json: boolean;
}

export type Command = AnalyzeCommand | EstimateCommand | ShowCommand | { command: "help"; topic?: string } | { command: "version" };

const OPTIONS = {
  out: { type: "string" },
  json: { type: "boolean" },
  "no-ai": { type: "boolean" },
  "no-history": { type: "boolean" },
  markdown: { type: "string" },
  provider: { type: "string" },
  model: { type: "string" },
  "base-url": { type: "string" },
  lang: { type: "string" },
  yes: { type: "boolean", short: "y" },
  "max-input-tokens": { type: "string" },
  dir: { type: "string" },
  depth: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

type OptionName = keyof typeof OPTIONS;

const ALLOWED: Record<"analyze" | "estimate" | "show", readonly OptionName[]> = {
  analyze: ["out", "json", "no-ai", "no-history", "markdown", "provider", "model", "base-url", "lang", "yes", "max-input-tokens"],
  estimate: ["out", "json", "no-history", "provider", "model", "base-url", "max-input-tokens"],
  show: ["dir", "depth", "json"],
};

export const USAGE = `Usage:
  project-atlas analyze [paths...] [--out <dir>] [--json] [--no-ai] [--no-history]
                        [--markdown <file>] [--provider anthropic|openai-compatible|ollama]
                        [--model <m>] [--base-url <u>] [--lang zh-cn|en] [--yes]
                        [--max-input-tokens <n>]
  project-atlas show <entrypoint label or id> [--dir .atlas] [--depth <n>] [--json]
  project-atlas estimate [paths...] [--provider …] [--model …] [--base-url …] [--json]

Analyze runs the deterministic map with no network access. AI enrichment runs
only when a provider is configured (--provider or ATLAS_PROVIDER, keys from
ATLAS_API_KEY / ANTHROPIC_API_KEY, ATLAS_BASE_URL, ATLAS_MODEL) and --no-ai is
absent; the cost plan is printed and confirmed (--yes or y/N) before anything
is sent.

Examples:
  project-atlas analyze --no-ai --markdown ATLAS.md
  project-atlas show "GET /system/user/list"
  ATLAS_PROVIDER=ollama project-atlas estimate`;

function positiveInt(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) throw usageError(`--${name} must be a positive integer (got "${raw}").`);
  return Number(raw);
}

function provider(raw: string | undefined): LlmProviderName | undefined {
  if (raw === undefined) return undefined;
  if (!(PROVIDERS as readonly string[]).includes(raw)) throw usageError(`--provider must be one of ${PROVIDERS.join(", ")} (got "${raw}").`);
  return raw as LlmProviderName;
}

function language(raw: string | undefined): Language | undefined {
  if (raw === undefined) return undefined;
  const lower = raw.toLowerCase();
  if (!(LANGUAGES as readonly string[]).includes(lower)) throw usageError(`--lang must be one of ${LANGUAGES.join(", ")} (got "${raw}").`);
  return lower as Language;
}

export function parseCliArgs(argv: readonly string[]): Command {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true; strict: true }>>;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    // parseArgs throws TypeError with ERR_PARSE_ARGS_* codes for user mistakes.
    if ((error as NodeJS.ErrnoException).code?.startsWith("ERR_PARSE_ARGS")) throw usageError((error as Error).message);
    throw error;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.version) return { command: "version" };
  if (!command || command === "help") return rest[0] ? { command: "help", topic: rest[0] } : { command: "help" };
  if (command !== "analyze" && command !== "estimate" && command !== "show") throw usageError(`Unknown command "${command}".`);
  if (values.help) return { command: "help", topic: command };

  const given = (Object.keys(values) as OptionName[]).filter((k) => values[k] !== undefined && k !== "help" && k !== "version");
  const illegal = given.filter((k) => !ALLOWED[command].includes(k));
  if (illegal.length > 0) throw usageError(`Option ${illegal.map((k) => `--${k}`).join(", ")} is not valid for "${command}".`);

  const ai: AiFlags = {};
  const p = provider(values.provider);
  if (p) ai.provider = p;
  if (values.model) ai.model = values.model;
  if (values["base-url"]) ai.baseUrl = values["base-url"];
  const max = positiveInt("max-input-tokens", values["max-input-tokens"]);
  if (max !== undefined) ai.maxInputTokens = max;

  switch (command) {
    case "analyze": {
      const cmd: AnalyzeCommand = {
        command,
        paths: rest,
        json: values.json ?? false,
        noAi: values["no-ai"] ?? false,
        noHistory: values["no-history"] ?? false,
        yes: values.yes ?? false,
        ...ai,
      };
      if (values.out !== undefined) cmd.out = values.out;
      if (values.markdown !== undefined) cmd.markdown = values.markdown;
      const lang = language(values.lang);
      if (lang) cmd.lang = lang;
      return cmd;
    }
    case "estimate": {
      const cmd: EstimateCommand = { command, paths: rest, json: values.json ?? false, noHistory: values["no-history"] ?? false, ...ai };
      if (values.out !== undefined) cmd.out = values.out;
      return cmd;
    }
    case "show": {
      // `show GET /system/user/list` (unquoted) is the same as the quoted label.
      const entrypoint = rest.join(" ").trim();
      if (!entrypoint) throw usageError('"show" needs an entrypoint, e.g. project-atlas show "GET /system/user/list".');
      const cmd: ShowCommand = { command, entrypoint, json: values.json ?? false };
      if (values.dir !== undefined) cmd.dir = values.dir;
      const depth = positiveInt("depth", values.depth);
      if (depth !== undefined) cmd.depth = depth;
      return cmd;
    }
  }
}
