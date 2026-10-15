import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { collectModuleHistory } from "./git/index.js";
import { GraphBuilder } from "./graph/builder.js";
import { stableId } from "./model/ids.js";
import { SCHEMA_VERSION, type AtlasGraph, type Diagnostic, type ModuleHistory, type Root, type Stack, type StartupGuide } from "./model/types.js";
import { applyEdgeOverrides, isIgnoredEntrypoint } from "./overrides/apply.js";
import { emptyOverrides, mergeOverrides, parseAtlasYaml, type AtlasOverrides } from "./overrides/atlas-yaml.js";
import { createParsePool, type ParsePool } from "./parse/pool.js";
import type { AnalysisPhase } from "./protocol.js";
import { JavaIndex } from "./rules/java-index.js";
import { indexMapperXml } from "./rules/mybatis.js";
import { runSpringRules, type FeignCallSite, type HttpChain, type RestCallSite } from "./rules/spring.js";
import { frontendStartup, javaStartup } from "./rules/startup.js";
import { runVueRules, type FrontendCall } from "./rules/vue.js";
import { linkServices } from "./rules/xservice.js";
import { detectProject, type DetectedProject } from "./workspace/detect.js";
import { loadWorkspace, type LoadedFile, type Workspace } from "./workspace/load.js";

/**
 * Deterministic analysis (no network): the whole AtlasGraph minus AI fields.
 *
 *   roots ─▶ load (parse pool, facts cache) ─▶ detect services/modules
 *     ─▶ Spring rules per service ─▶ Vue rules per app ─▶ cross-service links
 *     ─▶ overrides (atlas.yaml, .atlas/overrides.yaml) ─▶ flow projections
 *     ─▶ git history ─▶ startup guides ─▶ AtlasGraph
 */

export const ANALYZER_VERSION = "0.1.0";

export interface RootInput {
  path: string;
  kind?: Root["kind"];
  git?: Root["git"];
}

export interface AnalyzeOptions {
  roots: RootInput[];
  /** `.atlas` cache directory; omit to disable the facts cache. */
  cacheDir?: string;
  pool?: ParsePool;
  wasmDir?: string;
  workerPath?: string;
  exclude?: readonly string[];
  maxFileSizeKB?: number;
  /** Already-parsed overrides; when absent, atlas.yaml / .atlas/overrides.yaml are read from the first root. */
  overrides?: AtlasOverrides;
  history?: boolean;
  signal?: AbortSignal;
  onPhase?: (phase: AnalysisPhase, progress: number) => void;
  now?: () => Date;
}

export interface AnalysisResult {
  graph: AtlasGraph;
  workspace: Workspace;
  project: DetectedProject;
  overrides: AtlasOverrides;
}

export async function readAtlasOverrides(rootPath: string): Promise<{ overrides: AtlasOverrides; diagnostics: Diagnostic[] }> {
  const read = async (file: string) => {
    try {
      return await readFile(path.join(rootPath, file), "utf8");
    } catch {
      return undefined;
    }
  };
  const diagnostics: Diagnostic[] = [];
  let overrides = emptyOverrides();
  const atlasYaml = await read("atlas.yaml");
  const local = await read(".atlas/overrides.yaml");
  if (local) {
    const parsed = parseAtlasYaml(local, ".atlas/overrides.yaml");
    overrides = parsed.overrides;
    diagnostics.push(...parsed.diagnostics);
  }
  if (atlasYaml) {
    const parsed = parseAtlasYaml(atlasYaml, "atlas.yaml");
    overrides = mergeOverrides(parsed.overrides, overrides);
    diagnostics.push(...parsed.diagnostics);
  }
  return { overrides, diagnostics };
}

export async function resolveRoots(inputs: readonly RootInput[]): Promise<Root[]> {
  const roots: Root[] = [];
  for (const input of inputs) {
    const real = await realpath(input.path);
    if (roots.some((r) => r.path === real)) continue; // same repo added twice
    const root: Root = { id: stableId("root", "", real.replace(/\\/g, "/").toLowerCase()), path: real, kind: input.kind ?? "workspace" };
    if (input.git) root.git = input.git;
    roots.push(root);
  }
  // Nested roots: the outer root excludes the inner one (handled by walk excludes below).
  return roots;
}

function within(dir: string, rel: string): boolean {
  return dir === "" || rel === dir || rel.startsWith(`${dir}/`);
}

export async function analyzeWorkspace(options: AnalyzeOptions): Promise<AnalysisResult> {
  const { signal } = options;
  const phase = options.onPhase ?? (() => {});
  const roots = await resolveRoots(options.roots);
  const diagnostics: Diagnostic[] = [];

  const ownPool = !options.pool;
  const pool = options.pool ?? (await createParsePool({ ...(options.wasmDir ? { wasmDir: options.wasmDir } : {}), ...(options.workerPath ? { workerPath: options.workerPath } : {}) }));
  let workspace: Workspace;
  try {
    phase("parse", 0);
    const nested = (root: Root) =>
      roots
        .filter((o) => o !== root && o.path.startsWith(`${root.path}${path.sep}`))
        .map((o) => `${path.relative(root.path, o.path).replace(/\\/g, "/")}/`);
    const loaded: Workspace = { roots, files: [], diagnostics: [] };
    for (const root of roots) {
      const part = await loadWorkspace({
        roots: [root],
        pool,
        analyzerVersion: ANALYZER_VERSION,
        ...(options.cacheDir ? { cacheDir: options.cacheDir } : {}),
        exclude: [...(options.exclude ?? []), ...nested(root)],
        ...(options.maxFileSizeKB ? { maxFileSizeKB: options.maxFileSizeKB } : {}),
        ...(signal ? { signal } : {}),
        onProgress: (done, total) => phase("parse", total === 0 ? 1 : done / total),
      });
      loaded.files.push(...part.files);
      loaded.diagnostics.push(...part.diagnostics);
    }
    workspace = loaded;
  } finally {
    if (ownPool) await pool.close();
  }
  diagnostics.push(...workspace.diagnostics);
  signal?.throwIfAborted();

  const firstRoot = roots[0];
  let overrides = options.overrides;
  if (!overrides) {
    const read = firstRoot ? await readAtlasOverrides(firstRoot.path) : { overrides: emptyOverrides(), diagnostics: [] };
    overrides = read.overrides;
    diagnostics.push(...read.diagnostics.map((d) => ({ ...d, ...(d.at ? { at: { ...d.at, rootId: firstRoot?.id ?? "" } } : {}) })));
  }

  for (const s of overrides.services) {
    if (s.git && s.path === undefined && !roots.some((r) => r.git?.url === s.git)) {
      diagnostics.push({ code: "ATLAS-I004", severity: "info", message: `atlas.yaml service ${s.name ?? s.git} (${s.git}) was not cloned; clone it locally or analyze from VS Code` });
    }
  }

  // ── Rules ─────────────────────────────────────────────────────────────────
  phase("rules", 0);
  const serviceNames: Record<string, string> = {};
  for (const s of overrides.services) if (s.name && s.path !== undefined && firstRoot) serviceNames[`${firstRoot.id}:${s.path}`] = s.name;
  const project = detectProject(workspace, { serviceNames });
  for (const s of overrides.services) {
    const target = project.services.find((x) => s.path !== undefined && x.path === s.path && x.rootId === firstRoot?.id);
    if (target && s.kind) target.kind = s.kind;
  }

  const graph = new GraphBuilder();
  const indexes = new Map<string, JavaIndex>();
  const chains: HttpChain[] = [];
  const scheduled: { entrypointId: string; handlerStepId: string }[] = [];
  const feignCalls: FeignCallSite[] = [];
  const restCalls: RestCallSite[] = [];
  const wrappers = overrides.wrappers.map((w) => ({ symbol: w.symbol, kind: w.kind, ...(w.urlArg !== undefined ? { urlArg: w.urlArg } : {}), ...(w.methodLiteral ? { methodLiteral: w.methodLiteral } : {}) }));
  project.java.forEach((svc, i) => {
    signal?.throwIfAborted();
    const files = workspace.files.filter((f) => svc.classpath.some((c) => c.rootId === f.rootId && within(c.dir, f.relPath)));
    const index = new JavaIndex(files);
    indexes.set(svc.service.id, index);
    const result = runSpringRules(svc, index, indexMapperXml(files), graph, wrappers);
    chains.push(...result.chains);
    scheduled.push(...result.scheduled.map((s) => ({ entrypointId: s.entrypoint.id, handlerStepId: s.handlerStepId })));
    feignCalls.push(...result.feignCalls);
    restCalls.push(...result.restCalls);
    diagnostics.push(...result.diagnostics);
    phase("rules", (i + 1) / Math.max(1, project.java.length + project.frontends.length));
  });
  const sqlFiles = workspace.files.filter((f) => f.kind === "sql");
  const frontendCalls = new Map<string, FrontendCall[]>();
  const routes: { entrypointId: string; pageStepId: string }[] = [];
  for (const app of project.frontends) {
    const result = runVueRules(app, workspace.files, sqlFiles, graph);
    frontendCalls.set(app.service.id, result.calls);
    routes.push(...result.routes.map((r) => ({ entrypointId: r.entrypoint.id, pageStepId: r.pageStepId })));
  }

  phase("cross-service", 0);
  const handlers = new Map(chains.map((c) => [c.entrypoint.id, c.handlerStepId]));
  const linked = linkServices({ java: project.java, frontends: project.frontends, indexes, frontendCalls, feignCalls, restCalls, handlers }, graph);
  diagnostics.push(...applyEdgeOverrides(graph, overrides.edges));

  // ── Flows ─────────────────────────────────────────────────────────────────
  const ignored = new Set([...graph.entrypoints.values()].filter((e) => isIgnoredEntrypoint(e, overrides.ignoreEntrypoints)).map((e) => e.id));
  for (const id of ignored) graph.entrypoints.delete(id);
  for (const chain of chains) {
    if (ignored.has(chain.entrypoint.id)) continue;
    const upstream = linked.upstream.get(chain.entrypoint.id)?.stepIds ?? [];
    const discriminator = GraphBuilder.chainDiscriminator(chain.entrypoint.id);
    const chainStepIds = [...upstream, ...chain.chainStepIds];
    const chainEdgeIds = [...chain.chainEdgeIds];
    const first = chain.chainStepIds[0] ?? chain.handlerStepId;
    upstream.forEach((stepId, i) => {
      chainEdgeIds.unshift(graph.edge(stepId, upstream[i + 1] ?? first, { provenance: "framework-rule", discriminator }));
    });
    graph.projectFlow(chain.entrypoint.id, chainStepIds, chainEdgeIds, chain.handlerStepId);
  }
  for (const s of scheduled) if (!ignored.has(s.entrypointId)) graph.projectFlow(s.entrypointId, [], [], s.handlerStepId);
  for (const r of routes) if (!ignored.has(r.entrypointId)) graph.projectFlow(r.entrypointId, [], [], r.pageStepId);
  phase("cross-service", 1);

  // ── History ───────────────────────────────────────────────────────────────
  const history: ModuleHistory[] = [];
  if (options.history !== false) {
    phase("history", 0);
    for (const root of roots) {
      const modules = project.modules.filter((m) => project.services.find((s) => s.id === m.serviceId)?.rootId === root.id || (!m.serviceId && root === firstRoot));
      if (modules.length === 0) continue;
      const result = await collectModuleHistory({ cwd: root.path, modules: modules.map((m) => ({ id: m.id, path: m.path })), ...(signal ? { signal } : {}) });
      history.push(...result.history);
      diagnostics.push(...result.diagnostics.map((d) => (d.at ? { ...d, at: { ...d.at, rootId: root.id } } : d)));
      if (result.head) root.git = { ...root.git, head: result.head, shallow: result.shallow };
    }
    phase("history", 1);
  }

  // ── Startup ───────────────────────────────────────────────────────────────
  const startup: StartupGuide[] = [
    ...project.java.map((svc) => javaStartup(svc, workspace.files)),
    ...project.frontends.map((app) => frontendStartup(app, workspace.files)),
  ];

  const stacks = [...new Set(project.services.map((s) => s.stack))] as Stack[];
  const now = (options.now ?? (() => new Date()))();
  const usedSteps = new Set(graph.flows.flatMap((f) => f.stepIds));
  for (const e of graph.edges.values()) {
    usedSteps.add(e.from);
    usedSteps.add(e.to);
  }
  const graphOut: AtlasGraph = {
    schemaVersion: SCHEMA_VERSION,
    analyzerVersion: ANALYZER_VERSION,
    project: {
      name: firstRoot ? path.basename(firstRoot.path) : "workspace",
      roots,
      stacks,
      analyzedAt: now.toISOString(),
    },
    services: project.services,
    serviceLinks: linked.links,
    modules: project.modules,
    features: [],
    startup,
    entrypoints: [...graph.entrypoints.values()],
    steps: [...graph.steps.values()].filter((s) => usedSteps.has(s.id)),
    edges: [...graph.edges.values()],
    flows: graph.flows,
    history,
    unresolvedCalls: graph.unresolved,
    diagnostics,
    llmUsage: [],
  };
  return { graph: graphOut, workspace, project, overrides };
}

export type { LoadedFile };
