import { pushTo } from "../util/collections.js";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateGraph } from "../model/schema.js";
import { DEFAULT_FLOW_DEPTH, projectDfs } from "../graph/builder.js";
import type { AtlasGraph, CallEdge, Entrypoint, Flow, FlowStep, Module } from "../model/types.js";
import type {
  FeaturesData,
  FlowDetailData,
  FlowListData,
  HistoryData,
  ModulesData,
  OverviewData,
  StartupData,
  TopologyData,
  ViewId,
  ViewPayload,
} from "../protocol.js";

/**
 * Sharded persistence of AtlasGraph under `<atlasDir>/graph/` and view slicing
 * for the webview / CLI / MCP (spec ENG-A2: never post the whole graph).
 *
 *   graph/meta.json            everything except per-service call-graph data
 *   graph/services/<id>.json   { steps, edges, flows } owned by that service
 */

const DAY_MS = 86_400_000;
export const MAX_FLOW_DEPTH = 40;

type Meta = Omit<AtlasGraph, "steps" | "edges" | "flows">;
interface Shard {
  steps: FlowStep[];
  edges: CallEdge[];
  flows: Flow[];
}

async function writeAtomic(file: string, data: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

export async function saveGraph(atlasDir: string, graph: AtlasGraph): Promise<void> {
  const dir = path.join(atlasDir, "graph");
  const { steps, edges, flows, ...meta } = graph;
  const stepService = new Map(steps.map((s) => [s.id, s.serviceId]));
  const entryService = new Map(graph.entrypoints.map((e) => [e.id, e.serviceId]));
  const shards = new Map<string, Shard>();
  const shard = (id: string): Shard => {
    let s = shards.get(id);
    if (!s) {
      s = { steps: [], edges: [], flows: [] };
      shards.set(id, s);
    }
    return s;
  };
  for (const s of steps) shard(s.serviceId).steps.push(s);
  for (const e of edges) shard(stepService.get(e.from) ?? "").edges.push(e);
  for (const f of flows) shard(entryService.get(f.entrypointId) ?? "").flows.push(f);

  await rm(path.join(dir, "services"), { recursive: true, force: true });
  for (const [serviceId, data] of shards) {
    await writeAtomic(path.join(dir, "services", `${serviceId || "_"}.json`), JSON.stringify(data));
  }
  // meta last: a reader that sees the new meta also sees complete shards.
  await writeAtomic(path.join(dir, "meta.json"), JSON.stringify(meta));
  await writeAtomic(path.join(atlasDir, ".gitignore"), "*\n");
}

export type LoadStoredResult = { status: "ok"; graph: AtlasGraph } | { status: "missing" } | { status: "rebuild"; reason: string };

export async function loadStoredGraph(atlasDir: string): Promise<LoadStoredResult> {
  const dir = path.join(atlasDir, "graph");
  let metaText: string;
  try {
    metaText = await readFile(path.join(dir, "meta.json"), "utf8");
  } catch {
    return { status: "missing" };
  }
  const steps: FlowStep[] = [];
  const edges: CallEdge[] = [];
  const flows: Flow[] = [];
  try {
    let shardFiles: string[] = [];
    try {
      shardFiles = await readdir(path.join(dir, "services"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const file of shardFiles) {
      if (!file.endsWith(".json")) continue;
      const shard = JSON.parse(await readFile(path.join(dir, "services", file), "utf8")) as Shard;
      steps.push(...shard.steps);
      edges.push(...shard.edges);
      flows.push(...shard.flows);
    }
  } catch (error) {
    return { status: "rebuild", reason: `corrupt shard: ${(error as Error).message}` };
  }
  let meta: unknown;
  try {
    meta = JSON.parse(metaText);
  } catch (error) {
    return { status: "rebuild", reason: `corrupt meta: ${(error as Error).message}` };
  }
  const loaded = validateGraph({ ...(meta as object), steps, edges, flows });
  return loaded.status === "ok" ? { status: "ok", graph: loaded.graph } : { status: "rebuild", reason: loaded.detail };
}

// ── Views ────────────────────────────────────────────────────────────────────

export class GraphView {
  private readonly steps: Map<string, FlowStep>;
  private readonly edgesById: Map<string, CallEdge>;
  private readonly callEdgesFrom = new Map<string, CallEdge[]>();
  private readonly flows: Map<string, Flow>;

  constructor(readonly graph: AtlasGraph) {
    this.steps = new Map(graph.steps.map((s) => [s.id, s]));
    this.edgesById = new Map(graph.edges.map((e) => [e.id, e]));
    for (const e of graph.edges) {
      if (e.chain) continue;
      const list = this.callEdgesFrom.get(e.from) ?? [];
      list.push(e);
      this.callEdgesFrom.set(e.from, list);
    }
    this.flows = new Map(graph.flows.map((f) => [f.entrypointId, f]));
  }

  commits90d(): Record<string, number> {
    const cutoff = Date.parse(this.graph.project.analyzedAt) - 90 * DAY_MS;
    const out: Record<string, number> = {};
    for (const h of this.graph.history) out[h.moduleId] = h.commits.filter((c) => Date.parse(c.authorTime) >= cutoff).length;
    return out;
  }

  view(view: ViewId): ViewPayload {
    switch (view) {
      case "overview":
        return { view, data: this.overview() };
      case "topology":
        return { view, data: this.topology() };
      case "modules":
        return { view, data: this.modules() };
      case "features":
        return { view, data: this.features() };
      case "startup":
        return { view, data: this.startup() };
      case "flow":
        return { view, data: this.flowList() };
      case "history":
        return { view, data: this.history() };
    }
  }

  overview(): OverviewData {
    const g = this.graph;
    const commits = this.commits90d();
    const hotModules = [...g.modules]
      .map((module) => ({ module, commits90d: commits[module.id] ?? 0 }))
      .filter((m) => m.commits90d > 0)
      .sort((a, b) => b.commits90d - a.commits90d)
      .slice(0, 5);
    const data: OverviewData = {
      projectName: g.project.name,
      stacks: g.project.stacks,
      serviceCount: g.services.length,
      moduleCount: g.modules.length,
      entrypointCount: g.entrypoints.filter((e) => e.kind !== "frontend-route").length,
      coreFeatures: g.features.filter((f) => f.tier === "core"),
      candidateFeatures: g.features.length > 0 ? [] : this.candidateFeatures(),
      hotModules,
      diagnostics: g.diagnostics,
      llmUsage: g.llmUsage,
    };
    const primary = g.startup.find((s) => g.services.find((x) => x.id === s.serviceId)?.kind === "gateway") ?? g.startup[0];
    if (primary) data.primaryStartup = primary;
    return data;
  }

  /** Without AI: menu routes (RuoYi sys_menu names) or controller groups, each with the endpoints they reach. */
  candidateFeatures(): OverviewData["candidateFeatures"] {
    const g = this.graph;
    const routes = g.entrypoints.filter((e) => e.kind === "frontend-route" && e.handler.name.startsWith("menu "));
    const moduleOfService = (serviceId: string) => g.modules.find((m) => m.serviceId === serviceId)?.id;
    if (routes.length > 0) {
      return routes.slice(0, 30).map((route) => {
        const flow = this.flows.get(route.id);
        const reached = new Set((flow?.stepIds ?? []).map((id) => this.steps.get(id)?.symbol.fqn));
        const entrypointIds = g.entrypoints.filter((e) => e.kind === "http" && reached.has(e.handler.fqn)).map((e) => e.id);
        const moduleId = moduleOfService(route.serviceId);
        return { title: route.handler.name.slice("menu ".length), moduleIds: moduleId ? [moduleId] : [], entrypointIds };
      });
    }
    const byController = new Map<string, Entrypoint[]>();
    for (const e of g.entrypoints) {
      if (e.kind !== "http") continue;
      const owner = e.handler.name.split(".")[0] ?? e.handler.name;
      pushTo(byController, owner, e);
    }
    return [...byController.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 30)
      .map(([owner, eps]) => {
        const moduleId = moduleOfService(eps[0]?.serviceId ?? "");
        return { title: owner.replace(/Controller$/, ""), moduleIds: moduleId ? [moduleId] : [], entrypointIds: eps.map((e) => e.id) };
      });
  }

  topology(): TopologyData {
    return { services: this.graph.services, links: this.graph.serviceLinks, unresolvedCount: this.graph.unresolvedCalls.length };
  }

  modules(): ModulesData {
    return { services: this.graph.services, modules: this.graph.modules, commits90d: this.commits90d() };
  }

  features(): FeaturesData {
    return {
      features: this.graph.features,
      modules: this.graph.modules.map((m: Module) => ({ id: m.id, name: m.name })),
      entrypoints: this.graph.entrypoints,
    };
  }

  startup(): StartupData {
    return { guides: this.graph.startup, inspectedFiles: this.graph.startup.flatMap((g) => g.configFiles).slice(0, 50) };
  }

  flowList(): FlowListData {
    return { services: this.graph.services.map((s) => ({ id: s.id, name: s.name })), entrypoints: this.graph.entrypoints };
  }

  history(): HistoryData {
    return { modules: this.graph.modules.map((m) => ({ id: m.id, name: m.name, serviceId: m.serviceId })), history: this.graph.history };
  }

  flowDetail(entrypointId: string, depth?: number): FlowDetailData | undefined {
    const entrypoint = this.graph.entrypoints.find((e) => e.id === entrypointId);
    const stored = this.flows.get(entrypointId);
    if (!entrypoint || !stored) return undefined;
    const flow = depth && depth > DEFAULT_FLOW_DEPTH ? this.deepen(stored, Math.min(depth, MAX_FLOW_DEPTH)) : stored;
    const steps = flow.stepIds.map((id) => this.steps.get(id)).filter((s): s is FlowStep => !!s);
    const edges = flow.edgeIds.map((id) => this.edgesById.get(id)).filter((e): e is CallEdge => !!e);
    const serviceIds = new Set(steps.map((s) => s.serviceId));
    const stepIds = new Set(flow.stepIds);
    return {
      entrypoint,
      flow,
      steps,
      edges,
      services: this.graph.services.filter((s) => serviceIds.has(s.id)).map((s) => ({ id: s.id, name: s.name })),
      unresolvedCalls: this.graph.unresolvedCalls.filter((u) => stepIds.has(u.fromStepId)),
    };
  }

  /** Re-project a stored flow with a larger depth (the "展开更多" action). */
  private deepen(flow: Flow, depth: number): Flow {
    const chainEdges = flow.edgeIds.map((id) => this.edgesById.get(id)).filter((e): e is CallEdge => !!e?.chain);
    const chainTargets = new Set(chainEdges.map((e) => e.to));
    const chainSources = new Set(chainEdges.map((e) => e.from));
    const handler = [...chainTargets].find((t) => !chainSources.has(t)) ?? flow.stepIds[0];
    if (!handler) return flow;
    const projected = projectDfs((id) => this.callEdgesFrom.get(id) ?? [], handler, depth);
    const stepIds = new Set<string>([...chainSources, ...chainTargets, ...projected.stepIds]);
    const edgeIds = new Set<string>([...chainEdges.map((e) => e.id), ...projected.edgeIds]);
    const truncated = projected.truncated;
    return { entrypointId: flow.entrypointId, stepIds: [...stepIds], edgeIds: [...edgeIds], truncated };
  }
}
