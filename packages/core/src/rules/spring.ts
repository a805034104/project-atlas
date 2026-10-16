import { rawTypeName } from "../facts/java.js";
import type { JavaAnnotation, JavaCall, JavaField, JavaMethod } from "../facts/types.js";
import { GraphBuilder } from "../graph/builder.js";
import { httpKey, javaMethodKey, normalizeHttpPath, stableId } from "../model/ids.js";
import type { Diagnostic, Entrypoint, FlowLayer, SymbolRef } from "../model/types.js";
import type { JavaService } from "../workspace/detect.js";
import { antMatch, servletPatternMatch } from "./ant.js";
import { annotationExpr, annotationStrings, hasAnnotation, type JavaIndex, type MethodRef, type TypeRef } from "./java-index.js";
import { javaStringLiteralText, splitArrayElements } from "./java-literals.js";
import { MQ_CLIENT_TYPES, MqCollector, REDIS_TEMPLATE_TYPES, type MqBroker, type MqServiceResult } from "./mq.js";
import type { MapperStatement } from "./mybatis.js";
import { compilePointcut, UnsupportedPointcut, type JoinPoint, type Pointcut } from "./pointcut.js";

/**
 * Spring MVC / Boot rules for one service.
 *
 *   HTTP entrypoint chain (explicit, per entrypoint):
 *     servlet filters (by order, url-pattern) ─▶ interceptors (Ant include/exclude)
 *       ─▶ method security (@PreAuthorize…) ─▶ aspects on the handler ─▶ controller
 *   Call graph (global, memoized per method step):
 *     same-class / superclass helpers are inlined; bean calls become steps:
 *     field type ─▶ concrete class | interface ─▶ DI (unique → @Primary →
 *     @Qualifier/@Resource → field name → branches) ─▶ method (+aspects)
 *     Mapper interface ─▶ XML statement | BaseMapper ;  @FeignClient / RestTemplate ─▶ call sites
 *   Unknown receivers are never guessed: injected fields of unresolvable
 *   project-looking types become UnresolvedCall entries instead of edges.
 */

export interface HttpChain {
  entrypoint: Entrypoint;
  chainStepIds: string[];
  chainEdgeIds: string[];
  handlerStepId: string;
}

export interface FeignCallSite {
  stepId: string;
  serviceId: string;
  /** Target service name (resolved constant), or undefined when only `url` is set. */
  targetService?: string;
  url?: string;
  method: string;
  path: string;
  at: SymbolRef;
}

export interface RestCallSite {
  stepId: string;
  serviceId: string;
  url: string;
  method: string;
  at: SymbolRef;
}

export interface SpringResult {
  chains: HttpChain[];
  scheduled: { entrypoint: Entrypoint; handlerStepId: string }[];
  feignCalls: FeignCallSite[];
  restCalls: RestCallSite[];
  mq: MqServiceResult;
  diagnostics: Diagnostic[];
}

export interface Wrapper {
  /** `com.acme.HttpUtils.sendPost` */
  symbol: string;
  kind: "http" | "mq";
  urlArg?: number;
  methodLiteral?: string;
  broker?: string;
  topicArg?: number;
}

const MAPPING_ANNOTATIONS: Record<string, string | undefined> = {
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  DeleteMapping: "DELETE",
  PatchMapping: "PATCH",
  RequestMapping: undefined,
};
const SECURITY_ANNOTATIONS = ["PreAuthorize", "PostAuthorize", "Secured", "RolesAllowed"];
const FILTER_TYPES = new Set(["OncePerRequestFilter", "Filter", "GenericFilterBean", "HttpFilter", "AbstractRequestLoggingFilter"]);
const REST_CLIENT_TYPES = new Set(["RestTemplate", "WebClient", "RestClient", "OkHttpClient"]);
/** Common JDK/library receiver types: never project interfaces, skip the implementor lookup. */
const JDK_TYPES = new Set(["String", "StringBuilder", "List", "ArrayList", "Map", "HashMap", "Set", "HashSet", "Collection", "Optional", "Stream", "Object", "Integer", "Long", "Boolean", "Date", "LocalDateTime", "BigDecimal", "Iterator", "Arrays", "Collections", "Objects"]);
const ADVICE = ["Before", "Around", "After", "AfterReturning", "AfterThrowing"];
const LOWEST = Number.MAX_SAFE_INTEGER;
const HIGHEST = Number.MIN_SAFE_INTEGER;
/** Spring Security's DelegatingFilterProxy default order (SecurityProperties.DEFAULT_FILTER_ORDER). */
const SECURITY_CHAIN_ORDER = -100;
const MAX_INLINE_DEPTH = 6;
const THIRD_PARTY = /^(java|javax|jakarta|org\.springframework|org\.apache|com\.alibaba|com\.baomidou|io\.|lombok|com\.fasterxml|org\.slf4j|com\.google|cn\.hutool|reactor)\b/;

interface FilterInfo {
  ref: TypeRef;
  patterns: string[];
  order: number;
  seq: number;
}

interface InterceptorInfo {
  ref: TypeRef;
  include: string[];
  exclude: string[];
  order: number;
  seq: number;
}

interface Advice {
  aspect: TypeRef;
  method: JavaMethod;
  kind: string;
  pointcut: Pointcut;
  order: number;
}

const DATA_PACKAGE = /\.(domain|entity|entities|vo|dto|po|bo|do|model|pojo|bean|page|annotation|enums?)(\.|$)/;
const ACCESSOR = /^(get|set|is|has)[A-Z]/;

/**
 * A call on a non-bean object that only reads or writes data: accessor-named methods that call
 * nothing else, and methods of enums / records / classes in data packages unless they call into
 * a Spring bean (a strategy enum or `model.PricingEngine` calling a service does real work).
 */
function isDataCall(index: JavaIndex, type: TypeRef, method: JavaMethod): boolean {
  if (type.type.kind === "annotation") return true;
  if (ACCESSOR.test(method.name) && method.calls.every((c) => c.receiver === undefined || c.receiver === "this" || c.receiver === "super")) return true;
  const dataLike = type.type.kind === "enum" || type.type.kind === "record" || DATA_PACKAGE.test(type.facts.package);
  return dataLike && !callsBean(index, type, method);
}

function callsBean(index: JavaIndex, type: TypeRef, method: JavaMethod): boolean {
  for (const c of method.calls) {
    const receiver = c.receiver?.replace(/^this\./, "");
    if (!receiver || !/^\w+$/.test(receiver)) continue;
    const typeText = method.locals[receiver] ?? method.params.find((p) => p.name === receiver)?.type ?? type.type.fields.find((f) => f.name === receiver)?.type;
    const target = typeText ? index.resolveType(rawTypeName(typeText), type) : undefined;
    if (target && (index.isBean(target) || index.implementations(target).some((i) => index.isBean(i)))) return true;
  }
  return false;
}

function simpleTypeName(ref: TypeRef): string {
  return ref.type.name.slice(ref.type.name.lastIndexOf(".") + 1);
}

function orderValue(text: string | undefined): number | undefined {
  if (!text) return undefined;
  if (/HIGHEST_PRECEDENCE/.test(text)) return HIGHEST;
  if (/LOWEST_PRECEDENCE/.test(text)) return LOWEST;
  const n = Number.parseInt(text.replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : undefined;
}

export function runSpringRules(
  svc: JavaService,
  index: JavaIndex,
  mappers: Map<string, MapperStatement>,
  graph: GraphBuilder,
  wrappers: readonly Wrapper[] = [],
): SpringResult {
  const { service } = svc;
  const diagnostics: Diagnostic[] = [];
  const result: SpringResult = { chains: [], scheduled: [], feignCalls: [], restCalls: [], mq: { sends: [], consumers: [], topology: { exchanges: new Map(), bindings: [], deadLetters: new Map() } }, diagnostics };
  const mapperNamespaces = new Set([...mappers.values()].map((m) => m.namespace));

  const symbolOf = (owner: TypeRef, method: JavaMethod): SymbolRef => ({
    rootId: owner.file.rootId,
    file: owner.file.relPath,
    line: method.line,
    name: `${simpleTypeName(owner)}.${method.name}`,
    fqn: javaMethodKey(owner.type.fqcn, method.name, method.params.map((p) => rawTypeName(p.type))),
  });
  const typeSymbol = (owner: TypeRef, label: string): SymbolRef => ({
    rootId: owner.file.rootId,
    file: owner.file.relPath,
    line: owner.type.line,
    name: label,
    fqn: owner.type.fqcn,
  });

  const isMapper = (ref: TypeRef): boolean =>
    !!hasAnnotation(ref.type.annotations, "Mapper", "Repository") ||
    mapperNamespaces.has(ref.type.fqcn) ||
    index.supertypeNames(ref).some((n) => n === "BaseMapper" || n === "Mapper");

  const layerOf = (ref: TypeRef): FlowLayer => {
    const names = ref.type.annotations.map((a) => a.name);
    if (names.includes("RestController") || names.includes("Controller")) return "controller";
    if (names.includes("FeignClient")) return "external-http";
    if (isMapper(ref)) return "repository";
    if (/(Redis|Cache)/.test(ref.type.name)) return "cache";
    return "service";
  };

  const step = (layer: FlowLayer, key: string, symbol: SymbolRef): string => graph.step(service.id, service.name, layer, key, symbol);
  const methodStep = (m: MethodRef): string => {
    const symbol = symbolOf(m.owner, m.method);
    return step(layerOf(m.owner), symbol.fqn, symbol);
  };

  const mq = new MqCollector({
    svc,
    index,
    graph,
    diagnostics,
    symbolOf,
    handlerStep: (m) => {
      const id = methodStep(m);
      expand(m, id);
      return id;
    },
  });

  // ── Aspects ───────────────────────────────────────────────────────────────
  const advices: Advice[] = [];
  for (const ref of index.types) {
    if (!hasAnnotation(ref.type.annotations, "Aspect")) continue;
    const named: Record<string, string> = {};
    for (const m of ref.type.methods) {
      const pointcut = hasAnnotation(m.annotations, "Pointcut");
      const pc = annotationStrings(pointcut, "value")?.[0] ?? index.resolveConstant(annotationExpr(pointcut, "value") ?? "", ref);
      if (pc) named[m.name] = pc;
    }
    const order = orderValue(annotationExpr(hasAnnotation(ref.type.annotations, "Order"), "value") ?? annotationStrings(hasAnnotation(ref.type.annotations, "Order"), "value")?.[0]) ?? LOWEST;
    for (const m of ref.type.methods) {
      for (const a of m.annotations) {
        if (!ADVICE.includes(a.name)) continue;
        const expr = annotationStrings(a, "value", "pointcut")?.[0] ?? index.resolveConstant(annotationExpr(a, "value", "pointcut") ?? "", ref);
        if (!expr) continue;
        const paramTypes = Object.fromEntries(m.params.map((p) => [p.name, rawTypeName(p.type)]));
        try {
          advices.push({ aspect: ref, method: m, kind: a.name, pointcut: compilePointcut(expr, { paramTypes, named }), order });
        } catch (error) {
          if (!(error instanceof UnsupportedPointcut)) throw error;
          diagnostics.push({
            code: "ATLAS-W010",
            severity: "warning",
            message: `Unsupported pointcut in ${ref.type.name}.${m.name}: ${error.message}`,
            at: { rootId: ref.file.rootId, file: ref.file.relPath, line: a.line },
          });
        }
      }
    }
  }
  advices.sort((a, b) => a.order - b.order);

  const joinPoint = (m: MethodRef, target: TypeRef): JoinPoint => ({
    fqcn: target.type.fqcn,
    method: m.method.name,
    methodAnnotations: m.method.annotations.map((a) => a.name),
    typeAnnotations: target.type.annotations.map((a) => a.name),
    beanName: index.beanName(target),
  });

  /** Aspect steps wrapping `target` (one step per advice × join point). */
  const aspectSteps = (m: MethodRef, target: TypeRef): string[] => {
    if (advices.length === 0) return [];
    const jp = joinPoint(m, target);
    const targetKey = symbolOf(m.owner, m.method).fqn;
    return advices
      .filter((a) => a.aspect !== target && a.pointcut(jp))
      .map((a) => {
        const symbol = symbolOf(a.aspect, a.method);
        return step("aspect", `${symbol.fqn}@${targetKey}`, { ...symbol, name: `@${a.kind} ${symbol.name}` });
      });
  };

  /** Connect caller → [aspects…] → target and return the first hop's edge id. */
  const connect = (from: string, m: MethodRef, target: TypeRef, order: number, provenance: "static" | "framework-rule", rationale?: string): void => {
    const toStep = methodStep(m);
    const hops = [...aspectSteps(m, target), toStep];
    let prev = from;
    hops.forEach((hop, i) => {
      graph.edge(prev, hop, { provenance: i === 0 ? provenance : "framework-rule", order: i === 0 ? order : 0, ...(i === 0 && rationale ? { rationale } : {}) });
      prev = hop;
    });
    expand(m, toStep);
  };

  // ── Call graph ────────────────────────────────────────────────────────────
  const expanded = new Set<string>();

  const fieldOf = (owner: TypeRef, name: string): { field: JavaField; declaring: TypeRef } | undefined => {
    for (const t of [owner, ...index.ancestors(owner)]) {
      const field = t.type.fields.find((f) => f.name === name);
      if (field) return { field, declaring: t };
    }
    return undefined;
  };

  /**
   * The method `call` runs on `owner`: undefined when there is none, null when same-arity overloads
   * remain after matching argument types (reported once as an ambiguous overload, no edge guessed).
   */
  const pick = (owner: TypeRef, call: JavaCall, ctx: MethodRef | undefined, report?: { fromStep: string; at: SymbolRef }): MethodRef | null | undefined => {
    const found = index.selectOverload(index.findMethods(owner, call.method, call.argCount), call, ctx);
    if (found.length <= 1) return found[0];
    if (report) graph.unresolved.push({ fromStepId: report.fromStep, expression: `${call.receiver ?? ""}.${call.method}(${call.argTexts.join(", ")}) — ${found.length} overloads of ${simpleTypeName(owner)}.${call.method}`, reason: "ambiguous-overload", at: report.at });
    return null;
  };

  /** Calls made by `m`, with same-class / superclass helpers inlined. */
  const effectiveCalls = (m: MethodRef): { call: JavaCall; ctx: MethodRef }[] => {
    const out: { call: JavaCall; ctx: MethodRef }[] = [];
    const visit = (ctx: MethodRef, depth: number, seen: Set<JavaMethod>): void => {
      for (const call of ctx.method.calls) {
        const receiver = call.receiver;
        if (receiver === undefined || receiver === "this" || receiver === "super") {
          const helper = pick(m.owner, call, ctx);
          if (helper && !seen.has(helper.method) && depth < MAX_INLINE_DEPTH) {
            seen.add(helper.method);
            visit(helper, depth + 1, seen);
          }
          continue;
        }
        out.push({ call, ctx });
      }
    };
    visit(m, 0, new Set([m.method]));
    return out;
  };

  const wrapperFor = (typeFqcn: string, method: string): Wrapper | undefined => wrappers.find((w) => w.symbol === `${typeFqcn}.${method}`);
  const mqWrapper = (fromStep: string, w: Wrapper, call: JavaCall, ctx: MethodRef, at: SymbolRef): void => {
    // atlas.yaml wrapper broker: case-insensitive with common aliases; anything else is reported,
    // never silently treated as Kafka.
    const aliases: Record<string, MqBroker> = { kafka: "kafka", rabbitmq: "rabbitmq", rabbit: "rabbitmq", amqp: "rabbitmq", rocketmq: "rocketmq", rocket: "rocketmq", "redis-stream": "redis-stream", redis: "redis-stream", stream: "stream", "spring-cloud-stream": "stream", scs: "stream" };
    const broker = aliases[(w.broker ?? "").trim().toLowerCase()];
    if (!broker) {
      graph.unresolved.push({ fromStepId: fromStep, expression: `${call.receiver ?? ""}.${call.method}(${call.argTexts.join(", ")}) — atlas.yaml wrapper broker "${w.broker ?? ""}"`, reason: "unknown-wrapper", at });
      return;
    }
    mq.recordSend(fromStep, broker, call, ctx.owner, at, { ...(w.topicArg !== undefined ? { topicArg: w.topicArg } : {}) }, ctx.method);
  };

  /** Declared type of a receiver identifier: local, parameter, then field (with its declaring type). */
  const receiverType = (receiver: string, ctx: MethodRef): { typeText?: string; field?: JavaField; typeCtx: TypeRef } => {
    if (ctx.method.locals[receiver]) return { typeText: ctx.method.locals[receiver], typeCtx: ctx.owner };
    const param = ctx.method.params.find((p) => p.name === receiver);
    if (param) return { typeText: param.type, typeCtx: ctx.owner };
    const found = fieldOf(ctx.owner, receiver);
    return found ? { typeText: found.field.type, field: found.field, typeCtx: found.declaring } : { typeCtx: ctx.owner };
  };

  function expand(m: MethodRef, fromStep: string): void {
    if (expanded.has(fromStep)) return;
    expanded.add(fromStep);
    let order = 0;
    for (const { call, ctx } of effectiveCalls(m)) {
      order++;
      const receiver = (call.receiver ?? "").replace(/^this\./, "");
      const at: SymbolRef = { ...symbolOf(ctx.owner, ctx.method), line: call.line };

      // `redisTemplate.opsForStream().add(..)`: the only chained receiver that is a send.
      const streamOps = /^([A-Za-z_$][\w$]*)\.opsForStream\(\)$/.exec(receiver);
      if (streamOps) {
        const head = receiverType(streamOps[1] as string, ctx);
        if (head.typeText && REDIS_TEMPLATE_TYPES.has(rawTypeName(head.typeText).replace(/^.*\./, ""))) mq.recordSend(fromStep, "redis-stream", call, ctx.owner, at, undefined, ctx.method);
        continue;
      }
      if (!/^[A-Za-z_$][\w$]*$/.test(receiver)) continue; // chained / computed receivers: not a bean reference
      const { typeText, field, typeCtx } = receiverType(receiver, ctx);
      if (!typeText) {
        // Static call (`SecurityUtils.getUserId()`) or unknown identifier: maybe a declared wrapper.
        const staticType = /^[A-Z]/.test(receiver) ? index.resolveType(receiver, ctx.owner) : undefined;
        const w = staticType ? wrapperFor(staticType.type.fqcn, call.method) : undefined;
        if (w?.kind === "http") recordRestCall(fromStep, call, at, w);
        if (w?.kind === "mq") mqWrapper(fromStep, w, call, ctx, at);
        continue;
      }

      const raw = rawTypeName(typeText);
      const type = index.resolveType(typeText, typeCtx);
      if (!type) {
        if (REST_CLIENT_TYPES.has(raw)) {
          recordRestCall(fromStep, call, at);
          continue;
        }
        const broker = MQ_CLIENT_TYPES[raw.slice(raw.lastIndexOf(".") + 1)];
        if (broker && mq.recordSend(fromStep, broker, call, ctx.owner, at, undefined, ctx.method)) continue;
        // Interface from a jar, implementation in the project (`AIChatHandler implements IAIChatHandler`).
        const simple = raw.slice(raw.lastIndexOf(".") + 1);
        const implementors = JDK_TYPES.has(simple) ? [] : index.beansImplementing(simple);
        if (implementors.length > 0) {
          const branch = implementors.length > 1 ? `${implementors.length} implementations of ${simple}; branch shown for each` : undefined;
          implementors.forEach((impl, i) => {
            const target = pick(impl, call, ctx, { fromStep, at });
            if (!target) return;
            const toStep = methodStep(target);
            graph.edge(fromStep, toStep, {
              provenance: "framework-rule",
              order,
              rationale: branch ?? `implements external interface ${simple}`,
              ...(branch ? { discriminator: `branch:${i}` } : {}),
            });
            expand(target, toStep);
          });
          continue;
        }
        const imported = typeCtx.facts.imports[raw];
        const injected = !!field && (hasAnnotation(field.annotations, "Autowired", "Resource", "Inject") || field.modifiers.includes("final"));
        if (injected && (!imported || !THIRD_PARTY.test(imported)) && /^[A-Z]/.test(raw) && !/^(String|List|Map|Set|Long|Integer|Object)$/.test(raw)) {
          graph.unresolved.push({ fromStepId: fromStep, expression: `${call.receiver}.${call.method}(…)`, reason: "unknown-receiver", at });
        }
        continue;
      }
      const w = wrapperFor(type.type.fqcn, call.method);
      if (w?.kind === "http") {
        recordRestCall(fromStep, call, at, w);
        continue;
      }
      if (w?.kind === "mq") {
        mqWrapper(fromStep, w, call, ctx, at);
        continue;
      }
      dispatch(fromStep, type, field, call, ctx, order, at);
    }
  }

  function dispatch(fromStep: string, type: TypeRef, field: JavaField | undefined, call: JavaCall, ctx: MethodRef, order: number, at: SymbolRef): void {
    const isInterface = type.type.kind === "interface" || type.type.modifiers.includes("abstract");
    if (!isInterface) {
      const report = index.isBean(type) ? { fromStep, at } : undefined; // data objects: no noise
      const target = pick(type, call, ctx, report);
      // Data objects (entities, DTOs, AjaxResult…) and plain accessors are not flow steps.
      if (target && (index.isBean(type) || (target.owner === type && !isDataCall(index, type, target.method)))) connect(fromStep, target, type, order, "static");
      return;
    }

    if (hasAnnotation(type.type.annotations, "FeignClient")) {
      const target = pick(type, call, ctx, { fromStep, at });
      if (target) {
        const stepId = methodStep(target);
        graph.edge(fromStep, stepId, { provenance: "framework-rule", order, rationale: "@FeignClient" });
        recordFeignCall(type, target, stepId);
      }
      return;
    }

    const all = index.implementations(type);
    const beans = all.filter((t) => index.isBean(t));
    let impls = beans.length > 0 ? beans : all;
    let rationale: string | undefined;
    if (impls.length > 1) {
      const primary = impls.filter((t) => hasAnnotation(t.type.annotations, "Primary"));
      const qualifier =
        annotationStrings(hasAnnotation(field?.annotations ?? [], "Qualifier"), "value")?.[0] ??
        annotationStrings(hasAnnotation(field?.annotations ?? [], "Resource"), "name")?.[0];
      const byQualifier = qualifier ? impls.filter((t) => index.beanName(t) === qualifier) : [];
      const byName = field ? impls.filter((t) => index.beanName(t) === field.name) : [];
      if (byQualifier.length === 1) impls = byQualifier;
      else if (primary.length === 1) impls = primary;
      else if (byName.length === 1) impls = byName;
      else rationale = `${impls.length} implementations of ${simpleTypeName(type)}; branch shown for each`;
    }

    if (impls.length === 0) {
      if (isMapper(type) || type.type.kind === "interface") {
        const target = index.findMethods(type, call.method, call.argCount)[0];
        if (target && isMapper(type)) {
          const mapperStep = methodStep({ owner: type, method: target.method });
          graph.edge(fromStep, mapperStep, { provenance: "framework-rule", order, rationale: "MyBatis mapper proxy" });
          linkStatement(type, target.method.name, mapperStep);
          return;
        }
        if (!target && isMapper(type)) {
          // Inherited from a framework base mapper (MyBatis-Plus BaseMapper, MPJBaseMapper, project base mappers in jars).
          const base = index.supertypeNames(type)[0] ?? "BaseMapper";
          const mapperStep = step("repository", `${type.type.fqcn}#${call.method}(inherited)`, typeSymbol(type, `${simpleTypeName(type)}.${call.method} (${base})`));
          graph.edge(fromStep, mapperStep, { provenance: "framework-rule", order, rationale: `inherited from ${base}` });
          return;
        }
      }
      graph.unresolved.push({ fromStepId: fromStep, expression: `${call.receiver}.${call.method}(…)`, reason: "dynamic-dispatch", at });
      return;
    }

    impls.forEach((impl, i) => {
      const target = pick(impl, call, ctx, i === 0 ? { fromStep, at } : undefined);
      if (target === null) return;
      if (!target) {
        // Method inherited from a library base class (MyBatis-Plus ServiceImpl / IService…): show it, stop there.
        const base = index.supertypeNames(impl).find((n) => !index.types.some((t) => t.type.name === n)) ?? index.supertypeNames(type)[0];
        if (!base) return;
        const inherited = step(layerOf(impl), `${impl.type.fqcn}#${call.method}(inherited)`, typeSymbol(impl, `${simpleTypeName(impl)}.${call.method} (${base})`));
        graph.edge(fromStep, inherited, { provenance: "framework-rule", order, rationale: `inherited from ${base}`, ...(rationale ? { discriminator: `branch:${i}` } : {}) });
        return;
      }
      const toStep = methodStep(target);
      const hops = [...aspectSteps(target, impl), toStep];
      let prev = fromStep;
      hops.forEach((hop, h) => {
        graph.edge(prev, hop, {
          provenance: "framework-rule",
          order: h === 0 ? order : 0,
          ...(h === 0 && rationale ? { rationale, discriminator: `branch:${i}` } : {}),
          ...(h === 0 && !rationale ? { rationale: impls.length === 1 && all.length > 1 ? "selected by @Primary/@Qualifier/name" : "dependency injection" } : {}),
        });
        prev = hop;
      });
      expand(target, toStep);
    });
  }

  function linkStatement(mapper: TypeRef, method: string, mapperStep: string): void {
    const statement = mappers.get(`${mapper.type.fqcn}.${method}`);
    if (!statement) return;
    const sqlStep = step("sql", `xml:${statement.namespace}.${statement.id}`, {
      rootId: statement.at.rootId,
      file: statement.at.file,
      line: statement.at.line ?? 1,
      name: `<${statement.kind} id="${statement.id}">`,
      fqn: `${statement.namespace}.${statement.id}`,
    });
    graph.edge(mapperStep, sqlStep, { provenance: "framework-rule", rationale: "mapper XML namespace + id" });
  }

  function recordFeignCall(client: TypeRef, target: MethodRef, stepId: string): void {
    const ann = hasAnnotation(client.type.annotations, "FeignClient") as JavaAnnotation;
    const nameExpr = annotationStrings(ann, "name", "value")?.[0] ?? (annotationExpr(ann, "name", "value") ? index.resolveConstant(annotationExpr(ann, "name", "value") as string, client) : undefined);
    const url = annotationStrings(ann, "url")?.[0];
    const basePath = annotationStrings(ann, "path")?.[0] ?? "";
    const classMapping = mappingPaths(hasAnnotation(client.type.annotations, "RequestMapping"), client)[0] ?? "";
    for (const a of target.method.annotations) {
      if (!(a.name in MAPPING_ANNOTATIONS)) continue;
      const methods = httpMethods(a);
      for (const p of mappingPaths(a, client)) {
        const site: FeignCallSite = {
          stepId,
          serviceId: service.id,
          method: methods[0] ?? "GET",
          path: normalizeHttpPath(`${basePath}/${classMapping}/${p}`),
          at: symbolOf(target.owner, target.method),
        };
        if (nameExpr) site.targetService = svc.config.resolve(nameExpr).value;
        if (url) site.url = svc.config.resolve(url).value;
        result.feignCalls.push(site);
      }
    }
  }

  function recordRestCall(fromStep: string, call: JavaCall, at: SymbolRef, wrapper?: Wrapper): void {
    const urlIndex = wrapper?.urlArg ?? 0;
    const owner = index.types.find((t) => t.file.relPath === at.file && t.file.rootId === at.rootId);
    const urlText = call.argTexts[urlIndex];
    const literal = call.argLiterals[urlIndex] ?? (urlText && owner ? index.resolveConstant(urlText, owner) : undefined);
    if (!literal) {
      graph.unresolved.push({ fromStepId: fromStep, expression: `${call.receiver}.${call.method}(${urlText ?? ""})`, reason: "unresolved-config", at });
      return;
    }
    const url = svc.config.resolve(literal).value;
    let method = wrapper?.methodLiteral ?? (/^get/i.test(call.method) ? "GET" : /^post/i.test(call.method) ? "POST" : /^put/i.test(call.method) ? "PUT" : /^delete/i.test(call.method) ? "DELETE" : "GET");
    const httpMethodArg = call.argTexts.find((t) => /HttpMethod\.\w+/.test(t));
    if (httpMethodArg) method = /HttpMethod\.(\w+)/.exec(httpMethodArg)?.[1] ?? method;
    const stepId = step("external-http", `rest:${at.fqn}:${at.line}`, { ...at, name: `${method} ${url}` });
    graph.edge(fromStep, stepId, { provenance: wrapper ? "framework-rule" : "static", rationale: wrapper ? "atlas.yaml wrapper" : `${call.receiver}.${call.method}` });
    result.restCalls.push({ stepId, serviceId: service.id, url, method, at });
  }

  // ── Mapping helpers ───────────────────────────────────────────────────────
  /**
   * Mapping paths with constants and `${}` resolved. Anything unresolved becomes the
   * marker segment `⟨unresolved⟩`, which never matches a call (precision over recall),
   * instead of silently turning into a path variable.
   */
  function mappingPaths(a: JavaAnnotation | undefined, ctx: TypeRef): string[] {
    if (!a) return [];
    const resolvePlaceholders = (p: string): string => {
      const resolved = svc.config.resolve(p);
      if (resolved.unresolved.length === 0) return resolved.value;
      diagnostics.push({ code: "ATLAS-W011", severity: "warning", message: `Unresolved placeholder in mapping ${p} (${resolved.unresolved.join(", ")})`, at: { rootId: ctx.file.rootId, file: ctx.file.relPath, line: a.line } });
      return resolved.value.replace(/\$\{[^}]*\}/g, "⟨unresolved⟩");
    };
    const literal = annotationStrings(a, "value", "path");
    if (literal) return literal.length > 0 ? literal.map(resolvePlaceholders) : [""];
    const expr = annotationExpr(a, "value", "path");
    if (!expr) return [""];
    return splitArrayElements(expr).map((e) => {
      const folded = index.resolveConstant(e, ctx);
      if (folded !== undefined) return resolvePlaceholders(folded);
      diagnostics.push({ code: "ATLAS-W011", severity: "warning", message: `Unresolved constant in mapping: ${e}`, at: { rootId: ctx.file.rootId, file: ctx.file.relPath, line: a.line } });
      return "⟨unresolved⟩";
    });
  }

  function httpMethods(a: JavaAnnotation): string[] {
    const fixed = MAPPING_ANNOTATIONS[a.name];
    if (fixed) return [fixed];
    const expr = annotationExpr(a, "method");
    if (!expr) return ["ANY"];
    const found = [...expr.matchAll(/RequestMethod\.(\w+)|\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/g)].map((m) => m[1] ?? m[2] ?? "");
    return found.length > 0 ? [...new Set(found)] : ["ANY"];
  }

  // ── Filters ───────────────────────────────────────────────────────────────
  const filters: FilterInfo[] = [];
  let seq = 0;
  const isFilterType = (ref: TypeRef) => index.supertypeNames(ref).some((n) => FILTER_TYPES.has(n));
  const typeFromArg = (text: string | undefined, ctx: TypeRef, method?: JavaMethod): TypeRef | undefined => {
    if (!text) return undefined;
    const created = /^new\s+([\w.]+)\s*(?:<[^>]*>)?\s*\(/.exec(text);
    if (created) return index.resolveType(created[1] as string, ctx);
    if (/^[\w$]+$/.test(text)) {
      const local = method?.locals[text];
      if (local) return index.resolveType(local, ctx);
      const f = fieldOf(ctx, text);
      if (f) return index.resolveType(f.field.type, f.declaring);
      // @Bean factory method name used as argument
    }
    return undefined;
  };
  const resolveUrlPatterns = (call: JavaCall, ctx: TypeRef): string[] => {
    const out: string[] = [];
    call.argTexts.forEach((text, i) => {
      const literal = call.argLiterals[i];
      if (literal !== null && literal !== undefined) {
        out.push(literal);
        return;
      }
      const folded = index.resolveConstant(text, ctx);
      if (folded !== undefined) {
        out.push(folded);
        return;
      }
      // `StringUtils.split(urlPatterns, ",")` with `@Value("${xss.urlPatterns}") String urlPatterns`
      for (const id of text.match(/\b[a-z]\w*\b/g) ?? []) {
        const f = fieldOf(ctx, id);
        const value = annotationStrings(hasAnnotation(f?.field.annotations ?? [], "Value"), "value")?.[0];
        if (value) {
          out.push(...svc.config.resolve(value).value.split(",").map((s) => s.trim()).filter(Boolean));
          return;
        }
      }
    });
    return out;
  };

  const securityOrder: TypeRef[] = [];
  for (const ref of index.types) {
    for (const m of ref.type.methods) {
      for (const call of m.calls) {
        if (/^addFilter(Before|After|At)?$/.test(call.method)) {
          const filter = typeFromArg(call.argTexts[0], ref, m);
          if (!filter || securityOrder.includes(filter)) continue;
          const relative = /^([\w.]+)\.class$/.exec(call.argTexts[1] ?? "")?.[1];
          const anchor = relative ? securityOrder.findIndex((f) => simpleTypeName(f) === relative.slice(relative.lastIndexOf(".") + 1)) : -1;
          if (call.method === "addFilterBefore" && anchor >= 0) securityOrder.splice(anchor, 0, filter);
          else if (call.method === "addFilterAfter" && anchor >= 0) securityOrder.splice(anchor + 1, 0, filter);
          else securityOrder.push(filter);
        }
      }
      if (!hasAnnotation(m.annotations, "Bean")) continue;
      const setFilter = m.calls.find((c) => c.method === "setFilter");
      if (!setFilter) continue;
      const filter = typeFromArg(setFilter.argTexts[0], ref, m);
      if (!filter) continue;
      const patterns = m.calls.filter((c) => c.method === "addUrlPatterns").flatMap((c) => resolveUrlPatterns(c, ref));
      const order = orderValue(m.calls.find((c) => c.method === "setOrder")?.argTexts[0]) ?? LOWEST;
      filters.push({ ref: filter, patterns: patterns.length > 0 ? patterns : ["/*"], order, seq: seq++ });
    }
  }
  securityOrder.forEach((ref, i) => {
    if (!filters.some((f) => f.ref === ref)) filters.push({ ref, patterns: ["/*"], order: SECURITY_CHAIN_ORDER, seq: i });
  });
  for (const ref of index.types) {
    if (filters.some((f) => f.ref === ref) || !isFilterType(ref) || !hasAnnotation(ref.type.annotations, "Component")) continue;
    const order = orderValue(annotationExpr(hasAnnotation(ref.type.annotations, "Order"), "value") ?? annotationStrings(hasAnnotation(ref.type.annotations, "Order"), "value")?.[0]) ?? LOWEST;
    filters.push({ ref, patterns: ["/*"], order, seq: seq++ });
  }
  filters.sort((a, b) => a.order - b.order || a.seq - b.seq);

  // ── Interceptors ──────────────────────────────────────────────────────────
  const interceptors: InterceptorInfo[] = [];
  for (const ref of index.types) {
    const add = ref.type.methods.find((m) => m.name === "addInterceptors");
    if (!add) continue;
    for (const call of add.calls) {
      if (call.method !== "addInterceptor") continue;
      const target = typeFromArg(call.argTexts[0], ref, add);
      if (!target) continue;
      const chainPrefix = `${call.receiver ?? ""}.addInterceptor(${(call.argTexts[0] ?? "").replace(/\s+/g, "")})`;
      const chained = add.calls.filter((c) => (c.receiver ?? "").startsWith(chainPrefix));
      const collect = (name: string) =>
        chained
          .filter((c) => c.method === name)
          .flatMap((c) => c.argTexts.flatMap((t, i) => (c.argLiterals[i] ? [c.argLiterals[i] as string] : splitArrayElements(t).map((e) => javaStringLiteralText(e) ?? index.resolveConstant(e, ref) ?? ""))))
          .filter(Boolean);
      const include = collect("addPathPatterns");
      const order = orderValue(chained.find((c) => c.method === "order")?.argTexts[0]) ?? 0;
      interceptors.push({ ref: target, include: include.length > 0 ? include : ["/**"], exclude: collect("excludePathPatterns"), order, seq: seq++ });
    }
  }
  interceptors.sort((a, b) => a.order - b.order || a.seq - b.seq);

  const filterStep = (ref: TypeRef): string => {
    const m = ref.type.methods.find((x) => x.name === "doFilterInternal" || x.name === "doFilter");
    return m ? step("filter", `${ref.type.fqcn}#filter`, symbolOf(ref, m)) : step("filter", `${ref.type.fqcn}#filter`, typeSymbol(ref, simpleTypeName(ref)));
  };
  const interceptorStep = (ref: TypeRef): string => {
    const m = ref.type.methods.find((x) => x.name === "preHandle") ?? index.findMethods(ref, "preHandle", 3)[0]?.method;
    return m ? step("interceptor", `${ref.type.fqcn}#preHandle`, symbolOf(ref, m)) : step("interceptor", `${ref.type.fqcn}#preHandle`, typeSymbol(ref, simpleTypeName(ref)));
  };

  // ── Entrypoints ───────────────────────────────────────────────────────────
  for (const ref of index.types) {
    const names = ref.type.annotations.map((a) => a.name);
    const isController = names.includes("RestController") || names.includes("Controller");
    for (const method of ref.type.methods) {
      const m: MethodRef = { owner: ref, method };
      const scheduled = hasAnnotation(method.annotations, "Scheduled");
      if (scheduled && index.isBean(ref)) {
        const symbol = symbolOf(ref, method);
        const entrypoint: Entrypoint = { id: stableId("entrypoint", service.name, `scheduled:${symbol.fqn}`), serviceId: service.id, kind: "scheduled", handler: symbol };
        graph.addEntrypoint(entrypoint);
        const handlerStepId = step("service", symbol.fqn, symbol);
        expand(m, handlerStepId);
        result.scheduled.push({ entrypoint, handlerStepId });
      }
      if (!isController) continue;
      const mapping = method.annotations.find((a) => a.name in MAPPING_ANNOTATIONS);
      if (!mapping) continue;
      const classPaths = mappingPaths(hasAnnotation(ref.type.annotations, "RequestMapping"), ref);
      const methodPaths = mappingPaths(mapping, ref);
      const symbol = symbolOf(ref, method);
      const handlerStepId = step("controller", symbol.fqn, symbol);
      expand(m, handlerStepId);

      for (const httpMethod of httpMethods(mapping)) {
        for (const cp of classPaths.length > 0 ? classPaths : [""]) {
          for (const mp of methodPaths) {
            const path = normalizeHttpPath(`${svc.contextPath}/${cp}/${mp}`);
            // Handlers differing only by params/headers/consumes share METHOD+path: keep both, distinct ids.
            let entrypointId = stableId("entrypoint", service.name, httpKey(httpMethod, path));
            const existing = graph.entrypoints.get(entrypointId);
            if (existing && existing.handler.fqn !== symbol.fqn) {
              entrypointId = stableId("entrypoint", service.name, `${httpKey(httpMethod, path)}#${symbol.fqn}`);
              diagnostics.push({ code: "ATLAS-I005", severity: "info", message: `${httpMethod} ${path} is mapped by several handlers (request conditions such as params/headers): ${existing.handler.name}, ${symbol.name}`, at: symbol });
            } else if (existing) {
              continue;
            }
            const entrypoint: Entrypoint = {
              id: entrypointId,
              serviceId: service.id,
              kind: "http",
              method: httpMethod,
              path,
              handler: symbol,
            };
            graph.addEntrypoint(entrypoint);
            const discriminator = GraphBuilder.chainDiscriminator(entrypoint.id);
            const chainStepIds: string[] = [];
            for (const f of filters) if (f.patterns.some((p) => servletPatternMatch(p, path))) chainStepIds.push(filterStep(f.ref));
            for (const i of interceptors) {
              if (i.include.some((p) => antMatch(p, path)) && !i.exclude.some((p) => antMatch(p, path))) chainStepIds.push(interceptorStep(i.ref));
            }
            const security = hasAnnotation(method.annotations, ...SECURITY_ANNOTATIONS) ?? hasAnnotation(ref.type.annotations, ...SECURITY_ANNOTATIONS);
            if (security) {
              const expr = annotationStrings(security, "value")?.[0] ?? "";
              chainStepIds.push(step("interceptor", `${symbol.fqn}@${security.name}`, { ...symbol, line: security.line, name: `@${security.name}(${expr})` }));
            }
            chainStepIds.push(...aspectSteps(m, ref));
            const unique = chainStepIds.filter((id, i) => chainStepIds.indexOf(id) === i);
            const chainEdgeIds: string[] = [];
            [...unique, handlerStepId].reduce((prev, next) => {
              if (prev) chainEdgeIds.push(graph.edge(prev, next, { provenance: "framework-rule", discriminator }));
              return next;
            }, "");
            result.chains.push({ entrypoint, chainStepIds: unique, chainEdgeIds, handlerStepId });
          }
        }
      }
    }
  }

  mq.collectConsumers();
  mq.finishTopology();
  result.mq = mq.result;
  return result;
}


