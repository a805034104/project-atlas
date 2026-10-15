import { rawTypeName } from "../facts/java.js";
import type { JavaAnnotation, JavaCall, JavaMethod } from "../facts/types.js";
import type { GraphBuilder } from "../graph/builder.js";
import { stableId } from "../model/ids.js";
import type { Diagnostic, Entrypoint, ServiceLink, SourceRef, SymbolRef } from "../model/types.js";
import type { JavaService } from "../workspace/detect.js";
import { annotationExpr, annotationStrings, hasAnnotation, type JavaIndex, type MethodRef, type TypeRef } from "./java-index.js";
import { splitArrayElements } from "./java-literals.js";

/**
 * Message-queue links (Java side, v0.2): Kafka, RabbitMQ, RocketMQ, Redis Stream,
 * Spring Cloud Stream.
 *
 *   producer call ─▶ send step (layer mq) ─┐  pairing key, resolved through constants,
 *                                          ├─ enum getters and config placeholders
 *   @XxxListener / container ─▶ consumer ──┘  ─▶ call edge send → handler + ServiceLink(kind mq)
 *
 *   kafka          topic (+ topicPattern, template default topic)
 *   rabbitmq       exchange + routing key ─▶ bindings (direct | topic * # | fanout | default "")
 *                  ─▶ queue ◀─ @RabbitListener(queues | queuesToDeclare | bindings)
 *   rocketmq       "topic:tag" ◀─ @RocketMQMessageListener(topic, selectorExpression "a || b" | *)
 *   redis-stream   stream key (opsForStream().add / StreamRecords / xadd) ◀─ container receive / read
 *   stream         Spring Cloud Stream destination (bindings.<name>.destination, default = name)
 *
 * A destination that does not fold to a literal is never guessed: the send step
 * stays, an UnresolvedCall + ATLAS-W034 explain why there is no link.
 */

export type MqBroker = "kafka" | "rabbitmq" | "rocketmq" | "redis-stream" | "stream";

export interface MqSendSite {
  stepId: string;
  serviceId: string;
  broker: MqBroker;
  /** kafka/rocketmq topic, redis stream key, SCS destination, rabbit exchange ("" = default). */
  destination: string;
  /** rabbit routing key / rocketmq tag. */
  key?: string;
  at: SymbolRef;
}

export interface MqConsumerSite {
  entrypoint: Entrypoint;
  handlerStepId: string;
  broker: MqBroker;
  /** Topics, queues, stream keys or SCS destinations. */
  destinations: string[];
  pattern?: RegExp;
  /** RocketMQ tag filter; undefined = every tag. */
  tags?: string[];
  at: SymbolRef;
}

export interface RabbitBinding {
  queue: string;
  exchange: string;
  key: string;
}

export interface RabbitTopology {
  /** exchange name → type */
  exchanges: Map<string, RabbitExchangeType>;
  bindings: RabbitBinding[];
  /** queue → dead-letter target (`x-dead-letter-exchange` / `x-dead-letter-routing-key`). */
  deadLetters: Map<string, { exchange: string; key?: string }>;
}

type RabbitExchangeType = "direct" | "topic" | "fanout" | "headers";

const SEND_METHODS: Record<MqBroker, ReadonlySet<string>> = {
  kafka: new Set(["send", "sendDefault"]),
  rabbitmq: new Set(["convertAndSend", "send", "convertSendAndReceive", "sendAndReceive", "convertSendAndReceiveAsType"]),
  rocketmq: new Set([
    "send", "syncSend", "asyncSend", "sendOneWay", "convertAndSend", "syncSendOrderly", "asyncSendOrderly", "sendOneWayOrderly",
    "syncSendDelayTimeSeconds", "syncSendDelayTimeMills", "syncSendDeliverTimeMills", "sendMessageInTransaction", "sendAndReceive",
  ]),
  "redis-stream": new Set(["add", "xadd"]),
  stream: new Set(["send"]),
};

/** Receiver types (simple names) that send messages, by broker. */
export const MQ_CLIENT_TYPES: Record<string, MqBroker> = {
  KafkaTemplate: "kafka",
  ReplyingKafkaTemplate: "kafka",
  RabbitTemplate: "rabbitmq",
  AmqpTemplate: "rabbitmq",
  RabbitMessagingTemplate: "rabbitmq",
  RabbitOperations: "rabbitmq",
  RocketMQTemplate: "rocketmq",
  StreamBridge: "stream",
  StreamOperations: "redis-stream",
  Jedis: "redis-stream",
  JedisCluster: "redis-stream",
  JedisPooled: "redis-stream",
  UnifiedJedis: "redis-stream",
};
export const REDIS_TEMPLATE_TYPES = new Set(["RedisTemplate", "StringRedisTemplate", "ReactiveRedisTemplate", "ReactiveStringRedisTemplate"]);

const EXCHANGE_CLASSES: Record<string, RabbitExchangeType> = {
  DirectExchange: "direct",
  TopicExchange: "topic",
  FanoutExchange: "fanout",
  HeadersExchange: "headers",
};
const EXCHANGE_BUILDERS: Record<string, RabbitExchangeType> = {
  directExchange: "direct",
  topicExchange: "topic",
  fanoutExchange: "fanout",
  headersExchange: "headers",
};
const BROKER_LABEL: Record<MqBroker, string> = {
  kafka: "KAFKA",
  rabbitmq: "RABBITMQ",
  rocketmq: "ROCKETMQ",
  "redis-stream": "REDIS-STREAM",
  stream: "STREAM",
};

// ── Expression helpers ───────────────────────────────────────────────────────

/** Parse `@Name(a = x, b = {..})` / `@Name("v")` text into name + raw argument texts. */
export function parseAnnotationText(text: string): { name: string; args: Record<string, string> } | undefined {
  const m = /^@([\w.]+)\s*(?:\(([\s\S]*)\))?\s*$/.exec(text.trim());
  if (!m) return undefined;
  const name = (m[1] as string).slice((m[1] as string).lastIndexOf(".") + 1);
  const args: Record<string, string> = {};
  const body = m[2]?.trim();
  if (body) {
    const parts = splitArrayElements(`{${body}}`);
    for (const part of parts) {
      const eq = topLevelEquals(part);
      if (eq < 0) args["value"] = part.trim();
      else args[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
  }
  return { name, args };
}

function topLevelEquals(text: string): number {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && text[i - 1] !== "\\") inString = !inString;
    if (inString) continue;
    if (ch === "(" || ch === "{") depth++;
    else if (ch === ")" || ch === "}") depth--;
    else if (ch === "=" && depth === 0 && text[i + 1] !== "=" && text[i - 1] !== "=" && text[i - 1] !== "!") return i;
  }
  return -1;
}

/** AMQP topic matching: words split on `.`, `*` = exactly one word, `#` = zero or more. */
export function amqpTopicMatch(pattern: string, key: string): boolean {
  const p = pattern.split(".");
  const k = key.split(".");
  const memo = new Map<string, boolean>();
  const go = (i: number, j: number): boolean => {
    const id = `${i},${j}`;
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    let r: boolean;
    if (i === p.length) r = j === k.length;
    else if (p[i] === "#") r = go(i + 1, j) || (j < k.length && go(i, j + 1));
    else r = j < k.length && (p[i] === "*" || p[i] === k[j]) && go(i + 1, j + 1);
    memo.set(id, r);
    return r;
  };
  return go(0, 0);
}

export function rocketTags(expression: string | undefined): string[] | undefined {
  const t = (expression ?? "*").trim();
  if (t === "" || t === "*") return undefined;
  return t.split("||").map((s) => s.trim()).filter(Boolean);
}

// ── Per-service collector ────────────────────────────────────────────────────

export interface MqCollectorContext {
  svc: JavaService;
  index: JavaIndex;
  graph: GraphBuilder;
  diagnostics: Diagnostic[];
  symbolOf(owner: TypeRef, method: JavaMethod): SymbolRef;
  /** Handler step for a consumer method, with its call graph expanded. */
  handlerStep(m: MethodRef): string;
}

export interface MqServiceResult {
  sends: MqSendSite[];
  consumers: MqConsumerSite[];
  topology: RabbitTopology;
}

export class MqCollector {
  readonly result: MqServiceResult = { sends: [], consumers: [], topology: { exchanges: new Map(), bindings: [], deadLetters: new Map() } };

  constructor(private readonly ctx: MqCollectorContext) {}

  private get service() {
    return this.ctx.svc.service;
  }

  /** Fold an expression to a literal: string literal, constant, enum getter, then `${}` placeholders. */
  resolve(expr: string | undefined, owner: TypeRef): string | undefined {
    if (expr === undefined) return undefined;
    const text = expr.trim();
    const folded = this.ctx.index.resolveConstant(text, owner) ?? this.enumGetter(text, owner);
    return folded === undefined ? undefined : this.placeholders(folded);
  }

  /** `${..}` placeholders through the service config; SpEL `#{..}` is never evaluated. */
  private placeholders(value: string): string | undefined {
    const resolved = this.ctx.svc.config.resolve(value);
    return resolved.unresolved.length === 0 && !/#\{/.test(resolved.value) ? resolved.value : undefined;
  }

  /** `QueueEnum.ORDER_CANCEL.getExchange()` → constructor argument bound to field `exchange`. */
  private enumGetter(text: string, owner: TypeRef): string | undefined {
    const m = /^([\w.]+)\.([A-Z][A-Z0-9_]*)\.(?:get|is)?(\w+)\(\)$/.exec(text);
    if (!m) return undefined;
    const enumType = this.ctx.index.resolveType(m[1] as string, owner);
    const constant = enumType?.type.enumConstants.find((c) => c.name === m[2]);
    if (!enumType || !constant) return undefined;
    const fieldName = (m[3] as string).charAt(0).toLowerCase() + (m[3] as string).slice(1);
    const instanceFields = enumType.type.fields.filter((f) => !f.modifiers.includes("static"));
    const ctor = enumType.type.methods.find((x) => x.isConstructor && x.params.length === constant.argTexts.length);
    let position = ctor ? ctor.params.findIndex((p) => p.name === fieldName) : -1;
    if (position < 0 && !ctor && hasAnnotation(enumType.type.annotations, "AllArgsConstructor")) position = instanceFields.findIndex((f) => f.name === fieldName);
    if (position < 0) return undefined;
    const arg = constant.argTexts[position];
    return arg === undefined ? undefined : this.ctx.index.resolveConstant(arg, enumType);
  }

  private annotationValues(a: JavaAnnotation | undefined, owner: TypeRef, ...keys: string[]): string[] | undefined {
    if (!a) return undefined;
    const literal = annotationStrings(a, ...keys);
    const raw = literal ?? (annotationExpr(a, ...keys) ? splitArrayElements(annotationExpr(a, ...keys) as string) : undefined);
    if (!raw) return undefined;
    const out: string[] = [];
    for (const r of raw) {
      const v = literal ? this.placeholders(r) : this.resolve(r, owner);
      if (v === undefined) return undefined;
      out.push(...v.split(",").map((s) => s.trim()).filter(Boolean));
    }
    return out;
  }

  private unresolved(fromStepId: string, expression: string, at: SymbolRef, what: string): void {
    this.ctx.graph.unresolved.push({ fromStepId, expression, reason: "unresolved-config", at });
    this.ctx.diagnostics.push({ code: "ATLAS-W034", severity: "warning", message: `Unresolved ${what}: ${expression}`, at: { rootId: at.rootId, file: at.file, line: at.line ?? 1 } });
  }

  // ── Producers ──────────────────────────────────────────────────────────────

  /**
   * A call on an MQ client (`kafkaTemplate.send(..)`, `redisTemplate.opsForStream().add(..)`,
   * declared mq wrappers). Returns true when the call was recognised as a send.
   */
  recordSend(fromStep: string, broker: MqBroker, call: JavaCall, owner: TypeRef, at: SymbolRef, wrapper?: { topicArg?: number }): boolean {
    if (!wrapper && !SEND_METHODS[broker].has(call.method)) return false;
    const parsed = wrapper ? this.wrapperDestination(broker, call, owner, wrapper.topicArg ?? 0) : this.destinationOf(broker, call, owner);
    const label = parsed ? `${broker}:${parsed.destination || "(default)"}${parsed.key ? ` / ${parsed.key}` : ""}` : `${broker}:?`;
    const stepId = this.ctx.graph.step(this.service.id, this.service.name, "mq", `mq-send:${broker}:${at.fqn}:${at.line}`, { ...at, name: `send ${label}` });
    this.ctx.graph.edge(fromStep, stepId, { provenance: wrapper ? "framework-rule" : "static", rationale: `${call.receiver ?? ""}.${call.method}` });
    if (!parsed) {
      this.unresolved(stepId, `${call.receiver ?? ""}.${call.method}(${call.argTexts.join(", ")})`, at, `${broker} destination`);
      return true;
    }
    this.result.sends.push({ stepId, serviceId: this.service.id, broker, destination: parsed.destination, ...(parsed.key !== undefined ? { key: parsed.key } : {}), at });
    return true;
  }

  private wrapperDestination(broker: MqBroker, call: JavaCall, owner: TypeRef, topicArg: number): { destination: string; key?: string } | undefined {
    const value = this.resolve(call.argTexts[topicArg], owner);
    if (value === undefined) return undefined;
    if (broker === "rocketmq") return splitRocketDestination(value);
    return { destination: value };
  }

  private destinationOf(broker: MqBroker, call: JavaCall, owner: TypeRef): { destination: string; key?: string } | undefined {
    const args = call.argTexts;
    const config = (key: string) => this.ctx.svc.config.value(key);
    switch (broker) {
      case "kafka": {
        if (call.method === "sendDefault") {
          const def = config("spring.kafka.template.default-topic");
          return def && def.unresolved.length === 0 ? { destination: def.value } : undefined;
        }
        const first = args[0] ?? "";
        const record = /^new\s+ProducerRecord\s*(?:<[^>]*>)?\s*\(([\s\S]*)\)$/.exec(first);
        const topic = this.resolve(record ? splitArrayElements(`{${record[1]}}`)[0] : first, owner);
        return topic === undefined ? undefined : { destination: topic };
      }
      case "rocketmq": {
        const dest = this.resolve(args[0], owner);
        return dest === undefined ? undefined : splitRocketDestination(dest);
      }
      case "stream": {
        const binding = this.resolve(args[0], owner);
        if (binding === undefined) return undefined;
        return { destination: this.streamDestination(binding) };
      }
      case "redis-stream": {
        const first = args[0] ?? "";
        const recordKey =
          /\.in\(\s*([^()]+?)\s*\)/.exec(first)?.[1] ??
          /\.withStreamKey\(\s*([^()]+?)\s*\)/.exec(first)?.[1] ??
          /\b(?:MapRecord|ObjectRecord|StreamRecords\.(?:mapBacked|objectBacked|rawBytes|string))\s*\.\s*create\(\s*([^,()]+)/.exec(first)?.[1];
        const key = this.resolve(recordKey ?? first, owner);
        return key === undefined ? undefined : { destination: key };
      }
      case "rabbitmq": {
        const defaultExchange = config("spring.rabbitmq.template.exchange")?.value ?? "";
        const defaultKey = config("spring.rabbitmq.template.routing-key")?.value ?? "";
        const trailingCallback = (t: string | undefined) => !!t && (/->/.test(t) || /^new\s+(MessagePostProcessor|CorrelationData)\b/.test(t) || /(postProcessor|correlation)/i.test(t));
        let exchangeExpr: string | undefined;
        let keyExpr: string | undefined;
        if (args.length >= 4 || (args.length === 3 && !trailingCallback(args[2]))) {
          exchangeExpr = args[0];
          keyExpr = args[1];
        } else if (args.length >= 2) {
          keyExpr = args[0];
        } else {
          return defaultKey || defaultExchange ? { destination: defaultExchange, key: defaultKey } : undefined;
        }
        const exchange = exchangeExpr === undefined ? defaultExchange : this.resolve(exchangeExpr, owner);
        const key = this.resolve(keyExpr, owner);
        return exchange === undefined || key === undefined ? undefined : { destination: exchange, key };
      }
    }
  }

  private streamDestination(binding: string): string {
    const configured = this.ctx.svc.config.value(`spring.cloud.stream.bindings.${binding}.destination`);
    return configured && configured.unresolved.length === 0 ? configured.value : binding;
  }

  // ── Consumers ──────────────────────────────────────────────────────────────

  /** Scan the service for listener methods and listener containers. */
  collectConsumers(): void {
    const { index } = this.ctx;
    const streamFunctions = this.streamFunctionNames();
    for (const ref of index.types) {
      if (!index.isBean(ref) && !hasAnnotation(ref.type.annotations, "RocketMQMessageListener")) continue;
      const classKafka = hasAnnotation(ref.type.annotations, "KafkaListener");
      const classRabbit = hasAnnotation(ref.type.annotations, "RabbitListener");
      const rocket = hasAnnotation(ref.type.annotations, "RocketMQMessageListener");
      for (const method of ref.type.methods) {
        const m: MethodRef = { owner: ref, method };
        const kafka = hasAnnotation(method.annotations, "KafkaListener") ?? (classKafka && hasAnnotation(method.annotations, "KafkaHandler") ? classKafka : undefined);
        if (kafka) this.kafkaConsumer(m, kafka);
        const rabbit = hasAnnotation(method.annotations, "RabbitListener") ?? (classRabbit && hasAnnotation(method.annotations, "RabbitHandler") ? classRabbit : undefined);
        if (rabbit) this.rabbitConsumer(m, rabbit);
        if (rocket && method.name === "onMessage" && !method.modifiers.includes("static")) this.rocketConsumer(m, rocket);
        if (hasAnnotation(method.annotations, "Bean")) {
          this.rabbitDeclarations(m);
          const fn = simpleName(rawTypeName(method.returnType));
          if ((fn === "Consumer" || fn === "Function") && streamFunctions.has(method.name)) {
            const binding = `${method.name}-in-0`;
            this.addConsumer(m, "stream", [this.streamDestination(binding)]);
          }
        }
        const legacy = hasAnnotation(method.annotations, "StreamListener");
        if (legacy) {
          const binding = this.annotationValues(legacy, ref, "value", "target")?.[0];
          if (binding) this.addConsumer(m, "stream", [this.streamDestination(binding)]);
        }
        this.redisStreamConsumers(m);
      }
    }
  }

  /** Functional SCS bindings exist only when the function is declared to the binder. */
  private streamFunctionNames(): Set<string> {
    const names = new Set<string>();
    const definition = this.ctx.svc.config.value("spring.cloud.function.definition")?.value;
    for (const n of (definition ?? "").split(/[;|,]/)) if (n.trim()) names.add(n.trim());
    for (const e of this.ctx.svc.config.list("spring.cloud.stream.bindings")) {
      const m = /bindings\.([\w$]+)-in-\d+\./i.exec(e.key);
      if (m) names.add(m[1] as string);
    }
    return names;
  }

  private addConsumer(m: MethodRef, broker: MqBroker, destinations: string[], extra: { pattern?: RegExp; tags?: string[] } = {}): void {
    const symbol = this.ctx.symbolOf(m.owner, m.method);
    const channel = extra.pattern ? `/${extra.pattern.source}/` : destinations.join(",");
    const entrypoint: Entrypoint = {
      id: stableId("entrypoint", this.service.name, `mq:${broker}:${channel}${extra.tags ? `:${extra.tags.join("||")}` : ""}#${symbol.fqn}`),
      serviceId: this.service.id,
      kind: "mq-consumer",
      method: BROKER_LABEL[broker],
      path: extra.tags ? `${channel}:${extra.tags.join("||")}` : channel,
      handler: symbol,
    };
    if (this.ctx.graph.entrypoints.has(entrypoint.id)) return;
    this.ctx.graph.addEntrypoint(entrypoint);
    const handlerStepId = this.ctx.handlerStep(m);
    this.result.consumers.push({ entrypoint, handlerStepId, broker, destinations, ...extra, at: symbol });
  }

  private consumerUnresolved(m: MethodRef, a: JavaAnnotation, what: string): void {
    const at = { ...this.ctx.symbolOf(m.owner, m.method), line: a.line };
    this.ctx.diagnostics.push({ code: "ATLAS-W034", severity: "warning", message: `Unresolved ${what} on @${a.name} ${at.name}`, at: { rootId: at.rootId, file: at.file, line: at.line ?? 1 } });
  }

  private kafkaConsumer(m: MethodRef, a: JavaAnnotation): void {
    const topics = this.annotationValues(a, m.owner, "topics", "value");
    const patternText = this.annotationValues(a, m.owner, "topicPattern")?.[0];
    if (topics && topics.length > 0) this.addConsumer(m, "kafka", topics);
    else if (patternText) {
      try {
        this.addConsumer(m, "kafka", [], { pattern: new RegExp(`^(?:${patternText})$`) });
      } catch {
        this.consumerUnresolved(m, a, "Kafka topicPattern");
      }
    } else if (a.args["topicPartitions"]) {
      const t = /topic\s*=\s*("[^"]*"|[\w.]+)/.exec(annotationExpr(a, "topicPartitions") ?? "")?.[1];
      const topic = this.resolve(t, m.owner);
      if (topic) this.addConsumer(m, "kafka", [topic]);
      else this.consumerUnresolved(m, a, "Kafka topic");
    } else this.consumerUnresolved(m, a, "Kafka topic");
  }

  private rabbitConsumer(m: MethodRef, a: JavaAnnotation): void {
    const queues: string[] = [];
    let ok = true;
    const direct = a.args["queues"] ? this.annotationValues(a, m.owner, "queues") : undefined;
    if (a.args["queues"] && !direct) ok = false;
    queues.push(...(direct ?? []));
    for (const key of ["queuesToDeclare", "bindings"]) {
      const text = a.args[key]?.kind === "expr" ? (a.args[key] as { text: string }).text : undefined;
      if (!text) continue;
      for (const element of splitArrayElements(text)) {
        const parsed = parseAnnotationText(element);
        if (!parsed) {
          ok = false;
          continue;
        }
        if (parsed.name === "Queue") {
          const q = this.queueName(parsed, m.owner);
          if (q) queues.push(q);
          else ok = false;
        } else if (parsed.name === "QueueBinding") {
          const q = parsed.args["value"] ? parseAnnotationText(parsed.args["value"]) : undefined;
          const ex = parsed.args["exchange"] ? parseAnnotationText(parsed.args["exchange"]) : undefined;
          const queue = q ? this.queueName(q, m.owner) : undefined;
          const exchange = ex ? this.resolve(ex.args["value"] ?? ex.args["name"], m.owner) : undefined;
          if (!queue || exchange === undefined) {
            ok = false;
            continue;
          }
          queues.push(queue);
          const typeText = ex?.args["type"] ?? "";
          const type = (/TOPIC|"topic"/i.test(typeText) ? "topic" : /FANOUT|"fanout"/i.test(typeText) ? "fanout" : /HEADERS|"headers"/i.test(typeText) ? "headers" : "direct") as RabbitExchangeType;
          if (!this.result.topology.exchanges.has(exchange)) this.result.topology.exchanges.set(exchange, type);
          const keys = parsed.args["key"] ? splitArrayElements(parsed.args["key"]).map((k) => this.resolve(k, m.owner)) : [""];
          for (const key of keys) {
            if (key === undefined) ok = false;
            else this.result.topology.bindings.push({ queue, exchange, key });
          }
        }
      }
    }
    if (queues.length > 0) this.addConsumer(m, "rabbitmq", [...new Set(queues)]);
    if (!ok || queues.length === 0) this.consumerUnresolved(m, a, "RabbitMQ queue");
  }

  private queueName(parsed: { args: Record<string, string> }, owner: TypeRef): string | undefined {
    const expr = parsed.args["value"] ?? parsed.args["name"];
    return expr === undefined ? undefined : this.resolve(expr, owner);
  }

  private rocketConsumer(m: MethodRef, a: JavaAnnotation): void {
    const topic = this.annotationValues(a, m.owner, "topic")?.[0];
    const selectorType = annotationExpr(a, "selectorType") ?? annotationStrings(a, "selectorType")?.[0] ?? "";
    if (!topic) return this.consumerUnresolved(m, a, "RocketMQ topic");
    if (/SQL92/i.test(selectorType)) return this.consumerUnresolved(m, a, "RocketMQ SQL92 selector");
    const expression = a.args["selectorExpression"] ? this.annotationValues(a, m.owner, "selectorExpression")?.[0] : "*";
    if (expression === undefined) return this.consumerUnresolved(m, a, "RocketMQ selectorExpression");
    const tags = rocketTags(expression);
    this.addConsumer(m, "rocketmq", [topic], tags ? { tags } : {});
  }

  /** `container.receive(.., StreamOffset.create(key, ..), listener)` or `opsForStream().read(.., StreamOffset.create(key, ..))`. */
  private redisStreamConsumers(m: MethodRef): void {
    for (const call of m.method.calls) {
      const offsetArg = call.argTexts.find((t) => /StreamOffset\s*\.\s*(create|fromStart|latest)\s*\(/.test(t));
      if (!offsetArg) continue;
      const isContainer = ["receive", "receiveAutoAck", "register"].includes(call.method);
      const isRead = call.method === "read" && /opsForStream\(\)$/.test(call.receiver ?? "");
      if (!isContainer && !isRead) continue;
      const keyExpr = /StreamOffset\s*\.\s*(?:create|fromStart|latest)\s*\(\s*([^,()]+(?:\([^()]*\))?)/.exec(offsetArg)?.[1];
      const key = this.resolve(keyExpr, m.owner);
      const at = { ...this.ctx.symbolOf(m.owner, m.method), line: call.line };
      if (key === undefined) {
        this.ctx.diagnostics.push({ code: "ATLAS-W034", severity: "warning", message: `Unresolved Redis stream key: ${offsetArg}`, at: { rootId: at.rootId, file: at.file, line: at.line ?? 1 } });
        continue;
      }
      const handler = isContainer ? this.listenerMethod(call.argTexts[call.argTexts.length - 1], m) : m;
      this.addConsumer(handler ?? m, "redis-stream", [key]);
    }
  }

  /** The `onMessage` of the listener argument (`this`, field, `new X()`); lambdas stay in the registering method. */
  private listenerMethod(text: string | undefined, ctx: MethodRef): MethodRef | undefined {
    if (!text) return undefined;
    const { index } = this.ctx;
    let type: TypeRef | undefined;
    if (text === "this") type = ctx.owner;
    else if (/^new\s+([\w.]+)/.test(text)) type = index.resolveType(/^new\s+([\w.]+)/.exec(text)?.[1] as string, ctx.owner);
    else if (/^[\w$]+$/.test(text)) {
      const local = ctx.method.locals[text] ?? ctx.method.params.find((p) => p.name === text)?.type ?? ctx.owner.type.fields.find((f) => f.name === text)?.type;
      if (local) type = index.resolveType(local, ctx.owner);
    }
    const onMessage = type ? index.findMethods(type, "onMessage", 1)[0] : undefined;
    return onMessage;
  }

  // ── RabbitMQ declarations (@Bean Queue / Exchange / Binding / Declarables) ───

  private beanQueues = new Map<string, string>();
  private beanExchanges = new Map<string, string>();
  private pendingBindings: { m: MethodRef; call?: JavaCall; creation?: { argTexts: string[] } }[] = [];

  private rabbitDeclarations(m: MethodRef): void {
    const ret = simpleName(rawTypeName(m.method.returnType));
    const declared = this.declaredInBody(m);
    if (ret === "Queue" && declared.queues[0]) this.beanQueues.set(m.method.name, declared.queues[0]);
    if (declared.queues.length === 1 && declared.deadLetter) this.result.topology.deadLetters.set(declared.queues[0] as string, declared.deadLetter);
    if ((ret in EXCHANGE_CLASSES || ret === "Exchange" || ret === "CustomExchange") && declared.exchanges[0]) this.beanExchanges.set(m.method.name, declared.exchanges[0].name);
    for (const e of declared.exchanges) if (!this.result.topology.exchanges.has(e.name)) this.result.topology.exchanges.set(e.name, e.type);
    if (ret === "Binding" || ret === "Declarables" || ret === "BindingBuilder") {
      for (const call of m.method.calls) if (call.method === "with" || (call.method === "to" && !m.method.calls.some((c) => c.method === "with" && c.line === call.line))) this.pendingBindings.push({ m, call });
      for (const c of m.method.creations) if (simpleName(rawTypeName(c.type)) === "Binding") this.pendingBindings.push({ m, creation: c });
    }
  }

  private declaredInBody(m: MethodRef): { queues: string[]; exchanges: { name: string; type: RabbitExchangeType }[]; deadLetter?: { exchange: string; key?: string } } {
    const queues: string[] = [];
    const exchanges: { name: string; type: RabbitExchangeType }[] = [];
    let dlExchange: string | undefined;
    let dlKey: string | undefined;
    for (const c of m.method.creations) {
      const t = simpleName(rawTypeName(c.type));
      const name = this.resolve(c.argTexts[0], m.owner);
      if (name === undefined) continue;
      if (t === "Queue" || t === "AnonymousQueue") queues.push(name);
      else if (t in EXCHANGE_CLASSES) exchanges.push({ name, type: EXCHANGE_CLASSES[t] as RabbitExchangeType });
    }
    for (const call of m.method.calls) {
      if (call.receiver === "QueueBuilder" && (call.method === "durable" || call.method === "nonDurable")) {
        const name = this.resolve(call.argTexts[0], m.owner);
        if (name !== undefined) queues.push(name);
      }
      if (call.receiver === "ExchangeBuilder" && call.method in EXCHANGE_BUILDERS) {
        const name = this.resolve(call.argTexts[0], m.owner);
        if (name !== undefined) exchanges.push({ name, type: EXCHANGE_BUILDERS[call.method] as RabbitExchangeType });
      }
      // QueueBuilder.withArgument("x-dead-letter-exchange", x) / deadLetterExchange(x) / args.put(..)
      const argName = call.method === "deadLetterExchange" ? "x-dead-letter-exchange" : call.method === "deadLetterRoutingKey" ? "x-dead-letter-routing-key" : ["withArgument", "put"].includes(call.method) ? call.argLiterals[0] : undefined;
      const valueText = call.method.startsWith("deadLetter") ? call.argTexts[0] : call.argTexts[1];
      if (argName === "x-dead-letter-exchange") dlExchange = this.resolve(valueText, m.owner);
      if (argName === "x-dead-letter-routing-key") dlKey = this.resolve(valueText, m.owner);
    }
    return { queues, exchanges, ...(dlExchange !== undefined ? { deadLetter: { exchange: dlExchange, ...(dlKey !== undefined ? { key: dlKey } : {}) } } : {}) };
  }

  /** Resolve pending `BindingBuilder.bind(q).to(x).with(k)` / `new Binding(..)` once every bean is known. */
  finishTopology(): void {
    for (const p of this.pendingBindings) {
      if (p.creation) {
        // new Binding(destination, DestinationType.QUEUE, exchange, routingKey, args)
        const [dest, type, exchangeExpr, keyExpr] = p.creation.argTexts;
        if (!/QUEUE/.test(type ?? "")) continue;
        const queue = this.resolve(dest, p.m.owner);
        const exchange = this.resolve(exchangeExpr, p.m.owner);
        const key = this.resolve(keyExpr, p.m.owner);
        if (queue !== undefined && exchange !== undefined && key !== undefined) this.result.topology.bindings.push({ queue, exchange, key });
        continue;
      }
      const call = p.call as JavaCall;
      // receiver text: BindingBuilder.bind(X).to(Y)  (for .with) or BindingBuilder.bind(X) (for fanout .to)
      const chain = call.method === "with" ? (call.receiver ?? "") : `${call.receiver ?? ""}.to(${call.argTexts[0] ?? ""})`;
      const m = /BindingBuilder\.bind\(([\s\S]*)\)\.to\(([\s\S]*)\)$/.exec(chain);
      if (!m) continue;
      const queue = this.beanRef(m[1] as string, p.m, "queue");
      const exchange = this.beanRef(m[2] as string, p.m, "exchange");
      const key = call.method === "with" ? this.resolve(call.argTexts[0], p.m.owner) : "";
      if (queue === undefined || exchange === undefined || key === undefined) {
        this.ctx.diagnostics.push({ code: "ATLAS-W034", severity: "warning", message: `Unresolved RabbitMQ binding in ${p.m.owner.type.name}.${p.m.method.name}`, at: { rootId: p.m.owner.file.rootId, file: p.m.owner.file.relPath, line: call.line } });
        continue;
      }
      this.result.topology.bindings.push({ queue, exchange, key });
    }
    this.pendingBindings = [];
  }

  /** `queue()` / `orderQueue` (param or field naming a @Bean) / `new Queue("q")` → name. */
  private beanRef(text: string, ctx: MethodRef, kind: "queue" | "exchange"): string | undefined {
    const t = text.trim();
    const beans = kind === "queue" ? this.beanQueues : this.beanExchanges;
    const created = /^new\s+(\w+)\s*\(\s*([^,()]+)/.exec(t);
    if (created) return this.resolve(created[2], ctx.owner);
    const builder = /^(?:QueueBuilder\.(?:durable|nonDurable)|ExchangeBuilder\.\w+)\(\s*([^,()]+)/.exec(t);
    if (builder) return this.resolve(builder[1], ctx.owner);
    const name = /^(\w+)(?:\(\))?$/.exec(t)?.[1];
    if (!name) return undefined;
    const direct = beans.get(name);
    if (direct !== undefined) return direct;
    // Parameter injected by type: unique bean of that kind with a matching declared type.
    const param = ctx.method.params.find((p) => p.name === name);
    const qualifier = param ? annotationStrings(hasAnnotation(param.annotations, "Qualifier"), "value")?.[0] : undefined;
    if (qualifier && beans.has(qualifier)) return beans.get(qualifier);
    if (param && beans.size === 1) return [...beans.values()][0];
    return undefined;
  }
}

function simpleName(type: string): string {
  return type.slice(type.lastIndexOf(".") + 1);
}

function splitRocketDestination(dest: string): { destination: string; key?: string } {
  const colon = dest.indexOf(":");
  return colon < 0 ? { destination: dest } : { destination: dest.slice(0, colon), key: dest.slice(colon + 1) };
}

// ── Linking ──────────────────────────────────────────────────────────────────

export function mergeTopology(parts: readonly RabbitTopology[]): RabbitTopology {
  const merged: RabbitTopology = { exchanges: new Map(), bindings: [], deadLetters: new Map() };
  for (const p of parts) {
    for (const [k, v] of p.exchanges) if (!merged.exchanges.has(k)) merged.exchanges.set(k, v);
    merged.bindings.push(...p.bindings);
    for (const [k, v] of p.deadLetters) if (!merged.deadLetters.has(k)) merged.deadLetters.set(k, v);
  }
  return merged;
}

/** Queues reached by publishing to `exchange` with `key`; undefined when routing cannot be decided (headers). */
export function rabbitRoute(topology: RabbitTopology, exchange: string, key: string): string[] | undefined {
  if (exchange === "") return [key];
  const type = topology.exchanges.get(exchange) ?? "direct";
  if (type === "headers") return undefined;
  const queues = topology.bindings
    .filter((b) => b.exchange === exchange && (type === "fanout" || (type === "topic" ? amqpTopicMatch(b.key, key) : b.key === key)))
    .map((b) => b.queue);
  return [...new Set(queues)];
}

export function linkMq(sends: readonly MqSendSite[], consumers: readonly MqConsumerSite[], topology: RabbitTopology, graph: GraphBuilder): ServiceLink[] {
  const links: ServiceLink[] = [];
  for (const send of sends) {
    let targets: { c: MqConsumerSite; channel: string; rationale: string }[] = [];
    const sameBroker = consumers.filter((c) => c.broker === send.broker);
    if (send.broker === "rabbitmq") {
      const queues = rabbitRoute(topology, send.destination, send.key ?? "");
      if (!queues) continue;
      const via = send.destination === "" ? "default exchange" : `exchange ${send.destination}`;
      const reached = queues.map((q) => ({ q, rationale: `${via}, routing key ${send.key ?? ""} → queue ${q}` }));
      // One dead-letter hop: expired / rejected messages are re-published to the queue's DLX (TTL delay queues).
      for (const { q, rationale } of [...reached]) {
        const dl = topology.deadLetters.get(q);
        if (!dl) continue;
        const dlKey = dl.key ?? send.key ?? "";
        for (const q2 of rabbitRoute(topology, dl.exchange, dlKey) ?? []) {
          if (!reached.some((r) => r.q === q2)) reached.push({ q: q2, rationale: `${rationale} → dead-letter (expired/rejected) → exchange ${dl.exchange}, routing key ${dlKey} → queue ${q2}` });
        }
      }
      for (const { q, rationale } of reached) for (const c of sameBroker) if (c.destinations.includes(q)) targets.push({ c, channel: `rabbitmq:${q}`, rationale });
    } else {
      targets = sameBroker
        .filter((c) => (c.pattern ? c.pattern.test(send.destination) : c.destinations.includes(send.destination)))
        .filter((c) => send.broker !== "rocketmq" || !c.tags || (send.key !== undefined && c.tags.includes(send.key)))
        .map((c) => ({ c, channel: `${send.broker}:${send.destination}`, rationale: `${send.broker} ${send.broker === "redis-stream" ? "stream" : "topic"} ${send.destination}${send.key ? ` tag ${send.key}` : ""}` }));
    }
    for (const { c, channel, rationale } of targets) {
      graph.edge(send.stepId, c.handlerStepId, { provenance: "framework-rule", rationale });
      const evidence: SourceRef[] = [
        { rootId: send.at.rootId, file: send.at.file, line: send.at.line ?? 1 },
        { rootId: c.at.rootId, file: c.at.file, line: c.at.line ?? 1 },
      ];
      links.push({
        id: stableId("link", "", `${send.serviceId}|${c.entrypoint.serviceId}|mq|${channel}|${send.stepId}|${c.entrypoint.id}`),
        fromServiceId: send.serviceId,
        toServiceId: c.entrypoint.serviceId,
        kind: "mq",
        channel,
        fromStepId: send.stepId,
        toEntrypointId: c.entrypoint.id,
        provenance: "framework-rule",
        confidence: 1,
        evidence,
        rationale,
      });
    }
  }
  return links;
}
