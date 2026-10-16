import path from "node:path";
import type { AtlasGraph, Service } from "../model/types.js";
import type { RuntimeState, TraceDetailData, UserFacingError } from "../protocol.js";
import { AgentDownloadError, AgentIntegrityError, ensureJavaAgent } from "../runtime/agent-fetch.js";
import { emptyAggregates, type AggregateState } from "../runtime/aggregate.js";
import { serviceDir, traceableServices, writeAgentConfigFile } from "../runtime/prepare.js";
import { tracedLaunch, vmOptions } from "../runtime/launch.js";
import { applyOverlay, entrypointsForRouteKey, reconcile, type RuntimeOverlay } from "../runtime/match.js";
import { RuntimeLockedError, RuntimeSession } from "../runtime/session.js";
import type { SpanRecord } from "../runtime/span-record.js";
import { TraceStore } from "../runtime/store.js";
import { buildTraceData, buildTraceDetail } from "../runtime/trace-view.js";
import { entrypointLabel } from "../overrides/apply.js";
import type { AnalysisController } from "./analysis.js";
import { Emitter } from "./emitter.js";
import { translator, type HostEnv } from "./env.js";

/**
 * Local runtime capture for a host (v0.2 R3), shared by the extension and the web app.
 *
 *   copy VM options / launch with tracing ─▶ RuntimeSession (127.0.0.1, per-workspace token)
 *     ─▶ pinned javaagent (download with progress, sha256) ─▶ agent config (methods from the graph)
 *     ─▶ clipboard (IDE run configuration)  or  host terminal (env injected; no workspace file written)
 *   spans ─▶ Aggregator ─(debounce 1 s)▶ reconcile ─▶ controller decorator ─▶ views / flows refetch
 */

const UPDATE_DEBOUNCE_MS = 1000;
const NO_SPANS_HINT_MS = 60_000;

/** Thrown for failures the UI shows as an error panel. */
export class RuntimeActionError extends Error {
  constructor(readonly userFacing: UserFacingError) {
    super(userFacing.problem);
  }
}

export interface RuntimeHostOptions {
  env: HostEnv;
  controller: AnalysisController;
  workspaceDir: string;
}

export class RuntimeHost {
  private session: RuntimeSession | undefined;
  private readonly store: TraceStore;
  private aggregates: AggregateState = emptyAggregates();
  private overlay: { graph: AtlasGraph; overlay: RuntimeOverlay } | undefined;
  private updateTimer: ReturnType<typeof setTimeout> | undefined;
  private noSpansTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly announced = new Set<string>();
  private readonly stateChanged = new Emitter<RuntimeState>();
  private readonly updated = new Emitter<void>();
  private readonly env: HostEnv;
  private readonly controller: AnalysisController;
  private readonly workspaceDir: string;
  private readonly t: (zh: string, en: string) => string;
  private readonly disposeGraphListener: { dispose(): void };
  state: RuntimeState;

  readonly onDidChangeState = this.stateChanged.event;
  /** Observed stats changed: visible views should refetch. */
  readonly onDidUpdate = this.updated.event;

  constructor(options: RuntimeHostOptions) {
    this.env = options.env;
    this.controller = options.controller;
    this.workspaceDir = options.workspaceDir;
    this.t = translator(options.env);
    this.state = { status: "off", spans: 0, duplicates: 0, rejected: 0, trusted: this.env.trusted() };
    this.store = new TraceStore(path.join(this.controller.atlasDir, "traces"));
    this.disposeGraphListener = this.controller.onDidChangeGraph(() => this.scheduleUpdate(0));
    this.controller.setRuntimeDecorator({ decorate: (graph) => this.decorated(graph), traceData: (graph) => this.traceData(graph) });
  }

  get running(): boolean {
    return this.session !== undefined;
  }

  /** Load traces recorded earlier (history) without starting a receiver. */
  async restore(): Promise<void> {
    this.aggregates = await this.store.loadAggregates();
    if (this.aggregates.total > 0) this.scheduleUpdate(0);
  }

  /** The host's trust changed (VS Code workspace trust granted, web import flag). */
  trustChanged(): void {
    this.setState({ trusted: this.env.trusted() });
  }

  private setState(patch: { [K in keyof RuntimeState]?: RuntimeState[K] | undefined }): void {
    const next = { ...this.state, ...patch } as RuntimeState & Record<string, unknown>;
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
    this.state = next;
    this.stateChanged.fire(this.state);
  }

  private fail(error: UserFacingError): never {
    this.setState({ status: "error", error });
    throw new RuntimeActionError(error);
  }

  private requireTrust(): void {
    if (this.env.trusted()) return;
    const t = this.t;
    this.fail({ code: "ATLAS-E073", problem: t("未信任的工作区不能启动追踪。", "Tracing is disabled for an untrusted workspace."), cause: t("启动命令来自仓库内容。", "Launch commands come from repository content."), fix: t("信任此工作区后重试。", "Trust this workspace, then retry."), docsUrl: "" });
  }

  async ensureSession(): Promise<RuntimeSession> {
    const t = this.t;
    this.requireTrust();
    const settings = this.env.settings().runtime;
    if (!settings.enabled) this.fail({ code: "ATLAS-E073", problem: t("运行时追踪已关闭。", "Runtime tracing is turned off."), cause: "atlas.runtime.enabled = false", fix: t("在设置里打开运行时追踪。", "Enable runtime tracing in Settings."), docsUrl: "" });
    if (this.session) return this.session;
    this.setState({ status: "starting", error: undefined });
    try {
      this.session = await RuntimeSession.start({
        workspaceDir: this.workspaceDir,
        atlasDir: this.controller.atlasDir,
        port: settings.port,
        onSpans: (fresh, state) => this.onSpans(fresh, state),
        onError: (error) => this.env.log(`trace receiver: ${(error as Error).message}`),
      });
    } catch (error) {
      if (error instanceof RuntimeLockedError) {
        this.fail({ code: error.code, problem: error.message, cause: t("CLI（project-atlas trace）或另一个窗口正在接收。", "The CLI (project-atlas trace) or another window is receiving."), fix: t("停止那个进程后重试；它记录的追踪在这里会作为历史显示。", "Stop it and retry; what it recorded shows here as history."), docsUrl: "" });
      }
      this.fail({ code: "ATLAS-E074", problem: t("追踪接收器启动失败。", "The trace receiver did not start."), cause: (error as Error).message, fix: t("在设置里换一个运行时端口。", "Pick another runtime port in Settings."), docsUrl: "" });
    }
    this.aggregates = this.session.aggregator.state;
    this.setState({ status: "waiting", port: this.session.port, since: Date.now() });
    this.env.log(`trace receiver listening on ${this.session.endpoint}`);
    return this.session;
  }

  private async ensureAgent(): Promise<string> {
    const explicit = this.env.settings().runtime.javaagentPath;
    try {
      return await this.env.progress(this.t("准备 OpenTelemetry javaagent", "Preparing the OpenTelemetry javaagent"), async (progress) => {
        const abort = new AbortController();
        progress.onCancel(() => abort.abort());
        let last = 0;
        const agent = await ensureJavaAgent({
          ...(explicit ? { explicitPath: explicit } : {}),
          signal: abort.signal,
          onProgress: ({ url, received, total }) => {
            this.setState({ status: "downloading", agent: { received, ...(total ? { total } : {}), source: new URL(url).host } });
            if (total) {
              const pct = (received / total) * 100;
              progress.report(`${new URL(url).host} ${(received / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`, pct - last);
              last = pct;
            }
          },
        });
        this.setState({ status: this.state.spans > 0 ? "receiving" : "waiting", agent: undefined });
        return agent;
      });
    } catch (error) {
      if (error instanceof AgentDownloadError || error instanceof AgentIntegrityError) this.fail(error.toUserFacing());
      throw error;
    }
  }

  private async pickService(graph: AtlasGraph, serviceId?: string): Promise<Service | undefined> {
    const services = traceableServices(graph);
    if (serviceId) return services.find((s) => s.id === serviceId);
    if (services.length <= 1) return services[0];
    const picked = await this.env.choose({ title: this.t("选择要追踪的服务", "Service to trace"), many: false, items: services.map((s) => ({ id: s.id, label: s.name, description: s.path || "." })) });
    return services.find((s) => s.id === picked?.[0]);
  }

  private async prepare(serviceId?: string): Promise<{ service: Service; agentPath: string; configPath: string } | undefined> {
    const graph = this.controller.graph;
    if (!graph) {
      void this.env.notify("info", this.t("先运行一次分析。", "Run the analysis first."));
      return undefined;
    }
    const service = await this.pickService(graph, serviceId);
    if (!service) return undefined;
    const session = await this.ensureSession();
    const agentPath = await this.ensureAgent();
    const { configPath, methods, classes } = await writeAgentConfigFile({ graph, service, workspace: this.workspaceDir, endpoint: session.endpoint, token: session.token });
    this.env.log(`agent config for ${service.name}: ${classes} classes, ${methods} methods → ${configPath}`);
    this.armNoSpansHint();
    return { service, agentPath, configPath };
  }

  /** "Copy VM options": the primary, IDE-agnostic path (IDEA / Eclipse / java -jar / scripts). Returns the options. */
  async copyVmOptions(serviceId?: string): Promise<string | undefined> {
    const prepared = await this.prepare(serviceId);
    if (!prepared) return undefined;
    const options = vmOptions(prepared);
    await this.env.clipboard(options);
    const open = this.t("打开 Trace 标签页", "Open Trace tab");
    void this.env
      .notify(
        "info",
        this.t(`已复制 ${prepared.service.name} 的 VM 参数。粘贴到 IDEA 运行配置（Modify options ▸ Add VM options）后重启服务，再发一个请求。`, `VM options for ${prepared.service.name} copied. Paste them into your run configuration (IDEA: Modify options ▸ Add VM options), restart the service and send a request.`),
        [open],
      )
      .then((pick) => pick === open && this.env.reveal("trace"));
    return options;
  }

  /** "Launch with tracing": a host terminal, env injected per launcher, no file written. */
  async launch(serviceId?: string): Promise<void> {
    const t = this.t;
    const runInTerminal = this.env.runInTerminal;
    if (!runInTerminal) return void (await this.copyVmOptions(serviceId));
    const graph = this.controller.graph;
    const prepared = await this.prepare(serviceId);
    if (!prepared || !graph) return;
    const commands = graph.startup
      .filter((g) => g.serviceId === prepared.service.id || g.target === prepared.service.name)
      .flatMap((g) => g.steps.map((s) => s.command))
      .filter((c) => /\b(java|mvnw?|gradlew?|sh|bash)\b/.test(c) && !/\b(install|package|clean)\b/.test(c));
    const custom = "\u0000custom";
    const picked = await this.env.choose({ title: t(`如何启动 ${prepared.service.name}`, `How to start ${prepared.service.name}`), many: false, items: [...new Set(commands)].map((c) => ({ id: c, label: c })).concat([{ id: custom, label: t("输入其他命令…", "Another command…") }]) });
    if (!picked?.[0]) return;
    const command = picked[0] === custom ? await this.env.input({ prompt: t("启动命令（在服务目录执行）", "Start command (run in the service directory)"), value: "mvn spring-boot:run" }) : picked[0];
    if (!command) return;
    const launch = tracedLaunch(command, prepared, process.env);
    if (launch.conflict && !(await this.env.confirm({ message: t(`命令里已经有另一个 javaagent（${launch.conflict}），两个 agent 可能互相干扰。`, `The command already loads another javaagent (${launch.conflict}); two agents can interfere.`), action: t("仍然叠加", "Load both") }))) return;
    const cwd = serviceDir(graph, prepared.service);
    const detail = [`${t("命令", "Command")}: ${launch.command}`, ...Object.entries(launch.env).map(([k, v]) => `${k}=${v}`), `${t("目录", "Directory")}: ${cwd ?? "."}`, t("不会修改工作区里的任何文件。", "No workspace file is modified.")].join("\n");
    if (!(await this.env.confirm({ message: t("带追踪启动", "Launch with tracing"), detail, action: t("运行", "Run") }))) return;
    runInTerminal({ name: `Atlas ▶ ${prepared.service.name}`, command: launch.command, ...(cwd ? { cwd } : {}), env: launch.env });
    this.env.reveal("trace");
  }

  async stop(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (this.noSpansTimer) clearTimeout(this.noSpansTimer);
    await session?.stop();
    this.setState({ status: "off", port: undefined, agent: undefined });
  }

  async clear(): Promise<void> {
    if (!(await this.env.confirm({ message: this.t("删除本工作区记录的所有追踪？", "Delete every trace recorded for this workspace?"), action: this.t("清除", "Clear") }))) return;
    // One writer: while a session runs, clear through its store (same write queue) and reset
    // its aggregator (including the join windows and trace index, or cleared traces reappear).
    await (this.session?.store ?? this.store).clear();
    this.aggregates = emptyAggregates();
    if (this.session) {
      this.session.aggregator.reset();
      this.aggregates = this.session.aggregator.state;
    }
    this.announced.clear();
    this.setState({ spans: 0, duplicates: 0 });
    this.scheduleUpdate(0);
  }

  private armNoSpansHint(): void {
    if (this.noSpansTimer) clearTimeout(this.noSpansTimer);
    const before = this.state.spans;
    this.noSpansTimer = setTimeout(() => {
      if (this.state.spans > before || !this.session) return;
      void this.env.notify(
        "warning",
        this.t(
          "60 秒内没有收到 span（ATLAS-W033）：确认服务输出里有 OpenTelemetry agent 的启动日志、VM 参数已生效、127.0.0.1 没有被代理（http.nonProxyHosts）。",
          "No spans within 60 s (ATLAS-W033): check the service log shows the OpenTelemetry agent starting, the VM options are applied, and 127.0.0.1 is not proxied (http.nonProxyHosts).",
        ),
      );
    }, NO_SPANS_HINT_MS);
    this.noSpansTimer.unref?.();
  }

  private onSpans(fresh: SpanRecord[], state: AggregateState): void {
    this.aggregates = state;
    const receiver = this.session?.status().receiver;
    this.setState({ status: "receiving", spans: state.total, duplicates: state.duplicates, rejected: Object.values(receiver?.rejected ?? {}).reduce((n, v) => n + (v ?? 0), 0), lastSpanAt: Date.now() });
    // First observation of an entrypoint in this session: tell the user where to look.
    const graph = this.controller.graph;
    for (const r of fresh) {
      if (r.p || r.kind !== "server" || !graph) continue;
      const ep = entrypointsForRouteKey(graph, `r:${r.svc}:${r.a.method ?? "ANY"} ${r.a.route ?? ""}`)?.[0];
      if (!ep || this.announced.has(ep.id)) continue;
      this.announced.add(ep.id);
      if (this.announced.size > 3) continue;
      const open = this.t("打开流转", "Open flow");
      void this.env.notify("info", `${this.t("已观测", "Observed")} ${entrypointLabel(ep)} · ${Math.round(r.dur)} ms`, [open]).then((pick) => {
        if (pick === open) this.env.reveal("flow", ep.id);
      });
    }
    this.scheduleUpdate(UPDATE_DEBOUNCE_MS);
  }

  private scheduleUpdate(delay: number): void {
    if (this.updateTimer) return;
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined;
      this.overlay = undefined;
      this.controller.invalidateRuntime();
      this.updated.fire();
    }, delay);
  }

  private overlayFor(graph: AtlasGraph): RuntimeOverlay {
    if (this.overlay?.graph !== graph) this.overlay = { graph, overlay: reconcile(graph, this.aggregates) };
    return this.overlay.overlay;
  }

  private decorated(graph: AtlasGraph): AtlasGraph {
    return this.aggregates.total > 0 ? applyOverlay(graph, this.overlayFor(graph)) : graph;
  }

  traceData(graph: AtlasGraph) {
    return buildTraceData(graph, this.aggregates, this.overlayFor(graph), this.state);
  }

  async traceDetail(traceId: string): Promise<TraceDetailData | undefined> {
    const graph = this.controller.graph;
    if (!graph || !/^[0-9a-f]{32}$/.test(traceId)) return undefined;
    return buildTraceDetail(graph, await (this.session?.store ?? this.store).traceRecords(traceId));
  }

  dispose(): void {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    if (this.noSpansTimer) clearTimeout(this.noSpansTimer);
    this.disposeGraphListener.dispose();
    void this.session?.stop();
    this.stateChanged.dispose();
    this.updated.dispose();
  }
}
