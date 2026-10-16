import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  Aggregator,
  AgentDownloadError,
  AgentIntegrityError,
  decodeTraceRequest,
  decodeTraceRequestJson,
  ensureJavaAgent,
  entrypointLabel,
  loadStoredGraph,
  OtlpDecodeError,
  reconcile,
  writeAgentConfigFile,
  runtimeOwner,
  RuntimeLockedError,
  RuntimeSession,
  saveGraph,
  toSpanRecords,
  TraceStore,
  tracedLaunch,
  vmOptions,
  workspaceToken,
  type AggregateState,
  type AtlasGraph,
  type Service,
} from "@project-atlas/core";
import type { TraceCommand } from "../args.js";
import { runAnalysis } from "../common.js";
import { CliError, EXIT_ANALYSIS, EXIT_OK, EXIT_USAGE } from "../errors.js";
import type { CliIo } from "../io.js";

/**
 * `project-atlas trace` — capture runtime spans for the workspace and reconcile them.
 *
 *   graph (.atlas, analyzed with --no-ai when missing) ─▶ receiver (or the live owner's)
 *     ─▶ pinned javaagent ─▶ agent config (methods from the graph) ─┬▶ --print-config: VM options, keep receiving
 *                                                                   └▶ -- <command>: launch with the agent, wait
 *     ─▶ Ctrl-C / exit ─▶ summary (observed entrypoints, coverage, runtime-only calls)
 *   `trace import <file>` folds an OTLP file (protobuf or JSON) into the same store.
 */

export interface TraceDeps {
  /** Spawn the traced command; returns its exit code. Tests replace this. */
  run?: (command: string, env: Record<string, string>, cwd: string, options: RunOptions) => Promise<number>;
  /** Resolves when the user interrupts a `--print-config` session. */
  waitForInterrupt?: () => Promise<void>;
  /** Flush window after the command exits (exporter batch delay is 500 ms). */
  settleMs?: number;
}

/** End a Windows process and everything it started (cmd.exe → mvn's JVM → the app's JVM). */
function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve()));
}

export interface RunOptions {
  stdoutToStderr: boolean;
  /** After Ctrl-C, how long the tree may take to stop by itself before it is killed (Windows). */
  graceMs?: number;
  /** stderr for the "stopping" notice. */
  notice?: (line: string) => void;
}

/**
 *   Ctrl-C ─▶ the console delivers it to every process in the tree; this one stays alive to summarise
 *     Windows: still running after graceMs (a JVM stuck in shutdown hooks, cmd.exe asking
 *              "Terminate batch job (Y/N)?" for mvn.cmd), or a second Ctrl-C ─▶ taskkill /T /F
 *   exit code: the child's; 130 when the run was interrupted.
 */
export function runTraced(command: string, env: Record<string, string>, cwd: string, options: RunOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    // shell: the command comes from the user's own terminal (or the startup guide); mvn is mvn.cmd on Windows.
    // With --json the app's own output goes to stderr so stdout stays one JSON document.
    const child = spawn(command, { cwd, env: { ...process.env, ...env }, stdio: options.stdoutToStderr ? ["inherit", process.stderr, "inherit"] : "inherit", shell: true });
    let interrupts = 0;
    let timer: NodeJS.Timeout | undefined;
    const forward = () => {
      interrupts++;
      if (process.platform !== "win32" || child.pid === undefined) return;
      if (interrupts === 1) {
        const graceMs = options.graceMs ?? 10_000;
        options.notice?.(`atlas: stopping (up to ${Math.ceil(graceMs / 1000)} s; Ctrl-C again to stop now)`);
        timer = setTimeout(() => void killTree(child.pid as number), graceMs);
      } else {
        void killTree(child.pid);
      }
    };
    process.on("SIGINT", forward);
    child.on("error", (error) => {
      process.off("SIGINT", forward);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      process.off("SIGINT", forward);
      if (timer) clearTimeout(timer);
      resolve(interrupts > 0 ? 130 : (code ?? (signal ? 130 : 1)));
    });
  });
}

function defaultWaitForInterrupt(): Promise<void> {
  return new Promise((resolve) => process.once("SIGINT", () => resolve()));
}

async function loadOrAnalyze(io: CliIo, workspace: string): Promise<AtlasGraph> {
  const atlasDir = path.join(workspace, ".atlas");
  const loaded = await loadStoredGraph(atlasDir);
  if (loaded.status === "ok") return loaded.graph;
  io.stderr("atlas: no saved analysis yet, running `analyze --no-ai` first\n");
  const { graph } = await runAnalysis(io, [workspace], { cacheDir: atlasDir, history: false });
  await saveGraph(atlasDir, graph);
  return graph;
}

function pickService(graph: AtlasGraph, name: string | undefined, cwd: string, workspace: string): Service {
  const backends = graph.services.filter((s) => s.stack === "java-spring" || s.kind === "backend" || s.kind === "gateway");
  if (name) {
    const found = graph.services.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!found) throw new CliError({ code: "ATLAS-E060", problem: `Unknown service "${name}".`, cause: `Services: ${backends.map((s) => s.name).join(", ")}`, fix: "Pass one of the listed names to --service." }, EXIT_USAGE);
    return found;
  }
  const rel = path.relative(workspace, cwd).replace(/\\/g, "/");
  const inside = backends.filter((s) => s.path && (rel === s.path || rel.startsWith(`${s.path}/`))).sort((a, b) => b.path.length - a.path.length)[0];
  const chosen = inside ?? backends[0];
  if (!chosen) throw new CliError({ code: "ATLAS-E050", problem: "No Java service to trace in this workspace.", cause: "The analysis found no Spring Boot service.", fix: "Run trace from a Spring Boot project." }, EXIT_ANALYSIS);
  return chosen;
}

function summary(graph: AtlasGraph, state: AggregateState): { lines: string[]; json: Record<string, unknown> } {
  const overlay = reconcile(graph, state);
  const labels = new Map(graph.entrypoints.map((e) => [e.id, entrypointLabel(e)]));
  const steps = new Map(graph.steps.map((s) => [s.id, s.symbol.name]));
  const observed = Object.entries(overlay.entrypoints).sort((a, b) => b[1].count - a[1].count);
  const lines = [
    `atlas: ${state.total} span(s), ${observed.length} entrypoint(s) observed`,
    ...observed.slice(0, 15).map(([id, s]) => {
      const cov = overlay.coverage[id];
      return `  ${String(s.count).padStart(4)}×  p95 ${String(s.p95Ms).padStart(7)} ms  ${labels.get(id) ?? id}${cov ? `  (${cov.observed}/${cov.instrumentable} steps observed)` : ""}`;
    }),
  ];
  if (overlay.runtimeEdges.length > 0 || overlay.reachability.length > 0) lines.push(`atlas: runtime-only calls: ${overlay.runtimeEdges.length} drawn, ${overlay.reachability.length} reachable through uninstrumented code`);
  if (overlay.unmatched.length > 0) lines.push(`atlas: ${overlay.unmatched.length} span key(s) matched no step (ATLAS-W035)`);
  const first = observed[0];
  if (first) lines.push(`next: project-atlas show "${labels.get(first[0])}" --dir ${JSON.stringify(path.join(".", ".atlas"))}`);
  return {
    lines,
    json: {
      spans: state.total,
      entrypoints: observed.map(([id, s]) => ({ id, label: labels.get(id), ...s, coverage: overlay.coverage[id] })),
      runtimeEdges: overlay.runtimeEdges.map((e) => ({ from: steps.get(e.from), to: steps.get(e.to), async: e.async, count: e.observed.count })),
      reachable: overlay.reachability.map((r) => ({ from: steps.get(r.from), to: steps.get(r.to), count: r.count })),
      unmatched: overlay.unmatched,
    },
  };
}

async function importFile(cmd: TraceCommand, io: CliIo, workspace: string): Promise<number> {
  const file = path.resolve(io.cwd, cmd.importFile as string);
  const data = await readFile(file).catch((error: unknown) => {
    throw new CliError({ code: "ATLAS-E060", problem: `Cannot read ${file}.`, cause: (error as Error).message, fix: "Check the path." }, EXIT_USAGE);
  });
  let records;
  try {
    const text = data.subarray(0, 1).toString() === "{" ? data.toString("utf8") : undefined;
    records = toSpanRecords(text !== undefined ? decodeTraceRequestJson(text) : decodeTraceRequest(data));
  } catch (error) {
    if (!(error instanceof OtlpDecodeError)) throw error;
    throw new CliError({ code: "ATLAS-W031", problem: `${path.basename(file)} is not an OTLP trace export.`, cause: error.message, fix: "Pass an ExportTraceServiceRequest as protobuf (.pb) or OTLP/JSON." }, EXIT_USAGE);
  }
  // A live receiver owns .atlas/traces (its debounced saves would overwrite our aggregates).
  const importOwner = await runtimeOwner(workspace);
  if (importOwner) {
    throw new CliError({ code: "ATLAS-E074", problem: `The receiver of pid ${importOwner.pid} is recording traces for this workspace.`, cause: "Importing now would race with its saves.", fix: "Stop tracing (Ctrl-C, or Atlas: Stop Tracing in VS Code), then import again." }, EXIT_USAGE);
  }
  const graph = await loadOrAnalyze(io, workspace);
  const store = new TraceStore(path.join(workspace, ".atlas", "traces"));
  const aggregator = new Aggregator(await store.loadAggregates());
  // The dedupe window is in memory only: skip spans this store already holds (re-imports).
  const traces = new Set(records.map((r) => r.t));
  const stored = new Set<string>();
  for await (const r of store.records()) if (traces.has(r.t)) stored.add(`${r.t}:${r.s}`);
  const fresh = aggregator.add(records.filter((r) => !stored.has(`${r.t}:${r.s}`)));
  await store.append(fresh);
  await store.saveAggregates(aggregator.state);
  io.stderr(`atlas: imported ${fresh.length} new span(s) (${records.length - fresh.length} already stored)\n`);
  const s = summary(graph, aggregator.state);
  if (cmd.json) io.stdout(`${JSON.stringify(s.json, null, 2)}\n`);
  else io.stdout(`${s.lines.join("\n")}\n`);
  return EXIT_OK;
}

export async function traceCommand(cmd: TraceCommand, io: CliIo, deps: TraceDeps = {}): Promise<number> {
  const workspace = path.resolve(io.cwd, cmd.dir ?? ".");
  if (cmd.importFile) return importFile(cmd, io, workspace);

  const graph = await loadOrAnalyze(io, workspace);
  const service = pickService(graph, cmd.service, io.cwd, workspace);

  // Receiver: ours, or the live owner's (another window / CLI) with the same per-workspace token.
  let session: RuntimeSession | undefined;
  let endpoint: string;
  const owner = await runtimeOwner(workspace);
  if (owner) {
    endpoint = new URL(`http://127.0.0.1:${owner.port}/v1/traces`).toString();
    io.stderr(`atlas: using the receiver of pid ${owner.pid} on port ${owner.port}\n`);
  } else {
    try {
      session = await RuntimeSession.start({ workspaceDir: workspace, ...(cmd.port !== undefined ? { port: cmd.port } : {}), onError: (e) => io.stderr(`atlas: receiver error: ${(e as Error).message}\n`) });
    } catch (error) {
      if (error instanceof RuntimeLockedError) throw new CliError({ code: error.code, problem: error.message, cause: "Two receivers cannot write the same .atlas/traces.", fix: "Stop the other process, or let it receive and run your app with its VM options." }, EXIT_USAGE);
      throw error;
    }
    endpoint = session.endpoint;
    io.stderr(`atlas: receiving traces on ${endpoint}\n`);
  }

  try {
    let lastPct = -1;
    const agentPath = await ensureJavaAgent({
      ...(cmd.agent ?? io.env["ATLAS_JAVAAGENT_PATH"] ? { explicitPath: path.resolve(io.cwd, (cmd.agent ?? io.env["ATLAS_JAVAAGENT_PATH"]) as string) } : {}),
      fetch: io.fetch,
      onProgress: ({ url, received, total }) => {
        const pct = total ? Math.floor((received / total) * 10) * 10 : -1;
        if (pct !== lastPct) io.stderr(`atlas: downloading javaagent from ${new URL(url).host} ${total ? `${pct}%` : `${(received / 1e6).toFixed(1)} MB`}\n`);
        lastPct = pct;
      },
    }).catch((error: unknown) => {
      if (error instanceof AgentDownloadError || error instanceof AgentIntegrityError) throw new CliError(error.toUserFacing(), EXIT_ANALYSIS);
      throw error;
    });

    const token = await workspaceToken(workspace);
    const { configPath } = await writeAgentConfigFile({ graph, service, workspace, endpoint, token });
    const files = { agentPath, configPath };

    if (cmd.printConfig || cmd.run.length === 0) {
      io.stdout(`${vmOptions(files)}\n`);
      io.stderr(`atlas: paste the line above into the VM options of your run configuration (IDEA: Run ▸ Edit Configurations ▸ Modify options ▸ Add VM options), start ${service.name}, send a request.\n`);
      if (!session) return EXIT_OK; // the owner keeps receiving
      io.stderr("atlas: waiting for spans… press Ctrl-C to stop and print the summary\n");
      await (deps.waitForInterrupt ?? defaultWaitForInterrupt)();
    } else {
      const commandText = cmd.run.join(" ");
      const launch = tracedLaunch(commandText, files, io.env);
      if (launch.conflict && !cmd.allowAgentConflict) {
        throw new CliError(
          { code: "ATLAS-E072", problem: `The command already loads another javaagent (${launch.conflict}).`, cause: "Two bytecode agents can interfere (SkyWalking, Arthas, other APMs).", fix: "Remove it for this run, or pass --allow-agent-conflict to load both." },
          EXIT_USAGE,
        );
      }
      io.stderr(`atlas: ${launch.launcher} → ${launch.command}${Object.keys(launch.env).length ? `  (JAVA_TOOL_OPTIONS set)` : ""}\n`);
      const code = await (deps.run ?? runTraced)(launch.command, launch.env, io.cwd, { stdoutToStderr: cmd.json, notice: (line) => io.stderr(`${line}\n`) });
      await new Promise((resolve) => setTimeout(resolve, deps.settleMs ?? 1500));
      if (!session) return code;
      const s = summary(graph, session.aggregator.state);
      if (cmd.json) io.stdout(`${JSON.stringify(s.json, null, 2)}\n`);
      else io.stderr(`${s.lines.join("\n")}\n`);
      return code;
    }
    if (session) {
      const s = summary(graph, session.aggregator.state);
      if (cmd.json) io.stdout(`${JSON.stringify(s.json, null, 2)}\n`);
      else io.stderr(`${s.lines.join("\n")}\n`);
    }
    return EXIT_OK;
  } finally {
    await session?.stop();
  }
}
