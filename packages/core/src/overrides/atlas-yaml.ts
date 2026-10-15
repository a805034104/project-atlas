import { parse } from "yaml";
import type { Diagnostic, Stack } from "../model/types.js";

/**
 * atlas.yaml v1 (escape hatches, spec DX Pass 2) and `.atlas/overrides.yaml`
 * ("mark edge as wrong"). Precedence: atlas.yaml > .atlas/overrides.yaml > detection.
 *
 *   version: 1
 *   services: [{ name, path | git, ref, stack, kind }]
 *   wrappers: [{ symbol, kind: http|mq, urlArg, methodLiteral, broker, topicArg }]
 *   edges: { add: [{ from, to, note }], remove: [{ from, to }] }
 *   ignoreEntrypoints: ["GET /actuator/**", "**\/test/**"]
 */

export const ATLAS_YAML_VERSION = 1;

export interface ServiceOverride {
  name?: string;
  path?: string;
  git?: string;
  ref?: string;
  stack?: Stack;
  kind?: "backend" | "gateway" | "frontend" | "worker";
}

export interface WrapperOverride {
  symbol: string;
  kind: "http" | "mq";
  urlArg?: number;
  methodLiteral?: string;
  broker?: string;
  topicArg?: number;
}

/** Edge endpoints are symbol names as shown in the UI (`SysUserController.list`) or step ids. */
export interface EdgeRef {
  from: string;
  to: string;
  note?: string;
}

export interface AtlasOverrides {
  version: number;
  services: ServiceOverride[];
  wrappers: WrapperOverride[];
  edges: { add: EdgeRef[]; remove: EdgeRef[] };
  ignoreEntrypoints: string[];
}

export function emptyOverrides(): AtlasOverrides {
  return { version: ATLAS_YAML_VERSION, services: [], wrappers: [], edges: { add: [], remove: [] }, ignoreEntrypoints: [] };
}

const STACKS = new Set(["java-spring", "vue", "go", "python"]);
const KINDS = new Set(["backend", "gateway", "frontend", "worker"]);

export function parseAtlasYaml(text: string, file: string): { overrides: AtlasOverrides; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const out = emptyOverrides();
  const warn = (message: string) => diagnostics.push({ code: "ATLAS-W020", severity: "warning", message: `${file}: ${message}`, at: { rootId: "", file } });
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (error) {
    warn(`invalid YAML (${(error as Error).message}); file ignored`);
    return { overrides: out, diagnostics };
  }
  if (doc === null || doc === undefined) return { overrides: out, diagnostics };
  if (typeof doc !== "object" || Array.isArray(doc)) {
    warn("top level must be a mapping; file ignored");
    return { overrides: out, diagnostics };
  }
  const root = doc as Record<string, unknown>;
  const version = root["version"] ?? 1;
  if (version !== 1) warn(`unsupported version ${String(version)}; reading as version 1`);

  for (const [i, raw] of asArray(root["services"], "services", warn).entries()) {
    if (!isRecord(raw)) {
      warn(`services[${i}] must be a mapping`);
      continue;
    }
    const s: ServiceOverride = {};
    if (typeof raw["name"] === "string") s.name = raw["name"];
    if (typeof raw["path"] === "string") s.path = raw["path"].replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
    if (typeof raw["git"] === "string") {
      if (/^(https:\/\/|git@[\w.-]+:)/.test(raw["git"])) s.git = raw["git"];
      else warn(`services[${i}].git must be an https:// or git@ URL (other protocols are refused)`);
    }
    if (typeof raw["ref"] === "string") s.ref = raw["ref"];
    if (typeof raw["stack"] === "string") {
      if (STACKS.has(raw["stack"])) s.stack = raw["stack"] as Stack;
      else warn(`services[${i}].stack "${raw["stack"]}" is not one of ${[...STACKS].join(", ")}`);
    }
    if (typeof raw["kind"] === "string" && KINDS.has(raw["kind"])) s.kind = raw["kind"] as NonNullable<ServiceOverride["kind"]>;
    if (s.path && s.git) warn(`services[${i}] sets both path and git; path wins`);
    out.services.push(s);
  }

  for (const [i, raw] of asArray(root["wrappers"], "wrappers", warn).entries()) {
    if (!isRecord(raw) || typeof raw["symbol"] !== "string" || (raw["kind"] !== "http" && raw["kind"] !== "mq")) {
      warn(`wrappers[${i}] needs symbol and kind (http|mq)`);
      continue;
    }
    const w: WrapperOverride = { symbol: raw["symbol"], kind: raw["kind"] };
    if (typeof raw["urlArg"] === "number") w.urlArg = raw["urlArg"];
    if (typeof raw["methodLiteral"] === "string") w.methodLiteral = raw["methodLiteral"].toUpperCase();
    if (typeof raw["broker"] === "string") w.broker = raw["broker"];
    if (typeof raw["topicArg"] === "number") w.topicArg = raw["topicArg"];
    out.wrappers.push(w);
  }

  const edges = isRecord(root["edges"]) ? root["edges"] : {};
  for (const key of ["add", "remove"] as const) {
    for (const [i, raw] of asArray(edges[key], `edges.${key}`, warn).entries()) {
      if (!isRecord(raw) || typeof raw["from"] !== "string" || typeof raw["to"] !== "string") {
        warn(`edges.${key}[${i}] needs from and to`);
        continue;
      }
      const e: EdgeRef = { from: raw["from"], to: raw["to"] };
      if (typeof raw["note"] === "string") e.note = raw["note"];
      out.edges[key].push(e);
    }
  }
  out.ignoreEntrypoints = asArray(root["ignoreEntrypoints"], "ignoreEntrypoints", warn).filter((x): x is string => typeof x === "string");
  return { overrides: out, diagnostics };
}

/** atlas.yaml wins over .atlas/overrides.yaml: lists are concatenated with atlas.yaml first. */
export function mergeOverrides(primary: AtlasOverrides, secondary: AtlasOverrides): AtlasOverrides {
  return {
    version: ATLAS_YAML_VERSION,
    services: [...primary.services, ...secondary.services],
    wrappers: [...primary.wrappers, ...secondary.wrappers],
    edges: { add: [...primary.edges.add, ...secondary.edges.add], remove: [...primary.edges.remove, ...secondary.edges.remove] },
    ignoreEntrypoints: [...primary.ignoreEntrypoints, ...secondary.ignoreEntrypoints],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown, name: string, warn: (m: string) => void): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warn(`${name} must be a list`);
    return [];
  }
  return value;
}
