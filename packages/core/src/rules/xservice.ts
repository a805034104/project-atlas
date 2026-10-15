import { pushTo } from "../util/collections.js";
import type { GraphBuilder } from "../graph/builder.js";
import { normalizeHttpPath, stableId } from "../model/ids.js";
import type { Entrypoint, ServiceLink, SourceRef, SymbolRef } from "../model/types.js";
import { GATEWAY_ROUTE_PREFIXES, type FrontendApp, type JavaService } from "../workspace/detect.js";
import { antMatch } from "./ant.js";
import { hasAnnotation, type JavaIndex, type TypeRef } from "./java-index.js";
import type { FeignCallSite, RestCallSite } from "./spring.js";
import type { FrontendCall } from "./vue.js";

/**
 * Cross-service links (v0.1: HTTP family).
 *
 *   browser path ─▶ dev proxy (prefix, strip) ─▶ host:port ─▶ service
 *        └─ gateway? ─▶ route (Path predicates) ─▶ StripPrefix / RewritePath / PrefixPath
 *                       ─▶ lb://name ─▶ service ─▶ entrypoint (method + path match)
 *   Feign (name + mapping) / RestTemplate (http://name-or-host:port/path) ─▶ entrypoint
 *
 * Edges into the target are created per (hop, target entrypoint) so that a
 * shared gateway route never fans one caller out to every endpoint behind it.
 */

export interface GatewayRoute {
  id: string;
  uri: string;
  paths: string[];
  stripPrefix: number;
  rewrite?: { pattern: RegExp; replacement: string };
  prefixPath?: string;
  filterNames: string[];
  at: SourceRef;
}

export interface UpstreamHop {
  /** Steps that precede the backend chain for this entrypoint (frontend api fn, gateway hops). */
  stepIds: string[];
}

export interface XServiceResult {
  links: ServiceLink[];
  /** entrypointId → first resolved caller path (used to prepend the frontend lane to backend flows). */
  upstream: Map<string, UpstreamHop>;
}

export interface XServiceInput {
  java: readonly JavaService[];
  frontends: readonly FrontendApp[];
  indexes: ReadonlyMap<string, JavaIndex>;
  frontendCalls: ReadonlyMap<string, readonly FrontendCall[]>;
  feignCalls: readonly FeignCallSite[];
  restCalls: readonly RestCallSite[];
  /** controller step of each http entrypoint */
  handlers: ReadonlyMap<string, string>;
}

export function parseGatewayRoutes(svc: JavaService): GatewayRoute[] {
  const byIndex = new Map<string, ReturnType<typeof svc.config.list>>();
  GATEWAY_ROUTE_PREFIXES.forEach((prefix, p) => {
    for (const e of svc.config.list(prefix)) {
      const m = /routes\[(\d+)\]/i.exec(e.key);
      if (m) pushTo(byIndex, `${p}:${m[1]?.padStart(6, "0")}`, e);
    }
  });
  const defaultFilters = ["spring.cloud.gateway.default-filters", "spring.cloud.gateway.server.webflux.default-filters", "spring.cloud.gateway.server.webmvc.default-filters"]
    .flatMap((p) => svc.config.list(p))
    .map((e) => svc.config.resolve(e.value).value);
  const routes: GatewayRoute[] = [];
  for (const [, group] of [...byIndex.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const value = (suffix: RegExp) => group.find((e) => suffix.test(e.key.replace(/^.*routes\[\d+\]\./i, "")));
    const resolved = (s: string) => svc.config.resolve(s).value;
    const id = resolved(value(/^id$/i)?.value ?? "");
    const uri = resolved(value(/^uri$/i)?.value ?? "");
    const predicates = group.filter((e) => /\.predicates\[\d+\]$/i.test(e.key)).map((e) => resolved(e.value));
    const filters = [...defaultFilters, ...group.filter((e) => /\.filters\[\d+\]$/i.test(e.key)).map((e) => resolved(e.value))];
    const paths = predicates.filter((p) => /^Path\s*=/i.test(p)).flatMap((p) => p.replace(/^Path\s*=\s*/i, "").split(",").map((s) => s.trim()).filter(Boolean));
    const route: GatewayRoute = { id, uri, paths, stripPrefix: 0, filterNames: [], at: group[0]?.at ?? { rootId: svc.service.rootId, file: "" } };
    for (const f of filters) {
      const [name = "", args = ""] = f.split(/=(.*)/s).map((s) => s.trim());
      if (/^StripPrefix$/i.test(name)) route.stripPrefix = Number.parseInt(args, 10) || 0;
      else if (/^RewritePath$/i.test(name)) {
        // The replacement never contains a comma; the regex may (`{1,2}`): split on the LAST comma.
        const cut = args.lastIndexOf(",");
        const regex = cut < 0 ? args : args.slice(0, cut).trim();
        const replacement = cut < 0 ? "" : args.slice(cut + 1).trim();
        try {
          route.rewrite = { pattern: new RegExp(regex.replace(/\(\?<(\w+)>/g, "(?<$1>")), replacement: replacement.replace(/\$\\\{(\w+)\}/g, "$<$1>").replace(/\$\{(\w+)\}/g, "$<$1>") };
        } catch {
          // Java regex outside the JS-compatible subset: leave the path unchanged.
        }
      } else if (/^PrefixPath$/i.test(name)) route.prefixPath = args;
      else route.filterNames.push(name);
    }
    routes.push(route);
  }
  return routes;
}

export function applyRoute(route: GatewayRoute, path: string): string {
  let out = path;
  if (route.stripPrefix > 0) out = `/${out.split("/").filter(Boolean).slice(route.stripPrefix).join("/")}`;
  if (route.rewrite) out = out.replace(route.rewrite.pattern, route.rewrite.replacement);
  if (route.prefixPath) out = `${route.prefixPath}${out}`;
  return normalizeHttpPath(out);
}

/** Best entrypoint for a concrete call path: literal segments beat path variables; `{}` in the call only matches variables. */
/** HTTP entrypoints bucketed by service and segment count, with pre-split segments. */
export class EntrypointIndex {
  private readonly buckets = new Map<string, { e: Entrypoint; segs: string[] }[]>();
  constructor(entries: readonly Entrypoint[]) {
    for (const e of entries) {
      if (e.kind !== "http" || !e.path) continue;
      const segs = e.path.split("/").filter(Boolean);
      pushTo(this.buckets, `${e.serviceId}|${segs.length}`, { e, segs });
    }
  }
  candidates(serviceId: string, segmentCount: number): readonly { e: Entrypoint; segs: string[] }[] {
    return this.buckets.get(`${serviceId}|${segmentCount}`) ?? [];
  }
}

export function matchEntrypoint(entries: readonly Entrypoint[] | EntrypointIndex, serviceId: string, method: string, path: string): Entrypoint | undefined {
  const callSegments = path.split("/").filter(Boolean);
  const index = entries instanceof EntrypointIndex ? entries : new EntrypointIndex(entries);
  let best: Entrypoint | undefined;
  let bestScore = -1;
  for (const { e, segs } of index.candidates(serviceId, callSegments.length)) {
    if (e.method !== "ANY" && method !== "ANY" && e.method !== method) continue;
    // Spring precedence: path specificity (literal segments) first, then the exact method; ties break on id.
    let literals = 0;
    let ok = true;
    for (let i = 0; i < segs.length; i++) {
      const pattern = segs[i] as string;
      const actual = callSegments[i] as string;
      if (pattern === actual && !pattern.includes("⟨")) literals++;
      else if (pattern !== "{}") {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const score = literals * 4 + (e.method === method ? 2 : 0);
    if (score > bestScore || (score === bestScore && best !== undefined && e.id < best.id)) {
      best = e;
      bestScore = score;
    }
  }
  return best;
}

function parseUrl(url: string): { host: string; port?: number; path: string } | undefined {
  const m = /^(?:https?|lb):\/\/([^/:]+)(?::(\d+))?(\/.*)?$/i.exec(url.trim());
  if (!m) return undefined;
  const parsed: { host: string; port?: number; path: string } = { host: (m[1] ?? "").toLowerCase(), path: m[3] ?? "/" };
  if (m[2]) parsed.port = Number(m[2]);
  return parsed;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

export function linkServices(input: XServiceInput, graph: GraphBuilder): XServiceResult {
  const result: XServiceResult = { links: [], upstream: new Map() };
  const entries = new EntrypointIndex([...graph.entrypoints.values()]);
  const routeCache = new Map<string, GatewayRoute[]>();
  const routesOf = (svc: JavaService): GatewayRoute[] => {
    let routes = routeCache.get(svc.service.id);
    if (!routes) {
      routes = parseGatewayRoutes(svc);
      routeCache.set(svc.service.id, routes);
    }
    return routes;
  };
  const globalFilterCache = new Map<string, TypeRef[]>();
  const byName = new Map(input.java.map((j) => [j.service.name.toLowerCase(), j]));
  const serviceFor = (host: string, port: number | undefined): JavaService | undefined => {
    const named = byName.get(host);
    if (named) return named;
    if (!LOCAL_HOSTS.has(host) && port === undefined) return undefined;
    const candidates = input.java.filter((j) => j.port === (port ?? 80));
    return candidates.find((j) => j.service.kind === "gateway") ?? candidates[0];
  };

  const addLink = (from: string, to: string, kind: ServiceLink["kind"], channel: string, fromStepId: string, target: Entrypoint | undefined, evidence: SourceRef[], rationale?: string): void => {
    const link: ServiceLink = {
      id: stableId("link", "", `${from}|${to}|${kind}|${channel}|${fromStepId}`),
      fromServiceId: from,
      toServiceId: to,
      kind,
      channel,
      fromStepId,
      provenance: "framework-rule",
      confidence: 1,
      evidence,
    };
    if (target) link.toEntrypointId = target.id;
    if (rationale) link.rationale = rationale;
    result.links.push(link);
  };

  /** Per-target gateway hops: global filters, then the route (with its named filters). */
  const gatewayHops = (gateway: JavaService, route: GatewayRoute, target: Entrypoint): string[] => {
    const index = input.indexes.get(gateway.service.id);
    const hops: string[] = [];
    const typeStep = (ref: TypeRef, label: string) => {
      const m = ref.type.methods.find((x) => x.name === "filter" || x.name === "apply") ?? ref.type.methods[0];
      const symbol: SymbolRef = { rootId: ref.file.rootId, file: ref.file.relPath, line: m?.line ?? ref.type.line, name: label, fqn: ref.type.fqcn };
      return graph.step(gateway.service.id, gateway.service.name, "filter", `${ref.type.fqcn}@${target.id}`, symbol);
    };
    if (index) {
      let globals = globalFilterCache.get(gateway.service.id);
      if (!globals) {
        globals = [...index.beansImplementing("GlobalFilter")];
        globalFilterCache.set(gateway.service.id, globals);
      }
      for (const ref of globals) hops.push(typeStep(ref, ref.type.name));
      for (const name of route.filterNames) {
        const ref = index.types.find((t) => t.type.name === name || t.type.name === `${name}GatewayFilterFactory`);
        if (ref && hasAnnotation(ref.type.annotations, "Component")) hops.push(typeStep(ref, `${ref.type.name} (route filter)`));
      }
    }
    const routeSymbol: SymbolRef = { rootId: route.at.rootId, file: route.at.file, line: route.at.line ?? 1, name: `route ${route.id} ${route.paths.join(",")}`, fqn: `gateway-route:${route.id}` };
    hops.push(graph.step(gateway.service.id, gateway.service.name, "middleware", `route:${route.id}@${target.id}`, routeSymbol));
    return hops;
  };

  const chainTo = (fromStep: string, hops: readonly string[], handler: string, rationale: string, provenance: "framework-rule" | "ai-inferred" = "framework-rule"): void => {
    let prev = fromStep;
    const all = [...hops, handler];
    all.forEach((hop, i) => {
      // Only the final hop into the backend carries the inference; config-derived hops stay rules.
      const inferredHop = provenance === "ai-inferred" && i === all.length - 1;
      graph.edge(prev, hop, { provenance: inferredHop ? "ai-inferred" : "framework-rule", rationale, ...(inferredHop ? { confidence: 0.6 } : {}) });
      prev = hop;
    });
  };

  /** Resolve a request arriving at `service` with `path`; follows a gateway hop when needed. */
  const resolveAt = (svc: JavaService, method: string, path: string): { target?: Entrypoint; inferred?: string; via?: { gateway: JavaService; route: GatewayRoute; downstream: string; backend: JavaService } } => {
    if (svc.service.kind === "gateway") {
      for (const route of routesOf(svc)) {
        if (!route.paths.some((p) => antMatch(p, path))) continue;
        const uri = parseUrl(route.uri);
        const backend = uri ? serviceFor(uri.host, uri.port) : undefined;
        if (!backend) continue; // target outside the workspace: a later route may still match
        const downstream = applyRoute(route, path);
        const via = { gateway: svc, route, downstream, backend };
        const target = matchEntrypoint(entries, backend.service.id, method, downstream);
        if (target) return { target, via };
        if (route.stripPrefix === 0 && !route.rewrite) {
          // Gateways often strip the service prefix in code (custom GlobalFilter); infer it, never assert it.
          const stripped = normalizeHttpPath(`/${downstream.split("/").filter(Boolean).slice(1).join("/")}`);
          const guess = matchEntrypoint(entries, backend.service.id, method, stripped);
          if (guess) return { target: guess, via: { ...via, downstream: stripped }, inferred: `no StripPrefix in config; matched ${stripped} assuming the gateway strips the first segment in code` };
        }
        return { via };
      }
      return {};
    }
    const target = matchEntrypoint(entries, svc.service.id, method, path);
    return target ? { target } : {};
  };

  // Frontend → (proxy) → gateway? → backend
  for (const app of input.frontends) {
    for (const call of input.frontendCalls.get(app.service.id) ?? []) {
      const proxy = app.proxies.find((p) =>
        p.prefix.startsWith("^") ? safeRegex(p.prefix)?.test(call.browserPath) : call.browserPath === p.prefix || call.browserPath.startsWith(`${p.prefix.replace(/\/$/, "")}/`),
      );
      if (!proxy) {
        graph.unresolved.push({ fromStepId: call.stepId, expression: `${call.method} ${call.browserPath}`, reason: "unresolved-config", at: call.at });
        continue;
      }
      const url = parseUrl(proxy.target);
      const stripped = !proxy.stripPrefix
        ? call.browserPath
        : proxy.prefix.startsWith("^")
          ? call.browserPath.replace(safeRegex(proxy.prefix) ?? /^$/, "")
          : call.browserPath.slice(proxy.prefix.replace(/\/$/, "").length);
      const upstream = normalizeHttpPath(`${url && url.path !== "/" ? url.path : ""}/${stripped}`);
      let first = url ? serviceFor(url.host, url.port) : undefined;
      if (first && url && first.service.kind !== "gateway") {
        // Several apps can share a (possibly defaulted) port: prefer the one that serves the path.
        const samePort = input.java.filter((j) => j.port === (url.port ?? 80));
        if (samePort.length > 1) first = samePort.find((j) => matchEntrypoint(entries, j.service.id, call.method, upstream)) ?? first;
      }
      if (!first) {
        graph.unresolved.push({ fromStepId: call.stepId, expression: `${call.method} ${call.browserPath} → ${proxy.target}`, reason: "unresolved-config", at: call.at });
        continue;
      }
      const { target, via, inferred } = resolveAt(first, call.method, upstream);
      if (!target) {
        graph.unresolved.push({ fromStepId: call.stepId, expression: `${call.method} ${upstream}${via ? ` → ${via.backend.service.name} ${via.downstream}` : ` @ ${first.service.name}`}`, reason: "unresolved-config", at: call.at });
        continue;
      }
      const handler = input.handlers.get(target.id);
      if (!handler) continue;
      const hops = via ? gatewayHops(via.gateway, via.route, target) : [];
      const rationale = via
        ? `${proxy.prefix} → ${proxy.target}; ${via.route.paths.join(",")}${via.route.stripPrefix ? ` StripPrefix=${via.route.stripPrefix}` : ""} → ${via.route.uri}`
        : `${proxy.prefix} → ${proxy.target}`;
      chainTo(call.stepId, hops, handler, inferred ? `${rationale}; ${inferred}` : rationale, inferred ? "ai-inferred" : "framework-rule");
      if (!result.upstream.has(target.id)) result.upstream.set(target.id, { stepIds: [call.stepId, ...hops] });
      const evidence = [proxy.at, { rootId: call.at.rootId, file: call.at.file, line: call.at.line ?? 1 }];
      if (via) {
        addLink(app.service.id, via.gateway.service.id, "frontend-proxy", `${call.method} ${call.browserPath}`, call.stepId, undefined, evidence, rationale);
        addLink(via.gateway.service.id, via.backend.service.id, "gateway-route", `${call.method} ${via.downstream}`, hops[hops.length - 1] ?? call.stepId, target, [via.route.at], inferred ? `${rationale}; ${inferred}` : rationale);
        if (inferred) {
          const link = result.links[result.links.length - 1];
          if (link) {
            link.provenance = "ai-inferred";
            link.confidence = 0.6;
          }
        }
      } else {
        addLink(app.service.id, first.service.id, "frontend-proxy", `${call.method} ${call.browserPath}`, call.stepId, target, evidence, rationale);
      }
    }
  }

  // Feign
  for (const site of input.feignCalls) {
    const url = site.url ? parseUrl(site.url) : undefined;
    const backend = site.targetService ? byName.get(site.targetService.toLowerCase()) : url ? serviceFor(url.host, url.port) : undefined;
    if (!backend) {
      graph.unresolved.push({ fromStepId: site.stepId, expression: `@FeignClient(${site.targetService ?? site.url ?? "?"}) ${site.method} ${site.path}`, reason: "unresolved-config", at: site.at });
      continue;
    }
    const path = normalizeHttpPath(`${url?.path ?? ""}/${site.path}`);
    const target = matchEntrypoint(entries, backend.service.id, site.method, path);
    const handler = target ? input.handlers.get(target.id) : undefined;
    if (target && handler) chainTo(site.stepId, [], handler, `@FeignClient → ${backend.service.name}`);
    addLink(site.serviceId, backend.service.id, "http", `${site.method} ${path}`, site.stepId, target, [{ rootId: site.at.rootId, file: site.at.file, line: site.at.line ?? 1 }], "@FeignClient");
  }

  // RestTemplate / WebClient / declared wrappers
  for (const site of input.restCalls) {
    const url = parseUrl(site.url);
    const first = url ? serviceFor(url.host, url.port) : undefined;
    if (!url || !first) continue; // external API: stays an external-http step
    const { target, via } = resolveAt(first, site.method, normalizeHttpPath(url.path));
    const handler = target ? input.handlers.get(target.id) : undefined;
    const hops = via && target ? gatewayHops(via.gateway, via.route, target) : [];
    if (target && handler) chainTo(site.stepId, hops, handler, `${site.method} ${site.url}`);
    addLink(site.serviceId, (via?.backend ?? first).service.id, "http", `${site.method} ${url.path}`, site.stepId, target, [{ rootId: site.at.rootId, file: site.at.file, line: site.at.line ?? 1 }]);
  }

  return result;
}

function safeRegex(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}
