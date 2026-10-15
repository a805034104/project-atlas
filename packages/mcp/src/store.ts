import { stat } from "node:fs/promises";
import path from "node:path";
import { GraphView, loadStoredGraph } from "@project-atlas/core";

/**
 * Read-only access to `.atlas/graph/` for the MCP tools. Never analyzes and
 * never writes; reloads only when graph/meta.json changes (saveGraph writes
 * meta last via rename, so a new meta implies complete shards).
 *
 *   tool call ─▶ stat(meta.json) ─▶ same mtime/size/ino? ─▶ cached GraphView
 *                                   └─ changed ─▶ loadStoredGraph ─▶ new GraphView
 *                                   └─ missing / corrupt ─▶ StoreUnavailableError
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
  private cached: { key: string; view: GraphView } | undefined;
  private loading: Promise<GraphView> | undefined;

  constructor(readonly dir: string) {}

  async view(): Promise<GraphView> {
    const meta = path.join(this.dir, "graph", "meta.json");
    let key: string;
    try {
      const s = await stat(meta);
      key = `${s.mtimeMs}:${s.size}:${s.ino}`;
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
    const view = new GraphView(loaded.graph);
    this.cached = { key, view };
    return view;
  }
}
