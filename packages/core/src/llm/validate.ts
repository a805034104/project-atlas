import type { SourceRef, StartupGuide } from "../model/types.js";
import { LlmSchemaError } from "./errors.js";

/**
 * Hand-written JSON shape validators + evidence check (spec「AI 分析流程」
 * steps 3–4, ENG-A20: every id must be known, every command must be found).
 *
 *   LLM text ─▶ parseJsonObject ─▶ validateX (shape) ─▶ checkX (evidence) ─▶ kept / rejected
 *              LlmSchemaError ◀────────┘                       └─ EvidenceRejected (counted, not thrown)
 */

export function parseJsonObject(text: string): unknown {
  let body = text.trim();
  const fenced = /^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```\s*$/.exec(body);
  if (fenced?.[1] !== undefined) body = fenced[1].trim();
  try {
    return JSON.parse(body);
  } catch {
    // Models sometimes wrap the object in prose; take the outermost braces.
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(body.slice(start, end + 1));
      } catch {
        // fall through
      }
    }
    throw new LlmSchemaError("output is not valid JSON");
  }
}

function fail(path: string, expected: string): never {
  throw new LlmSchemaError(`${path}: expected ${expected}`);
}

function obj(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "an object");
  return value as Record<string, unknown>;
}

function str(value: unknown, path: string, { nonEmpty = true } = {}): string {
  if (typeof value !== "string") fail(path, "a string");
  if (nonEmpty && value.trim().length === 0) fail(path, "a non-empty string");
  return value;
}

function arr(value: unknown, path: string, { optional = false } = {}): unknown[] {
  if (value === undefined && optional) return [];
  if (!Array.isArray(value)) fail(path, "an array");
  return value;
}

function strArray(value: unknown, path: string): string[] {
  return arr(value, path, { optional: true }).map((v, i) => str(v, `${path}[${i}]`));
}

function optLine(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) fail(path, "a positive integer");
  return value;
}

export function validateSummary(value: unknown): { summary: string } {
  const root = obj(value, "$");
  return { summary: str(root.summary, "$.summary").trim() };
}

export interface RawFeature {
  title: string;
  description: string;
  tier: "core" | "secondary";
  moduleIds: string[];
  entrypointIds: string[];
}

export function validateFeatures(value: unknown): { features: RawFeature[] } {
  const root = obj(value, "$");
  const features = arr(root.features, "$.features").map((item, i): RawFeature => {
    const p = `$.features[${i}]`;
    const f = obj(item, p);
    const tier = f.tier;
    if (tier !== "core" && tier !== "secondary") fail(`${p}.tier`, '"core" or "secondary"');
    return {
      title: str(f.title, `${p}.title`).trim(),
      description: str(f.description, `${p}.description`, { nonEmpty: false }).trim(),
      tier,
      moduleIds: strArray(f.moduleIds, `${p}.moduleIds`),
      entrypointIds: strArray(f.entrypointIds, `${p}.entrypointIds`),
    };
  });
  return { features };
}

export interface RawEvidence {
  file: string;
  line?: number;
}

export interface RawGuide {
  target: string;
  prerequisites: { name: string; version?: string; evidence: RawEvidence }[];
  steps: { command: string; cwd: string; evidence: RawEvidence }[];
  ports: { port: number; evidence: RawEvidence }[];
}

function evidence(value: unknown, path: string): RawEvidence {
  const e = obj(value, path);
  const file = str(e.file, `${path}.file`);
  const line = optLine(e.line, `${path}.line`);
  return line === undefined ? { file } : { file, line };
}

export function validateStartup(value: unknown): { guides: RawGuide[] } {
  const root = obj(value, "$");
  const guides = arr(root.guides, "$.guides").map((item, i): RawGuide => {
    const p = `$.guides[${i}]`;
    const g = obj(item, p);
    return {
      target: str(g.target, `${p}.target`).trim(),
      prerequisites: arr(g.prerequisites, `${p}.prerequisites`, { optional: true }).map((raw, j) => {
        const q = `${p}.prerequisites[${j}]`;
        const pre = obj(raw, q);
        const name = str(pre.name, `${q}.name`).trim();
        const ev = evidence(pre.evidence, `${q}.evidence`);
        if (pre.version === undefined || pre.version === null) return { name, evidence: ev };
        return { name, version: str(pre.version, `${q}.version`).trim(), evidence: ev };
      }),
      steps: arr(g.steps, `${p}.steps`, { optional: true }).map((raw, j) => {
        const q = `${p}.steps[${j}]`;
        const step = obj(raw, q);
        const rawCwd = step.cwd === undefined || step.cwd === "" ? "." : str(step.cwd, `${q}.cwd`).trim();
        // Model-supplied: only a relative POSIX path inside the repo, else fall back to the root.
        const cwd = /^(\.|[\w@.-]+(\/[\w@.-]+)*)$/.test(rawCwd) && !rawCwd.split("/").includes("..") ? rawCwd : ".";
        return { command: str(step.command, `${q}.command`).trim(), cwd, evidence: evidence(step.evidence, `${q}.evidence`) };
      }),
      ports: arr(g.ports, `${p}.ports`, { optional: true }).map((raw, j) => {
        const q = `${p}.ports[${j}]`;
        const port = obj(raw, q);
        const n = typeof port.port === "string" && /^\d+$/.test(port.port) ? Number(port.port) : port.port;
        if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 65535) fail(`${q}.port`, "a port number");
        return { port: n, evidence: evidence(port.evidence, `${q}.evidence`) };
      }),
    };
  });
  return { guides };
}

// ─── evidence check ──────────────────────────────────────────────────────────

export interface EvidenceCheckResult<T> {
  kept: T[];
  rejected: number;
}

/** Drop features citing unknown ids, or citing nothing at all. */
export function checkFeatures(
  features: readonly RawFeature[],
  known: { moduleIds: ReadonlySet<string>; entrypointIds: ReadonlySet<string> },
): EvidenceCheckResult<RawFeature> {
  const kept: RawFeature[] = [];
  let rejected = 0;
  for (const feature of features) {
    const empty = feature.moduleIds.length === 0 && feature.entrypointIds.length === 0;
    const unknown =
      feature.moduleIds.some((id) => !known.moduleIds.has(id)) ||
      feature.entrypointIds.some((id) => !known.entrypointIds.has(id));
    if (empty || unknown) rejected++;
    else kept.push(feature);
  }
  return { kept, rejected };
}

export interface StartupEvidenceSource {
  /** Maps a file path as cited by the model to the root it belongs to; undefined = not an evidence file. */
  rootIdOf(file: string): string | undefined;
  /** Original (unredacted) content of the evidence file. */
  readFile(rootId: string, file: string): string | undefined | Promise<string | undefined>;
  /** Root-relative path for the SourceRef, when the cited label differs (multi-root). Defaults to `file`. */
  pathOf?(file: string): string;
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Drop steps whose command is not literally in the cited file (whitespace-
 * normalized), ports not present in the cited file, and prerequisites citing a
 * file outside the evidence set. Guides left with no steps are dropped too.
 * Line numbers are corrected to where the command / port actually occurs.
 */
export async function checkStartup(
  guides: readonly RawGuide[],
  source: StartupEvidenceSource,
): Promise<EvidenceCheckResult<StartupGuide>> {
  const contents = new Map<string, { rootId: string; path: string; text: string; lines: string[] } | null>();
  const load = async (file: string): Promise<{ rootId: string; path: string; text: string; lines: string[] } | null> => {
    if (contents.has(file)) return contents.get(file) ?? null;
    const rootId = source.rootIdOf(file);
    let entry: { rootId: string; path: string; text: string; lines: string[] } | null = null;
    if (rootId !== undefined) {
      const path = source.pathOf ? source.pathOf(file) : file;
      const text = await source.readFile(rootId, path);
      if (text !== undefined) entry = { rootId, path, text, lines: text.split(/\r?\n/) };
    }
    contents.set(file, entry);
    return entry;
  };

  const kept: StartupGuide[] = [];
  let rejected = 0;
  for (const guide of guides) {
    const configFiles = new Map<string, SourceRef>();
    const cite = (e: { rootId: string; path: string }): void => {
      configFiles.set(`${e.rootId}\0${e.path}`, { rootId: e.rootId, file: e.path });
    };

    const prerequisites: StartupGuide["prerequisites"] = [];
    for (const pre of guide.prerequisites) {
      const file = await load(pre.evidence.file);
      if (!file) {
        rejected++;
        continue;
      }
      cite(file);
      const ref = sourceRef(file, pre.evidence.line !== undefined && pre.evidence.line <= file.lines.length ? pre.evidence.line : undefined);
      prerequisites.push(pre.version === undefined ? { name: pre.name, evidence: ref } : { name: pre.name, version: pre.version, evidence: ref });
    }

    const steps: StartupGuide["steps"] = [];
    for (const step of guide.steps) {
      const file = await load(step.evidence.file);
      const command = normalizeWhitespace(step.command);
      if (!file || command.length === 0 || !normalizeWhitespace(file.text).includes(command)) {
        rejected++;
        continue;
      }
      cite(file);
      const line = findLine(file.lines, step.evidence.line, (l) => normalizeWhitespace(l).includes(command));
      steps.push({ command, cwd: step.cwd, evidence: sourceRef(file, line) });
    }

    const ports: StartupGuide["ports"] = [];
    for (const port of guide.ports) {
      const file = await load(port.evidence.file);
      const re = new RegExp(`(?<![0-9])${port.port}(?![0-9])`);
      if (!file || !re.test(file.text)) {
        rejected++;
        continue;
      }
      cite(file);
      ports.push({ port: port.port, evidence: sourceRef(file, findLine(file.lines, port.evidence.line, (l) => re.test(l))) });
    }

    if (steps.length === 0) continue;
    kept.push({ target: guide.target, prerequisites, steps, ports, configFiles: [...configFiles.values()] });
  }
  return { kept, rejected };
}

function sourceRef(file: { rootId: string; path: string }, line: number | undefined): SourceRef {
  return line === undefined ? { rootId: file.rootId, file: file.path } : { rootId: file.rootId, file: file.path, line };
}

function findLine(lines: readonly string[], cited: number | undefined, matches: (line: string) => boolean): number | undefined {
  if (cited !== undefined) {
    const at = lines[cited - 1];
    if (at !== undefined && matches(at)) return cited;
  }
  const index = lines.findIndex(matches);
  return index >= 0 ? index + 1 : undefined;
}
