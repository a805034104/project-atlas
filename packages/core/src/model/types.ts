/**
 * AtlasGraph v1 — the contract between the analysis engine, the extension
 * host, the webview, the CLI and the MCP server.
 *
 * Normative source: docs/spec.md「范围裁决 v1.2」>「评审修订 v1.1」> spec body.
 * Enum members that only later versions produce (go, python, mq, grpc, dubbo,
 * runtime-observed) are deliberately kept so v0.2+ never needs a schema bump.
 *
 *   entrypoint ──┐
 *                ▼
 *   steps[] (global call graph nodes) ◀── edges[] (global call graph)
 *                ▲
 *   flows[] = projection { entrypointId, stepIds, edgeIds }
 */

export const SCHEMA_VERSION = 1 as const;

export type Stack = "java-spring" | "vue" | "go" | "python";

export type Provenance = "static" | "framework-rule" | "ai-inferred" | "runtime-observed";

export interface Root {
  id: string;
  /** Absolute path on disk (realpath, deduplicated across multi-root workspaces). */
  path: string;
  kind: "workspace" | "clone";
  git?: { url?: string; ref?: string; head?: string; shallow?: boolean };
}

export interface SourceRef {
  rootId: string;
  /** Path relative to the root, always forward slashes. */
  file: string;
  line?: number;
}

export interface SymbolRef extends SourceRef {
  name: string;
  /** Fully-qualified name, e.g. `com.ruoyi.web.controller.system.SysUserController#list(SysUser)`. */
  fqn: string;
}

export interface Service {
  id: string;
  name: string;
  rootId: string;
  /** Path of the service within its root ("" for the root itself). */
  path: string;
  stack: Stack;
  kind: "backend" | "gateway" | "frontend" | "worker";
  evidence: SourceRef;
}

export type ServiceLinkKind = "http" | "gateway-route" | "mq" | "grpc" | "dubbo" | "frontend-proxy";

export interface ServiceLink {
  id: string;
  fromServiceId: string;
  toServiceId: string;
  kind: ServiceLinkKind;
  /** e.g. "GET /user/info/{}", "topic:order-created", "grpc:pkg.UserService/Get". */
  channel: string;
  fromStepId: string;
  toEntrypointId?: string;
  provenance: Provenance;
  confidence: number;
  evidence: SourceRef[];
  observed?: RuntimeStats;
}

export interface Module {
  id: string;
  serviceId: string;
  name: string;
  path: string;
  kind: "build-module" | "package" | "frontend-app" | "ai-grouped";
  summary?: string;
  dependsOn: string[];
  fileCount: number;
  loc: number;
}

export interface Feature {
  id: string;
  title: string;
  description: string;
  tier: "core" | "secondary";
  /** Evidence; at least one of moduleIds / entrypointIds must be non-empty. */
  moduleIds: string[];
  entrypointIds: string[];
}

export interface StartupGuide {
  target: string;
  serviceId?: string;
  prerequisites: { name: string; version?: string; evidence: SourceRef }[];
  steps: { command: string; cwd: string; evidence: SourceRef }[];
  ports: { port: number; evidence: SourceRef }[];
  configFiles: SourceRef[];
}

export type EntrypointKind =
  | "http"
  | "mq-consumer"
  | "scheduled"
  | "cli-main"
  | "frontend-route"
  | "websocket";

export interface Entrypoint {
  id: string;
  serviceId: string;
  kind: EntrypointKind;
  method?: string;
  /** Normalized path (see normalizeHttpPath). */
  path?: string;
  handler: SymbolRef;
}

export type FlowLayer =
  | "frontend"
  | "filter"
  | "interceptor"
  | "middleware"
  | "aspect"
  | "controller"
  | "service"
  | "repository"
  | "sql"
  | "external-http"
  | "mq"
  | "cache";

export interface FlowStep {
  id: string;
  serviceId: string;
  layer: FlowLayer;
  symbol: SymbolRef;
}

export interface CallEdge {
  id: string;
  from: string;
  to: string;
  /** Ordering among siblings that share `from` (e.g. filter chain order). */
  order: number;
  provenance: Provenance;
  /** 1 for static / framework-rule / runtime-observed; 0..1 for ai-inferred. */
  confidence: number;
  /** Required for ai-inferred edges and for multi-implementation branches. */
  rationale?: string;
  observed?: RuntimeStats;
}

export interface Flow {
  entrypointId: string;
  stepIds: string[];
  edgeIds: string[];
  /** True when the projection was cut at the default depth. */
  truncated: boolean;
}

export interface RuntimeStats {
  count: number;
  p50Ms: number;
  p95Ms: number;
  errorCount: number;
  /** UTC ISO-8601. */
  lastSeen: string;
  sampleTraceIds: string[];
}

export interface UnresolvedCall {
  fromStepId: string;
  /** Source text of the call expression, e.g. `HttpUtils.sendPost(url, body)`. */
  expression: string;
  reason: "unknown-receiver" | "dynamic-dispatch" | "unresolved-config" | "unknown-wrapper";
  at: SourceRef;
}

export interface CommitRecord {
  sha: string;
  /** UTC ISO-8601. */
  authorTime: string;
  author: string;
  message: string;
  added: number;
  deleted: number;
  files: string[];
}

export interface ModuleHistory {
  moduleId: string;
  commits: CommitRecord[];
  aiSummary?: string;
  /** Set when history is incomplete (shallow clone, not a git repo). */
  degraded?: "shallow" | "no-git";
}

export interface Diagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  at?: SourceRef;
}

export interface LlmUsage {
  provider: string;
  model: string;
  phase: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AtlasGraph {
  schemaVersion: typeof SCHEMA_VERSION;
  analyzerVersion: string;
  project: {
    name: string;
    roots: Root[];
    stacks: Stack[];
    /** UTC ISO-8601. */
    analyzedAt: string;
  };
  services: Service[];
  serviceLinks: ServiceLink[];
  modules: Module[];
  features: Feature[];
  startup: StartupGuide[];
  entrypoints: Entrypoint[];
  steps: FlowStep[];
  edges: CallEdge[];
  flows: Flow[];
  history: ModuleHistory[];
  unresolvedCalls: UnresolvedCall[];
  diagnostics: Diagnostic[];
  llmUsage: LlmUsage[];
}
