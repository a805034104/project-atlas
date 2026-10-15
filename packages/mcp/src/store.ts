import { stat } from "node:fs/promises";
import path from "node:path";
import { applyOverlay, emptyAggregates, GraphView, loadStoredGraph, reconcile, TraceStore, type AggregateState } from "@project-atlas/core";

/**
 * Read-only access to `.atlas/graph/` for the MCP tools. Never analyzes and
 * never writes; reloads only when graph/meta.json changes (saveGraph writes
 * meta last via rename, so a new meta implies complete shards).
 *
 *   tool call ─▶ stat(meta.json) ─▶ same mtime/size/ino? ─▶ cached GraphView
 *                                   └─ changed ─▶ loadStoredGraph ─▶ new GraphView
 *                                   └─ missing / corrupt ─▶ StoreUnavailableError
 *   traces/aggregates.json (project-atlas trace) is folded in as observed stats; only
 *   aggregates (counts, latencies, ids) ever reach the client, never span attributes.
 */

export class StoreUnavailableError extends Error {
  constructor(
    readonly dir: string,
    readonly reason: string,
  ) {
    super(
      `No usable ProjectAtlas graph at ${dir} (${reason}). ` +
        "Run `project-atlas analyze` in the project root (or the VS Code command “Atlas: Analyze Workspace”), " +
        "or start atlas-mcp with --dir pointing at the project's .atlas directory, then call this tool again.",
    );
    this.name = "StoreUnavailableError";
  }
}

export class GraphSource {
  private cached: { key: string; view: GraphView; aggregates: AggregateState } | undefined;
  private loading: Promise<GraphView> | undefined;

  constructor(readonly dir: string) {}

  async view(): Promise<GraphView> {
    const meta = path.join(this.dir, "graph", "meta.json");
    let key: string;
    try {
      const s = await stat(meta);
      const agg = await stat(path.join(this.dir, "traces", "aggregates.json")).catch(() => undefined);
      key = `${s.mtimeMs}:${s.size}:${s.ino}|${agg ? `${agg.mtimeMs}:${agg.size}` : "-"}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
        this.cached = undefined;
        throw new StoreUnavailableError(this.dir, "graph/meta.json not found");
      }
      throw error;
    }
    if (this.cached?.key === key) return this.cached.view;
    this.loading ??= this.load(key).finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  private async load(key: string): Promise<GraphView> {
    const loaded = await loadStoredGraph(this.dir);
    if (loaded.status === "missing") throw new StoreUnavailableError(this.dir, "graph/meta.json not found");
    if (loaded.status === "rebuild") throw new StoreUnavailableError(this.dir, `stored graph is unreadable: ${loaded.reason}`);
    const aggregates = await new TraceStore(path.join(this.dir, "traces")).loadAggregates();
    const graph = aggregates.total > 0 ? applyOverlay(loaded.graph, reconcile(loaded.graph, aggregates)) : loaded.graph;
    const view = new GraphView(graph);
    this.cached = { key, view, aggregates };
    return view;
  }

  /** Runtime aggregates of the last loaded view (empty when nothing was traced). */
  async aggregates(): Promise<AggregateState> {
    await this.view();
    return this.cached?.aggregates ?? emptyAggregates();
  }
}
