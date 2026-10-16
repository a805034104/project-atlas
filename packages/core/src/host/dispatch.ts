import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SourceRef } from "../model/types.js";
import type { HostToWebview, WebviewCommand, WebviewToHost } from "../protocol.js";
import type { AnalysisController } from "./analysis.js";
import type { Disposable } from "./emitter.js";
import { translator, type HostEnv } from "./env.js";
import { addEdgeRemoval } from "./overrides-writer.js";
import { readSnippet, resolveInRoot } from "./source.js";
import { RuntimeActionError, type RuntimeHost } from "./runtime-host.js";

/**
 * One map view (VS Code panel, browser tab group for one project) ⇄ the shared host logic.
 *
 *   webview ── ready ─▶ init(locale, state, showTopology) + runtimeState, then queued pushes
 *           ── requestView / requestFlow / requestTrace ─▶ GraphView slices (never the whole graph)
 *           ── openSource ─▶ host editor (extension)    readSource ─▶ sourceSnippet (web)
 *           ── markEdgeWrong ─▶ <atlasDir>/overrides.yaml edges.remove ─▶ re-analyze prompt
 *           ── runCommand ─▶ allow-listed atlas.* commands only (host executes them)
 *   controller / runtime events ─▶ analysisState, init, runtimeState, runtimeUpdated
 */

export const ALLOWED_COMMANDS: ReadonlySet<WebviewCommand> = new Set([
  "atlas.analyze",
  "atlas.analyzeIncremental",
  "atlas.cancel",
  "atlas.configureProvider",
  "atlas.exportHtml",
  "atlas.exportMarkdown",
  "atlas.diagnose",
  "atlas.runtime.copyVmOptions",
  "atlas.runtime.launch",
  "atlas.runtime.stop",
  "atlas.runtime.clear",
]);

export interface HostSessionOptions {
  env: HostEnv;
  controller: AnalysisController;
  runtime?: RuntimeHost;
  /** Deliver a message to the webview(s). */
  post(message: HostToWebview): void;
  /** Execute an allow-listed command. */
  runCommand(command: WebviewCommand): Promise<void>;
  /** Extension: open an editor. Omitted on the web, where `readSource` serves snippets. */
  openSource?(absolutePath: string, line?: number): Promise<void>;
  /** Directories the host itself knows; source reads stay inside them (see source.ts). */
  sourceBounds?(): readonly string[];
  /** Hold pushes until the webview says `ready` (the extension's panel); the web replays snapshots instead. */
  bufferUntilReady?: boolean;
}

export class HostSession {
  private ready: boolean;
  private pending: HostToWebview[] = [];
  private readonly subscriptions: Disposable[] = [];
  private readonly t: (zh: string, en: string) => string;

  constructor(private readonly options: HostSessionOptions) {
    this.ready = !options.bufferUntilReady;
    this.t = translator(options.env);
    const { controller, runtime } = options;
    this.subscriptions.push(
      controller.onDidChangeState((state) => this.push({ type: "analysisState", state })),
      controller.onDidChangeGraph(() => this.push(this.initMessage())),
    );
    if (runtime) {
      this.subscriptions.push(
        runtime.onDidChangeState((state) => this.push({ type: "runtimeState", state })),
        runtime.onDidUpdate(() => this.push({ type: "runtimeUpdated" })),
      );
    }
  }

  initMessage(): HostToWebview {
    const { controller, env } = this.options;
    return { type: "init", locale: env.locale(), state: controller.state, showTopology: (controller.graph?.services.length ?? 0) > 1 };
  }

  /** What a freshly connected webview needs before anything else. */
  snapshot(): HostToWebview[] {
    const out: HostToWebview[] = [this.initMessage()];
    if (this.options.runtime) out.push({ type: "runtimeState", state: this.options.runtime.state });
    return out;
  }

  /** Push a message; held until `ready` when the session buffers. */
  send(message: HostToWebview): void {
    this.push(message);
  }

  private push(message: HostToWebview): void {
    if (!this.ready && message.type !== "init") {
      this.pending.push(message);
      return;
    }
    this.options.post(message);
  }

  /**
   * Handle one webview message. Replies (view data, flows, traces, snippets) are returned
   * so a request/response transport (web POST) can answer inline; they are not also posted.
   */
  async handle(message: WebviewToHost): Promise<HostToWebview[]> {
    const { controller, runtime } = this.options;
    switch (message.type) {
      case "ready": {
        this.ready = true;
        const replies = [...this.snapshot(), ...this.pending.splice(0)];
        return replies;
      }
      case "requestView": {
        const view = controller.view;
        return view ? [{ type: "viewData", payload: view.view(message.view) }] : [];
      }
      case "requestFlow": {
        const detail = controller.view?.flowDetail(message.entrypointId, message.depth);
        return detail ? [{ type: "flowDetail", data: detail }] : [];
      }
      case "requestTrace": {
        const detail = await runtime?.traceDetail(message.traceId);
        return detail ? [{ type: "traceDetail", data: detail }] : [];
      }
      case "readSource": {
        const roots = controller.graph?.project.roots ?? [];
        return [{ type: "sourceSnippet", data: await readSnippet(roots, message.ref, 20, undefined, this.options.sourceBounds?.()) }];
      }
      case "openSource":
        await this.openSource(message.ref);
        return [];
      case "runtimeAction": {
        if (!runtime) return [];
        try {
          if (message.action === "copyVmOptions") await runtime.copyVmOptions(message.serviceId);
          else await runtime.launch(message.serviceId);
        } catch (error) {
          if (error instanceof RuntimeActionError) return [{ type: "error", error: error.userFacing }];
          this.options.env.log(`runtime action failed: ${(error as Error).message}`);
        }
        return [];
      }
      case "runCommand":
        if (ALLOWED_COMMANDS.has(message.command)) await this.options.runCommand(message.command);
        return [];
      case "copyText":
        await this.options.env.clipboard(message.text);
        return [];
      case "markEdgeWrong":
        await this.markEdgeWrong(message.edgeId);
        return [];
      case "promptAnswer":
        // Answers are routed by the web host's prompt broker before dispatch.
        return [];
    }
  }

  private async openSource(ref: SourceRef): Promise<void> {
    const roots = this.options.controller.graph?.project.roots ?? [];
    const bounds = this.options.sourceBounds?.();
    if (!this.options.openSource) {
      this.options.post({ type: "sourceSnippet", data: await readSnippet(roots, ref, 20, undefined, bounds) });
      return;
    }
    const target = await resolveInRoot(roots, ref, undefined, bounds);
    if (!target) {
      this.options.env.log(`Cannot open ${ref.file}: missing, or outside the analyzed folders`);
      void this.options.env.notify("warning", this.t(`无法打开 ${ref.file}：文件不存在或不在分析的目录内`, `Cannot open ${ref.file}: it is missing or outside the analyzed folders`));
      return;
    }
    await this.options.openSource(target, ref.line);
  }

  private async markEdgeWrong(edgeId: string): Promise<void> {
    const { controller, env } = this.options;
    const graph = controller.graph;
    const edge = graph?.edges.find((e) => e.id === edgeId);
    if (!graph || !edge) return;
    const steps = new Map(graph.steps.map((s) => [s.id, s]));
    const from = steps.get(edge.from)?.symbol.fqn ?? edge.from;
    const to = steps.get(edge.to)?.symbol.fqn ?? edge.to;
    const file = path.join(controller.atlasDir, "overrides.yaml");
    const existing = await readFile(file, "utf8").catch(() => undefined);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, addEdgeRemoval(existing, from, to, `marked wrong ${new Date().toISOString().slice(0, 10)}`));
    env.log(`Edge marked wrong: ${from} → ${to}`);
    const reanalyze = this.t("重新分析", "Re-analyze");
    const pick = await env.notify("info", this.t("已记录到 .atlas/overrides.yaml（可提交到 git 与团队共享）", "Saved to .atlas/overrides.yaml (commit it to share with your team)"), [reanalyze]);
    if (pick === reanalyze) await this.options.runCommand("atlas.analyze");
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
  }
}
