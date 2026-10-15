import type { AttrValue, RawResourceSpans, RawSpan } from "./otlp-decode.js";

/**
 * RawSpan ─▶ SpanRecord: the only span shape Atlas keeps.
 *
 * Attributes are whitelisted and normalised across semantic-convention
 * generations (code.namespace+code.function | code.function.name, db.sql.table |
 * db.collection.name, http.method | http.request.method …). SQL text, URLs with
 * query strings, status messages, headers and bodies never enter a SpanRecord;
 * DB span names are rebuilt from operation + table.
 */

export type SpanKindName = "unspecified" | "internal" | "server" | "client" | "producer" | "consumer";

export interface SpanAttrs {
  route?: string;
  method?: string;
  status?: number;
  /** Declaring class (CGLIB / proxy suffixes removed) and method name. */
  cls?: string;
  fn?: string;
  dbSystem?: string;
  dbOp?: string;
  dbTable?: string;
  msgSystem?: string;
  msgDest?: string;
  msgOp?: string;
  rpcService?: string;
  rpcMethod?: string;
  /** server.address[:port] of an outgoing call. */
  peer?: string;
  exc?: string;
  thread?: string;
}

export interface SpanRecord {
  /** traceId */
  t: string;
  /** spanId */
  s: string;
  /** parentSpanId */
  p?: string;
  svc: string;
  scope: string;
  name: string;
  kind: SpanKindName;
  /** Start, epoch milliseconds. */
  start: number;
  /** Duration, milliseconds. */
  dur: number;
  err: boolean;
  a: SpanAttrs;
}

const KINDS: SpanKindName[] = ["unspecified", "internal", "server", "client", "producer", "consumer"];

/** Spring/CGLIB/ByteBuddy proxy suffixes → the user class. JDK `$ProxyNN` has no user class. */
export function normalizeClassName(cls: string): string | undefined {
  if (/^(com\.sun\.proxy\.|jdk\.proxy\d*\.)?\$Proxy\d+$/.test(cls)) return undefined;
  return cls.replace(/\$\$(EnhancerBySpringCGLIB|SpringCGLIB|FastClassBySpringCGLIB|EnhancerByCGLIB|ByteBuddy)\$\$.*$/, "").replace(/\$\$\$?SpringCGLIB\$\$\d+$/, "");
}

function str(v: AttrValue | undefined): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "boolean") return String(v);
  return undefined;
}

function num(v: AttrValue | undefined): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return undefined;
}

/** Operation and table from SQL text, computed in memory only (the text itself is discarded). */
export function sqlSummary(sql: string): { op?: string; table?: string } {
  const s = sql.replace(/\/\*[\s\S]*?\*\//g, " ").trim();
  const op = /^\s*(select|insert|update|delete|merge|replace|call|with)\b/i.exec(s)?.[1]?.toUpperCase();
  const table =
    /\bfrom\s+([`"\[]?[\w.$]+[`"\]]?)/i.exec(s)?.[1] ?? /\binto\s+([`"\[]?[\w.$]+[`"\]]?)/i.exec(s)?.[1] ?? /^\s*update\s+([`"\[]?[\w.$]+[`"\]]?)/i.exec(s)?.[1];
  return { ...(op ? { op } : {}), ...(table ? { table: table.replace(/[`"[\]]/g, "") } : {}) };
}

function codeAttrs(a: Record<string, AttrValue>): { cls?: string; fn?: string } {
  const full = str(a["code.function.name"]);
  if (full && full.includes(".")) {
    const dot = full.lastIndexOf(".");
    // code.function.name = "com.x.Foo.bar" (new); some agents put only the method there.
    return { cls: full.slice(0, dot), fn: full.slice(dot + 1) };
  }
  const ns = str(a["code.namespace"]);
  const fn = str(a["code.function"]) ?? full;
  return { ...(ns ? { cls: ns } : {}), ...(fn ? { fn } : {}) };
}

export function toSpanRecord(span: RawSpan, service: string, scope: string): SpanRecord {
  const a = span.attributes;
  const kind = KINDS[span.kind] ?? "unspecified";
  const attrs: SpanAttrs = {};
  const set = <K extends keyof SpanAttrs>(k: K, v: SpanAttrs[K] | undefined) => {
    if (v !== undefined && v !== "") attrs[k] = v;
  };

  const code = codeAttrs(a);
  if (code.cls) set("cls", normalizeClassName(code.cls));
  set("fn", code.fn);
  set("route", str(a["http.route"]));
  set("method", str(a["http.request.method"]) ?? str(a["http.method"]));
  set("status", num(a["http.response.status_code"]) ?? num(a["http.status_code"]));

  const dbSystem = str(a["db.system.name"]) ?? str(a["db.system"]);
  if (dbSystem) {
    set("dbSystem", dbSystem);
    const statement = str(a["db.query.text"]) ?? str(a["db.statement"]);
    const parsed = statement ? sqlSummary(statement) : {};
    set("dbOp", (str(a["db.operation.name"]) ?? str(a["db.operation"]))?.toUpperCase() ?? parsed.op);
    // JDBC (agent 2.31.1): db.sql.table only on single-table statements; db.query.summary
    // ("SELECT sys_user sys_dept") when semconv opt-in is on; else parse the text in memory.
    const summary = str(a["db.query.summary"])?.split(/\s+/);
    set("dbTable", str(a["db.collection.name"]) ?? str(a["db.sql.table"]) ?? summary?.[1] ?? parsed.table);
  }
  set("msgSystem", str(a["messaging.system"]));
  set("msgDest", str(a["messaging.destination.name"]) ?? str(a["messaging.destination"]));
  set("msgOp", str(a["messaging.operation.type"]) ?? str(a["messaging.operation"]));
  set("rpcService", str(a["rpc.service"]));
  set("rpcMethod", str(a["rpc.method"]));
  const host = str(a["server.address"]) ?? str(a["net.peer.name"]);
  const port = num(a["server.port"]) ?? num(a["net.peer.port"]);
  if (host && (kind === "client" || kind === "producer")) set("peer", port ? `${host}:${port}` : host);
  set("exc", str(a["exception.type"]) ?? span.events.map((e) => str(e.attributes["exception.type"])).find((t) => t !== undefined));
  set("thread", str(a["thread.name"]));

  let name = span.name;
  if (attrs.dbSystem) name = [attrs.dbOp, attrs.dbTable].filter(Boolean).join(" ") || attrs.dbSystem;
  else if (kind === "client" && attrs.method) name = attrs.method;
  else if (kind === "server" && attrs.method) name = `${attrs.method} ${attrs.route ?? ""}`.trim();

  const startNs = span.startTimeUnixNano;
  const durNs = span.endTimeUnixNano > startNs ? span.endTimeUnixNano - startNs : 0n;
  const record: SpanRecord = {
    t: span.traceId,
    s: span.spanId,
    svc: service,
    scope,
    name: name.slice(0, 200),
    kind,
    start: Number(startNs / 1000n) / 1000,
    dur: Number(durNs / 1000n) / 1000,
    err: span.statusCode === 2 || (kind === "server" && (attrs.status ?? 0) >= 500),
    a: attrs,
  };
  if (span.parentSpanId) record.p = span.parentSpanId;
  return record;
}

/** JVMs of build tools that inherited JAVA_TOOL_OPTIONS (same service.name as the app). */
const BUILD_TOOL_JVM = /org\.codehaus\.plexus\.classworlds|GradleDaemon|GradleWorkerMain|GradleMain/;

/**
 * Flatten a decoded request into records (service from resource `service.name`).
 * Resource attributes are read here and dropped: only the service name survives.
 */
export function toSpanRecords(batch: readonly RawResourceSpans[]): SpanRecord[] {
  const out: SpanRecord[] = [];
  for (const rs of batch) {
    if (BUILD_TOOL_JVM.test(str(rs.resource["process.command_line"]) ?? "")) continue;
    const service = str(rs.resource["service.name"]) ?? "unknown_service";
    for (const ss of rs.scopeSpans) for (const span of ss.spans) out.push(toSpanRecord(span, service, ss.scope.name));
  }
  return out;
}
