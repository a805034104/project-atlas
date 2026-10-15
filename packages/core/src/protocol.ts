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

export type ViewId = "overview" | "topology" | "modules" | "features" | "startup" | "flow" | "history";

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

export type ViewPayload =
  | { view: "overview"; data: OverviewData }
  | { view: "topology"; data: TopologyData }
  | { view: "modules"; data: ModulesData }
  | { view: "features"; data: FeaturesData }
  | { view: "startup"; data: StartupData }
  | { view: "flow"; data: FlowListData }
  | { view: "history"; data: HistoryData };

export type HostToWebview =
  | { type: "init"; locale: string; state: AnalysisState; showTopology: boolean }
  | { type: "analysisState"; state: AnalysisState }
  | { type: "viewData"; payload: ViewPayload }
  | { type: "flowDetail"; data: FlowDetailData }
  | { type: "reveal"; view: ViewId; nodeId?: string }
  | { type: "error"; error: UserFacingError };

export type WebviewCommand =
  | "atlas.analyze"
  | "atlas.analyzeIncremental"
  | "atlas.cancel"
  | "atlas.configureProvider"
  | "atlas.exportHtml"
  | "atlas.exportMarkdown"
  | "atlas.diagnose";

export type WebviewToHost =
  | { type: "ready" }
  | { type: "requestView"; view: ViewId }
  | { type: "requestFlow"; entrypointId: string; depth?: number }
  | { type: "openSource"; ref: SourceRef }
  | { type: "runCommand"; command: WebviewCommand }
  | { type: "markEdgeWrong"; edgeId: string }
  | { type: "copyText"; text: string };
