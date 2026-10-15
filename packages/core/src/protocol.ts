/**
 * Message protocol between the extension host (packages/vscode) and the
 * webview (packages/webview). Both sides import these types from core so the
 * contract cannot drift.
 *
 *   webview ── ready ───────────────▶ host
 *   webview ◀─ init(locale, state) ── host
 *   webview ── requestView(view) ───▶ host ─▶ GraphStore (sharded .atlas/graph)
 *   webview ◀─ viewData(view, data) ─ host
 *   webview ◀─ analysisState ──────── host   (pushed whenever it changes)
 *   webview ── openSource / runCommand / markEdgeWrong / copyText ──▶ host
 */

import type {
  CallEdge,
  Diagnostic,
  Entrypoint,
  Feature,
  Flow,
  FlowStep,
  LlmUsage,
  Module,
  ModuleHistory,
  Service,
  ServiceLink,
  SourceRef,
  StartupGuide,
  UnresolvedCall,
} from "./model/types.js";

export type ViewId = "overview" | "topology" | "modules" | "features" | "startup" | "flow" | "history" | "trace";

export type AnalysisPhase = "parse" | "rules" | "cross-service" | "history" | "ai";

export interface AnalysisState {
  status: "never" | "running" | "done" | "error" | "cancelled";
  /** Phases completed so far; views may render as soon as their phase is done. */
  completedPhases: AnalysisPhase[];
  currentPhase?: AnalysisPhase;
  /** 0..1 within the current phase. */
  progress?: number;
  /** Files changed since the last completed analysis (stale banner). */
  staleFiles: number;
  /** AI layer availability: "none" = no provider configured (deterministic map only). */
  ai: "none" | "pending-confirmation" | "declined" | "running" | "done" | "partial" | "error";
  error?: UserFacingError;
}

/** Error contract (spec DX Pass 3): problem + cause + fix + docs link. */
export interface UserFacingError {
  code: string;
  problem: string;
  cause: string;
  fix: string;
  docsUrl: string;
  /** Optional command the "fix" button runs, e.g. "atlas.configureProvider". */
  fixCommand?: string;
}

export interface OverviewData {
  projectName: string;
  stacks: string[];
  serviceCount: number;
  moduleCount: number;
  entrypointCount: number;
  coreFeatures: Feature[];
  /** Candidate features derived from entrypoints/modules when AI has not run. */
  candidateFeatures: { title: string; moduleIds: string[]; entrypointIds: string[] }[];
  primaryStartup?: StartupGuide;
  hotModules: { module: Module; commits90d: number }[];
  diagnostics: Diagnostic[];
  llmUsage: LlmUsage[];
}

export interface TopologyData {
  services: Service[];
  links: ServiceLink[];
  unresolvedCount: number;
}

export interface ModulesData {
  services: Service[];
  modules: Module[];
  commits90d: Record<string, number>;
}

export interface FeaturesData {
  features: Feature[];
  modules: Pick<Module, "id" | "name">[];
  entrypoints: Entrypoint[];
}

export interface StartupData {
  guides: StartupGuide[];
  /** Files that were inspected when no guide could be derived (empty-state context). */
  inspectedFiles: SourceRef[];
}

export interface FlowListData {
  services: Pick<Service, "id" | "name">[];
  entrypoints: Entrypoint[];
}

export interface FlowDetailData {
  entrypoint: Entrypoint;
  flow: Flow;
  steps: FlowStep[];
  edges: CallEdge[];
  services: Pick<Service, "id" | "name">[];
  unresolvedCalls: UnresolvedCall[];
}

export interface HistoryData {
  modules: Pick<Module, "id" | "name" | "serviceId">[];
  history: ModuleHistory[];
}

/** Local runtime capture (v0.2): receiver + agent state for the status bar and the Trace tab. */
export interface RuntimeState {
  status: "off" | "starting" | "downloading" | "waiting" | "receiving" | "error";
  port?: number;
  spans: number;
  duplicates: number;
  rejected: number;
  /** Agent download progress while status = downloading. */
  agent?: { received: number; total?: number; source: string };
  /** epoch ms of the last span received in this session */
  lastSpanAt?: number;
  /** Session start (epoch ms); traces older than this are history. */
  since?: number;
  error?: UserFacingError;
  /** False in Restricted Mode (Workspace Trust): launching and receiving are disabled. */
  trusted: boolean;
}

export interface TraceRow {
  traceId: string;
  /** epoch ms */
  start: number;
  durationMs: number;
  error: boolean;
  spans: number;
  services: string[];
  rootName?: string;
  entrypointId?: string;
  /** observed / instrumentable steps of the root entrypoint's flow */
  coverage?: { observed: number; instrumentable: number };
}

export interface TraceDiff {
  observedEntrypoints: number;
  totalEntrypoints: number;
  /** Runtime-only calls: drawn (same-class) or reachable through uninstrumented code. */
  runtimeOnly: { from: string; to: string; count: number; async: boolean; drawn: boolean }[];
  unmatched: { key: string; count: number; reason: string }[];
}

export interface TraceData {
  runtime: RuntimeState;
  traces: TraceRow[];
  diff: TraceDiff;
  /** Launchable services (Spring Boot) for the empty state. */
  services: Pick<Service, "id" | "name">[];
  /** A request that needs no login, for the "send a request" hint (e.g. GET /captchaImage). */
  suggestedRequest?: { method: string; url: string };
}

/** One span of a trace, matched to a static step when possible (waterfall rows). */
export interface TraceSpanView {
  spanId: string;
  parentSpanId?: string;
  name: string;
  layer?: string;
  stepId?: string;
  service: string;
  /** ms from the trace start */
  offsetMs: number;
  durationMs: number;
  error: boolean;
  async: boolean;
}

export interface TraceDetailData {
  traceId: string;
  start: number;
  entrypointId?: string;
  spans: TraceSpanView[];
}

export type ViewPayload =
  | { view: "overview"; data: OverviewData }
  | { view: "topology"; data: TopologyData }
  | { view: "modules"; data: ModulesData }
  | { view: "features"; data: FeaturesData }
  | { view: "startup"; data: StartupData }
  | { view: "flow"; data: FlowListData }
  | { view: "history"; data: HistoryData }
  | { view: "trace"; data: TraceData };

export type HostToWebview =
  | { type: "init"; locale: string; state: AnalysisState; showTopology: boolean }
  | { type: "analysisState"; state: AnalysisState }
  | { type: "viewData"; payload: ViewPayload }
  | { type: "flowDetail"; data: FlowDetailData }
  | { type: "reveal"; view: ViewId; nodeId?: string }
  | { type: "error"; error: UserFacingError }
  | { type: "runtimeState"; state: RuntimeState }
  /** New spans changed observed stats: refetch the visible view / flow. */
  | { type: "runtimeUpdated" }
  | { type: "traceDetail"; data: TraceDetailData };

export type WebviewCommand =
  | "atlas.analyze"
  | "atlas.analyzeIncremental"
  | "atlas.cancel"
  | "atlas.configureProvider"
  | "atlas.exportHtml"
  | "atlas.exportMarkdown"
  | "atlas.diagnose"
  | "atlas.runtime.copyVmOptions"
  | "atlas.runtime.launch"
  | "atlas.runtime.stop"
  | "atlas.runtime.clear";

export type WebviewToHost =
  | { type: "ready" }
  | { type: "requestView"; view: ViewId }
  | { type: "requestFlow"; entrypointId: string; depth?: number }
  | { type: "openSource"; ref: SourceRef }
  | { type: "runCommand"; command: WebviewCommand }
  | { type: "markEdgeWrong"; edgeId: string }
  | { type: "copyText"; text: string }
  | { type: "requestTrace"; traceId: string }
  /** Launch / copy VM options for one service (from the Startup view or the Trace empty state). */
  | { type: "runtimeAction"; action: "copyVmOptions" | "launch"; serviceId?: string };
