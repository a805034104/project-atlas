import type { AtlasGraph, FlowLayer } from "../model/types.js";

/**
 * OpenTelemetry javaagent configuration derived from the static graph.
 *
 *   FlowSteps (filter | interceptor | aspect | controller | service) ─▶ methods.include
 *   + mybatis instrumentation on (mapper interfaces are JDK proxies: never listed)
 *   + endpoint / token / service name / fast batch export
 *
 * Written to a file outside the workspace and passed with
 * -Dotel.javaagent.configuration-file=… (no env-size limits, visible in diagnostics).
 */

export const JAVAAGENT_VERSION = "2.31.1";
export const JAVAAGENT_SHA256 = "bbf83c151b6400709e2f225bdd07a04f839d9d13b8b93464241333fd25d3e3ba";
export const JAVAAGENT_FILE = `opentelemetry-javaagent-${JAVAAGENT_VERSION}.jar`;
export const JAVAAGENT_URLS = [
  `https://repo1.maven.org/maven2/io/opentelemetry/javaagent/opentelemetry-javaagent/${JAVAAGENT_VERSION}/${JAVAAGENT_FILE}`,
  `https://maven.aliyun.com/repository/public/io/opentelemetry/javaagent/opentelemetry-javaagent/${JAVAAGENT_VERSION}/${JAVAAGENT_FILE}`,
];

const INSTRUMENTED_LAYERS = new Set<FlowLayer>(["filter", "interceptor", "aspect", "controller", "service"]);

export interface MethodIncludeOptions {
  /** Service ids to include (default: every service). */
  serviceIds?: readonly string[];
  /** Extra `pkg.Class[m1,m2]` entries / class names to drop (atlas.yaml runtime.methods). */
  include?: readonly string[];
  exclude?: readonly string[];
}

/** `com.x.Foo#bar(A,B)` → class + method; undefined for keys that are not plain Java methods. */
export function parseMethodKey(fqn: string): { cls: string; method: string } | undefined {
  const m = /^([\w$.]+)#([\w$]+)\(/.exec(fqn);
  return m ? { cls: m[1] as string, method: m[2] as string } : undefined;
}

/** Class → methods for `otel.instrumentation.methods.include`. */
export function instrumentedMethods(graph: AtlasGraph, options: MethodIncludeOptions = {}): Map<string, Set<string>> {
  const services = options.serviceIds ? new Set(options.serviceIds) : undefined;
  const excluded = new Set(options.exclude ?? []);
  const out = new Map<string, Set<string>>();
  const add = (cls: string, method: string) => {
    if (excluded.has(cls) || excluded.has(`${cls}#${method}`)) return;
    const set = out.get(cls) ?? new Set<string>();
    set.add(method);
    out.set(cls, set);
  };
  for (const step of graph.steps) {
    if (!INSTRUMENTED_LAYERS.has(step.layer)) continue;
    if (services && !services.has(step.serviceId)) continue;
    if (step.symbol.name.startsWith("@") && step.layer === "interceptor") continue; // @PreAuthorize marker shares the handler symbol
    const parsed = parseMethodKey(step.symbol.fqn);
    if (parsed) add(parsed.cls, parsed.method);
  }
  for (const entry of options.include ?? []) {
    const m = /^([\w$.]+)\[([\w$,\s]+)\]$/.exec(entry.trim());
    if (m) for (const method of (m[2] as string).split(",")) add(m[1] as string, method.trim());
  }
  return out;
}

export function formatMethodsInclude(methods: Map<string, Set<string>>): string {
  return [...methods.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cls, ms]) => `${cls}[${[...ms].sort().join(",")}]`)
    .join(";");
}

export interface AgentConfigInput {
  serviceName: string;
  endpoint: string;
  token: string;
  methodsInclude: string;
  /** User overrides, appended last (later keys win in the agent's properties parser). */
  extra?: Record<string, string>;
}

/** Java properties file text; values are escaped for `\`, `:`, `=` and newlines. */
export function buildAgentConfig(input: AgentConfigInput): string {
  const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([:=])/g, "\\$1");
  const props: [string, string][] = [
    ["otel.service.name", input.serviceName],
    ["otel.traces.exporter", "otlp"],
    ["otel.metrics.exporter", "none"],
    ["otel.logs.exporter", "none"],
    ["otel.exporter.otlp.protocol", "http/protobuf"],
    ["otel.exporter.otlp.traces.endpoint", input.endpoint],
    ["otel.exporter.otlp.traces.headers", `authorization=Bearer ${input.token}`],
    ["otel.traces.sampler", "always_on"],
    ["otel.bsp.schedule.delay", "500"],
    ["otel.bsp.max.queue.size", "8192"],
    ["otel.instrumentation.mybatis.enabled", "true"],
    ["otel.instrumentation.methods.include", input.methodsInclude],
    ...Object.entries(input.extra ?? {}),
  ];
  return `# atlas:generated v1 — ProjectAtlas runtime tracing (do not commit)\n${props.map(([k, v]) => `${k}=${esc(v)}`).join("\n")}\n`;
}
