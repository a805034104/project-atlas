import type { GraphBuilder } from "../graph/builder.js";
import { normalizeHttpPath, stableId } from "../model/ids.js";
import type { Entrypoint, ServiceLink, SourceRef, SymbolRef } from "../model/types.js";
import type { FrontendApp, JavaService } from "../workspace/detect.js";
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
  const entries = svc.config.list("spring.cloud.gateway.routes");
  const byIndex = new Map<number, typeof entries>();
  for (const e of entries) {
    const m = /routes\[(\d+)\]/i.exec(e.key);
    if (!m) continue;
    const i = Number(m[1]);
    byIndex.set(i, [...(byIndex.get(i) ?? []), e]);
  }
  const routes: GatewayRoute[] = [];
  for (const [, group] of [...byIndex.entries()].sort((a, b) => a[0] - b[0])) {
    const value = (suffix: RegExp) => group.find((e) => suffix.test(e.key.replace(/^.*routes\[\d+\]\./i, "")));
    const resolved = (s: string) => svc.config.resolve(s).value;
    const id = resolved(value(/^id$/i)?.value ?? "");
    const uri = resolved(value(/^uri$/i)?.value ?? "");
    const predicates = group.filter((e) => /\.predicates\[\d+\]$/i.test(e.key)).map((e) => resolved(e.value));
    const filters = group.filter((e) => /\.filters\[\d+\]$/i.test(e.key)).map((e) => resolved(e.value));
    const paths = predicates.filter((p) => /^Path\s*=/i.test(p)).flatMap((p) => p.replace(/^Path\s*=\s*/i, "").split(",").map((s) => s.trim()).filter(Boolean));
    const route: GatewayRoute = { id, uri, paths, stripPrefix: 0, filterNames: [], at: group[0]?.at ?? { rootId: svc.service.rootId, file: "" } };
    for (const f of filters) {
      const [name = "", args = ""] = f.split(/=(.*)/s).map((s) => s.trim());
      if (/^StripPrefix$/i.test(name)) route.stripPrefix = Number.parseInt(args, 10) || 0;
      else if (/^RewritePath$/i.test(name)) {
        const [regex = "", replacement = ""] = args.split(/,\s*/);
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
export function matchEntrypoint(entries: readonly Entrypoint[], serviceId: string, method: string, path: string): Entrypoint | undefined {
  const callSegments = path.split("/").filter(Boolean);
  let best: Entrypoint | undefined;
  let bestScore = -1;
  for (const e of entries) {
    if (e.serviceId !== serviceId || e.kind !== "http" || !e.path) continue;
    if (e.method !== "ANY" && method !== "ANY" && e.method !== method) continue;
    const segs = e.path.split("/").filter(Boolean);
    if (segs.length !== callSegments.length) continue;
    let score = 0;
    let ok = true;
    for (let i = 0; i < segs.length; i++) {
      const pattern = segs[i] as string;
      const actual = callSegments[i] as string;
      if (pattern === actual) score += 2;
      else if (pattern === "{}") score += 1;
      else {
        ok = false;
        break;
      }
    }
    if (ok && e.method === method) score += 1;
    if (ok && score > bestScore) {
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
  const entries = [...graph.entrypoints.values()];
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
      for (const ref of index.types) {
        if (index.supertypeNames(ref).includes("GlobalFilter") && index.isBean(ref)) hops.push(typeStep(ref, ref.type.name));
      }
      for (const name of route.filterNames) {
        const ref = index.types.find((t) => t.type.name === name || t.type.name === `${name}GatewayFilterFactory`);
        if (ref && hasAnnotation(ref.type.annotations, "Component")) hops.push(typeStep(ref, `${ref.type.name} (route filter)`));
      }
    }
    const routeSymbol: SymbolRef = { rootId: route.at.rootId, file: route.at.file, line: route.at.line ?? 1, name: `route ${route.id} ${route.paths.join(",")}`, fqn: `gateway-route:${route.id}` };
    hops.push(graph.step(gateway.service.id, gateway.service.name, "middleware", `route:${route.id}@${target.id}`, routeSymbol));
    return hops;
  };

  const chainTo = (fromStep: string, hops: readonly string[], handler: string, rationale: string): void => {
    let prev = fromStep;
    for (const hop of [...hops, handler]) {
      graph.edge(prev, hop, { provenance: "framework-rule", rationale });
      prev = hop;
    }
  };

  /** Resolve a request arriving at `service` with `path`; follows a gateway hop when needed. */
  const resolveAt = (svc: JavaService, method: string, path: string): { target?: Entrypoint; via?: { gateway: JavaService; route: GatewayRoute; downstream: string; backend: JavaService } } => {
    if (svc.service.kind === "gateway") {
      for (const route of parseGatewayRoutes(svc)) {
        if (!route.paths.some((p) => antMatch(p, path))) continue;
        const uri = parseUrl(route.uri);
        const backend = uri ? serviceFor(uri.host, uri.port) : undefined;
        if (!backend) return {};
        const downstream = applyRoute(route, path);
        const target = matchEntrypoint(entries, backend.service.id, method, downstream);
        return target ? { target, via: { gateway: svc, route, downstream, backend } } : { via: { gateway: svc, route, downstream, backend } };
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
      const upstream = proxy.stripPrefix && !proxy.prefix.startsWith("^") ? normalizeHttpPath(call.browserPath.slice(proxy.prefix.replace(/\/$/, "").length)) : call.browserPath;
      const url = parseUrl(proxy.target);
      const first = url ? serviceFor(url.host, url.port) : undefined;
      if (!first) {
        graph.unresolved.push({ fromStepId: call.stepId, expression: `${call.method} ${call.browserPath} → ${proxy.target}`, reason: "unresolved-config", at: call.at });
        continue;
      }
      const { target, via } = resolveAt(first, call.method, upstream);
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
      chainTo(call.stepId, hops, handler, rationale);
      if (!result.upstream.has(target.id)) result.upstream.set(target.id, { stepIds: [call.stepId, ...hops] });
      const evidence = [proxy.at, { rootId: call.at.rootId, file: call.at.file, line: call.at.line ?? 1 }];
      if (via) {
        addLink(app.service.id, via.gateway.service.id, "frontend-proxy", `${call.method} ${call.browserPath}`, call.stepId, undefined, evidence, rationale);
        addLink(via.gateway.service.id, via.backend.service.id, "gateway-route", `${call.method} ${via.downstream}`, hops[hops.length - 1] ?? call.stepId, target, [via.route.at], rationale);
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
