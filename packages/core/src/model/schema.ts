import { SCHEMA_VERSION, type AtlasGraph } from "./types.js";

/**
 * Loading a persisted graph (spec ENG-A10: real migrations, not just "discard").
 *
 *   raw JSON ─▶ shape check ─▶ version?
 *                                ├─ current        → ok
 *                                ├─ older, has migration chain → migrate → ok
 *                                └─ newer / no chain / corrupt  → rebuild
 */

export type LoadResult =
  | { status: "ok"; graph: AtlasGraph; migratedFrom?: number }
  | { status: "rebuild"; reason: "corrupt" | "newer-schema" | "no-migration"; detail: string };

type Migration = (graph: Record<string, unknown>) => Record<string, unknown>;

/** migrations[n] upgrades a graph from schema n to n + 1. Empty until v2 exists. */
const migrations: Record<number, Migration> = {};

const REQUIRED_ARRAYS = [
  "services",
  "serviceLinks",
  "modules",
  "features",
  "startup",
  "entrypoints",
  "steps",
  "edges",
  "flows",
  "history",
  "unresolvedCalls",
  "diagnostics",
  "llmUsage",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadGraph(raw: string): LoadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { status: "rebuild", reason: "corrupt", detail: `invalid JSON: ${(error as Error).message}` };
  }
  if (!isRecord(parsed)) return { status: "rebuild", reason: "corrupt", detail: "graph is not an object" };

  const version = parsed["schemaVersion"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return { status: "rebuild", reason: "corrupt", detail: `bad schemaVersion: ${String(version)}` };
  }
  if (version > SCHEMA_VERSION) {
    return {
      status: "rebuild",
      reason: "newer-schema",
      detail: `graph schema ${version} is newer than supported ${SCHEMA_VERSION}`,
    };
  }

  let graph = parsed;
  for (let v = version; v < SCHEMA_VERSION; v++) {
    const migrate = migrations[v];
    if (!migrate) {
      return { status: "rebuild", reason: "no-migration", detail: `no migration from schema ${v}` };
    }
    graph = { ...migrate(graph), schemaVersion: v + 1 };
  }

  const shapeError = checkShape(graph);
  if (shapeError) return { status: "rebuild", reason: "corrupt", detail: shapeError };

  const loaded = graph as unknown as AtlasGraph;
  return version === SCHEMA_VERSION
    ? { status: "ok", graph: loaded }
    : { status: "ok", graph: loaded, migratedFrom: version };
}

function checkShape(graph: Record<string, unknown>): string | undefined {
  if (typeof graph["analyzerVersion"] !== "string") return "missing analyzerVersion";
  const project = graph["project"];
  if (!isRecord(project) || !Array.isArray(project["roots"])) return "missing project.roots";
  for (const key of REQUIRED_ARRAYS) {
    if (!Array.isArray(graph[key])) return `missing array: ${key}`;
  }
  return undefined;
}

export function emptyGraph(analyzerVersion: string, name: string, analyzedAt: Date): AtlasGraph {
  return {
    schemaVersion: SCHEMA_VERSION,
    analyzerVersion,
    project: { name, roots: [], stacks: [], analyzedAt: analyzedAt.toISOString() },
    services: [],
    serviceLinks: [],
    modules: [],
    features: [],
    startup: [],
    entrypoints: [],
    steps: [],
    edges: [],
    flows: [],
    history: [],
    unresolvedCalls: [],
    diagnostics: [],
    llmUsage: [],
  };
}
