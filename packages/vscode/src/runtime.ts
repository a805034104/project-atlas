import * as vscode from "vscode";
import path from "node:path";
import {
  AgentDownloadError,
  AgentIntegrityError,
  applyOverlay,
  buildTraceData,
  buildTraceDetail,
  emptyAggregates,
  ensureJavaAgent,
  entrypointLabel,
  entrypointsForRouteKey,
  reconcile,
  RuntimeLockedError,
  RuntimeSession,
  serviceDir,
  traceableServices,
  TraceStore,
  tracedLaunch,
  vmOptions,
  writeAgentConfigFile,
  type AggregateState,
  type AtlasGraph,
  type RuntimeOverlay,
  type RuntimeState,
  type Service,
  type SpanRecord,
  type TraceDetailData,
  type UserFacingError,
} from "@project-atlas/core";
import type { AtlasController } from "./controller.js";
import { log } from "./log.js";
import { t } from "./settings.js";

/**
 * Local runtime capture inside VS Code (v0.2 R3).
 *
 *   copy VM options / launch with tracing ─▶ RuntimeSession (127.0.0.1, per-workspace token)
 *     ─▶ pinned javaagent (download with progress, sha256) ─▶ agent config (methods from the graph)
 *     ─▶ IDE run configuration (clipboard)   or   integrated terminal (env via TerminalOptions.env,
 *        command shown before it runs; no workspace file is written)
 *   spans ─▶ Aggregator ─(debounce 1 s)▶ reconcile ─▶ controller decorator ─▶ views / flows refetch
 *   status bar item (separate from analysis, hidden until first use) ─▶ Trace tab
 */

const UPDATE_DEBOUNCE_MS = 1000;
const NO_SPANS_HINT_MS = 60_000;

export class RuntimeManager implements vscode.Disposable {
  private session: RuntimeSession | undefined;
  private store: TraceStore;
  private aggregates: AggregateState = emptyAggregates();
  private overlay: { graph: AtlasGraph; overlay: RuntimeOverlay } | undefined;
  private updateTimer: NodeJS.Timeout | undefined;
  private noSpansTimer: NodeJS.Timeout | undefined;
  private announced = new Set<string>();
  private readonly status: vscode.StatusBarItem;
  private readonly stateChanged = new vscode.EventEmitter<RuntimeState>();
  private readonly updated = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  state: RuntimeState;

  readonly onDidChangeState = this.stateChanged.event;
  /** Observed stats changed: visible views should refetch. */
  readonly onDidUpdate = this.updated.event;

  constructor(
    private readonly controller: AtlasController,
    private readonly openTraceTab: () => void,
  ) {
    this.state = { status: "off", spans: 0, duplicates: 0, rejected: 0, trusted: vscode.workspace.isTrusted };
    this.store = new TraceStore(path.join(controller.atlasDir, "traces"));
    this.status = vscode.window.createStatusBarItem("atlas.runtime", vscode.StatusBarAlignment.Left, 99);
    this.status.name = t("Atlas 运行时追踪", "Atlas runtime tracing");
    this.status.command = "atlas.openTraceTab";
    this.disposables.push(
      this.status,
      this.stateChanged,
      this.updated,
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.setState({ trusted: true })),
      controller.onDidChangeGraph(() => this.scheduleUpdate(0)),
    );
    controller.setRuntimeDecorator({
      decorate: (graph) => this.decorated(graph),
      traceData: (graph) => this.traceData(graph),
    });
  }

  /** Load traces recorded earlier (history) without starting a receiver. */
  async restore(): Promise<void> {
    this.aggregates = await this.store.loadAggregates();
    if (this.aggregates.total > 0) this.scheduleUpdate(0);
  }

  private setState(patch: { [K in keyof RuntimeState]?: RuntimeState[K] | undefined }): void {
    const next = { ...this.state, ...patch } as RuntimeState & Record<string, unknown>;
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
    this.state = next;
    this.stateChanged.fire(this.state);
    this.renderStatus();
  }

  private renderStatus(): void {
    const s = this.state;
    if (s.status === "off" && s.spans === 0) {
      this.status.hide();
      return;
    }
    const pct = s.agent?.total ? ` ${Math.floor((s.agent.received / s.agent.total) * 100)}%` : "";
    this.status.text =
      s.status === "downloading"
        ? `$(cloud-download) Agent${pct}`
        : s.status === "waiting"
          ? `$(debug-start) ${t("等待请求", "Waiting for requests")}`
          : s.status === "receiving"
            ? `$(pulse) ${s.spans} spans${s.rejected ? ` · ${s.rejected} ${t("已拒绝", "rejected")}` : ""}`
            : s.status === "error"
              ? `$(error) ${t("追踪接收器", "Trace receiver")}`
              : s.status === "starting"
                ? `$(loading~spin) ${t("追踪", "Tracing")}`
                : `$(debug-disconnect) ${s.spans} spans`;
    this.status.tooltip = [
      s.port ? `127.0.0.1:${s.port}` : t("接收器未运行", "Receiver not running"),
      s.since ? `${t("开始于", "since")} ${new Date(s.since).toLocaleTimeString()}` : "",
      s.error ? `${s.error.code} ${s.error.problem}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    this.status.backgroundColor = s.status === "error" ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined;
    this.status.show();
  }

  private fail(error: UserFacingError): never {
    this.setState({ status: "error", error });
    throw Object.assign(new Error(error.problem), { userFacing: error });
  }

  private requireTrust(): void {
    if (vscode.workspace.isTrusted) return;
    this.fail({ code: "ATLAS-E073", problem: t("受限模式下不能启动追踪。", "Tracing is disabled in Restricted Mode."), cause: t("启动命令来自仓库内容。", "Launch commands come from repository content."), fix: t("信任此工作区后重试。", "Trust this workspace, then retry."), docsUrl: "" });
  }

  private enabled(): boolean {
    return vscode.workspace.getConfiguration("atlas").get<boolean>("runtime.enabled", true);
  }

  async ensureSession(): Promise<RuntimeSession> {
    this.requireTrust();
    if (!this.enabled()) this.fail({ code: "ATLAS-E073", problem: t("运行时追踪已关闭。", "Runtime tracing is turned off."), cause: "atlas.runtime.enabled = false", fix: t("在设置里打开 atlas.runtime.enabled。", "Enable atlas.runtime.enabled in Settings."), docsUrl: "" });
    if (this.session) return this.session;
    this.setState({ status: "starting", error: undefined });
    try {
      this.session = await RuntimeSession.start({
        workspaceDir: this.controller.workspaceRoot.fsPath,
        port: vscode.workspace.getConfiguration("atlas").get<number>("runtime.port", 43180),
        onSpans: (fresh, state) => this.onSpans(fresh, state),
        onError: (error) => log(`trace receiver: ${(error as Error).message}`),
      });
    } catch (error) {
      if (error instanceof RuntimeLockedError) {
        this.fail({ code: error.code, problem: error.message, cause: t("CLI（project-atlas trace）或另一个窗口正在接收。", "The CLI (project-atlas trace) or another window is receiving."), fix: t("停止那个进程后重试；它记录的追踪在这里会作为历史显示。", "Stop it and retry; what it recorded shows here as history."), docsUrl: "" });
      }
      this.fail({ code: "ATLAS-E074", problem: t("追踪接收器启动失败。", "The trace receiver did not start."), cause: (error as Error).message, fix: t("在设置里换一个 atlas.runtime.port。", "Pick another atlas.runtime.port in Settings."), docsUrl: "" });
    }
    this.aggregates = this.session.aggregator.state;
    this.setState({ status: "waiting", port: this.session.port, since: Date.now() });
    log(`trace receiver listening on ${this.session.endpoint}`);
    return this.session;
  }

  private async ensureAgent(): Promise<string> {
    const explicit = vscode.workspace.getConfiguration("atlas").get<string>("runtime.javaagentPath", "");
    try {
      return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t("准备 OpenTelemetry javaagent", "Preparing the OpenTelemetry javaagent"), cancellable: true }, async (progress, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        let last = 0;
        const agent = await ensureJavaAgent({
          ...(explicit ? { explicitPath: explicit } : {}),
          signal: abort.signal,
          onProgress: ({ url, received, total }) => {
            this.setState({ status: "downloading", agent: { received, ...(total ? { total } : {}), source: new URL(url).host } });
            if (total) {
              const pct = (received / total) * 100;
              progress.report({ increment: pct - last, message: `${new URL(url).host} ${(received / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB` });
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
    const pick = await vscode.window.showQuickPick(
      services.map((s) => ({ label: s.name, description: s.path || ".", service: s })),
      { title: t("选择要追踪的服务", "Service to trace") },
    );
    return pick?.service;
  }

  private async prepare(serviceId?: string): Promise<{ service: Service; agentPath: string; configPath: string } | undefined> {
    const graph = this.controller.graph;
    if (!graph) {
      void vscode.window.showInformationMessage(t("先运行一次分析。", "Run the analysis first."));
      return undefined;
    }
    const service = await this.pickService(graph, serviceId);
    if (!service) return undefined;
    const session = await this.ensureSession();
    const agentPath = await this.ensureAgent();
    const { configPath, methods, classes } = await writeAgentConfigFile({ graph, service, workspace: this.controller.workspaceRoot.fsPath, endpoint: session.endpoint, token: session.token });
    log(`agent config for ${service.name}: ${classes} classes, ${methods} methods → ${configPath}`);
    this.armNoSpansHint();
    return { service, agentPath, configPath };
  }

  /** "Copy VM options": the primary, IDE-agnostic path (IDEA / Eclipse / java -jar / scripts). */
  async copyVmOptions(serviceId?: string): Promise<void> {
    const prepared = await this.prepare(serviceId);
    if (!prepared) return;
    const options = vmOptions(prepared);
    await vscode.env.clipboard.writeText(options);
    const open = t("打开 Trace 标签页", "Open Trace tab");
    const pick = await vscode.window.showInformationMessage(
      t(`已复制 ${prepared.service.name} 的 VM 参数。粘贴到 IDEA 运行配置（Modify options ▸ Add VM options）后重启服务，再发一个请求。`, `VM options for ${prepared.service.name} copied. Paste them into your run configuration (IDEA: Modify options ▸ Add VM options), restart the service and send a request.`),
      open,
    );
    if (pick === open) this.openTraceTab();
  }

  /** "Launch with tracing": integrated terminal, env injected per launcher, no file written. */
  async launch(serviceId?: string): Promise<void> {
    const graph = this.controller.graph;
    const prepared = await this.prepare(serviceId);
    if (!prepared || !graph) return;
    const commands = graph.startup
      .filter((g) => g.serviceId === prepared.service.id || g.target === prepared.service.name)
      .flatMap((g) => g.steps.map((s) => s.command))
      .filter((c) => /\b(java|mvnw?|gradlew?|sh|bash)\b/.test(c) && !/\b(install|package|clean)\b/.test(c));
    const custom = t("输入其他命令…", "Another command…");
    const pick = await vscode.window.showQuickPick([...new Set(commands)].map((c) => ({ label: c })).concat([{ label: custom }]), { title: t(`如何启动 ${prepared.service.name}`, `How to start ${prepared.service.name}`) });
    if (!pick) return;
    const command = pick.label === custom ? await vscode.window.showInputBox({ prompt: t("启动命令（在服务目录执行）", "Start command (run in the service directory)"), value: "mvn spring-boot:run" }) : pick.label;
    if (!command) return;
    const launch = tracedLaunch(command, prepared, process.env);
    if (launch.conflict) {
      const both = t("仍然叠加", "Load both");
      const answer = await vscode.window.showWarningMessage(t(`命令里已经有另一个 javaagent（${launch.conflict}），两个 agent 可能互相干扰。`, `The command already loads another javaagent (${launch.conflict}); two agents can interfere.`), { modal: true }, both);
      if (answer !== both) return;
    }
    const cwd = serviceDir(graph, prepared.service);
    const run = t("运行", "Run");
    const detail = [
      `${t("命令", "Command")}: ${launch.command}`,
      ...Object.entries(launch.env).map(([k, v]) => `${k}=${v}`),
      `${t("目录", "Directory")}: ${cwd ?? "."}`,
      t("不会修改工作区里的任何文件。", "No workspace file is modified."),
    ].join("\n");
    const ok = await vscode.window.showInformationMessage(t("带追踪启动", "Launch with tracing"), { modal: true, detail }, run);
    if (ok !== run) return;
    const terminal = vscode.window.createTerminal({ name: `Atlas ▶ ${prepared.service.name}`, ...(cwd ? { cwd } : {}), env: launch.env });
    terminal.show();
    terminal.sendText(launch.command);
    this.openTraceTab();
  }

  async stop(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (this.noSpansTimer) clearTimeout(this.noSpansTimer);
    await session?.stop();
    this.setState({ status: "off", port: undefined, agent: undefined });
  }

  async clear(): Promise<void> {
    const yes = t("清除", "Clear");
    if ((await vscode.window.showWarningMessage(t("删除本工作区记录的所有追踪？", "Delete every trace recorded for this workspace?"), { modal: true }, yes)) !== yes) return;
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
      void vscode.window.showWarningMessage(
        t(
          "60 秒内没有收到 span（ATLAS-W033）：确认服务输出里有 OpenTelemetry agent 的启动日志、VM 参数已生效、127.0.0.1 没有被代理（http.nonProxyHosts）。",
          "No spans within 60 s (ATLAS-W033): check the service log shows the OpenTelemetry agent starting, the VM options are applied, and 127.0.0.1 is not proxied (http.nonProxyHosts).",
        ),
      );
    }, NO_SPANS_HINT_MS);
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
      const open = t("打开流转", "Open flow");
      void vscode.window.showInformationMessage(`${t("已观测", "Observed")} ${entrypointLabel(ep)} · ${Math.round(r.dur)} ms`, open).then((pick) => {
        if (pick === open) void vscode.commands.executeCommand("atlas.openPanel", { view: "flow", nodeId: ep.id });
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
    void this.session?.stop();
    for (const d of this.disposables) d.dispose();
  }
}
