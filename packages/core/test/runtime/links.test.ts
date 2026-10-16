import { describe, expect, it } from "vitest";
import { Aggregator } from "../../src/runtime/aggregate.js";
import { applyOverlay, reconcile } from "../../src/runtime/match.js";
import type { SpanRecord } from "../../src/runtime/span-record.js";
import { toSpanRecord } from "../../src/runtime/span-record.js";
import { analyzeTree, pom } from "../helpers/synthetic.js";

/** order-service → (Feign GET /stock/{id}, Kafka order-created, Redis stream stream:orders) → stock-service */
async function graph() {
  const files: Record<string, string> = {};
  const app = (name: string, port: number, sources: Record<string, string>) => {
    files[`${name}/pom.xml`] = pom(name);
    files[`${name}/src/main/java/${name.replace("-", "")}/App.java`] = `package ${name.replace("-", "")};\n@SpringBootApplication public class App {}\n`;
    files[`${name}/src/main/resources/application.yml`] = `server:\n  port: ${port}\nspring:\n  application:\n    name: ${name}\n`;
    for (const [f, body] of Object.entries(sources)) files[`${name}/src/main/java/${name.replace("-", "")}/${f}`] = `package ${name.replace("-", "")};\n${body}\n`;
  };
  app("order-service", 8081, {
    "StockClient.java": '@FeignClient(name = "stock-service")\npublic interface StockClient { @GetMapping("/stock/{id}") String stock(@PathVariable("id") Long id); }',
    "OrderController.java": `
@RestController
public class OrderController {
  @Autowired private StockClient stockClient;
  @Autowired private KafkaTemplate<String, String> kafkaTemplate;
  @Autowired private StringRedisTemplate redisTemplate;
  @PostMapping("/orders")
  public void create(Long id) {
    stockClient.stock(id);
    kafkaTemplate.send("order-created", "x");
    redisTemplate.opsForStream().add(StreamRecords.newRecord().in("stream:orders").ofMap(java.util.Map.of("id", "1")));
  }
}`,
  });
  app("stock-service", 8082, {
    "StockController.java": '@RestController public class StockController { @GetMapping("/stock/{id}") public String stock(@PathVariable Long id) { return "1"; } }',
    "Listeners.java": `
@Component
public class Listeners {
  @KafkaListener(topics = "order-created") public void onCreated(String m) {}
}`,
    "StreamConfig.java": `
@Configuration
public class StreamConfig {
  @Autowired private OrderStreamListener listener;
  @Bean public Subscription sub(StreamMessageListenerContainer<String, MapRecord<String, String, String>> c) { return c.receive(Consumer.from("g", "c"), StreamOffset.create("stream:orders", ReadOffset.lastConsumed()), listener); }
}`,
    "OrderStreamListener.java": "@Component\npublic class OrderStreamListener implements StreamListener<String, MapRecord<String, String, String>> { public void onMessage(MapRecord<String, String, String> r) {} }",
  });
  return analyzeTree(files);
}

let n = 0;
const rec = (svc: string, kind: SpanRecord["kind"], a: SpanRecord["a"], t: string, s: string, p?: string): SpanRecord => ({
  t: t.padEnd(32, "0"),
  s: s.padEnd(16, "0"),
  ...(p ? { p: p.padEnd(16, "0") } : {}),
  svc,
  scope: "test",
  name: "x",
  kind,
  start: 1_000 + n++,
  dur: 5,
  err: false,
  a,
});

describe("AC#22 — runtime confirms cross-service links", () => {
  it("HTTP client→server, Kafka consumer and Redis stream (both sides) confirm the static links", async () => {
    const g = await graph();
    const kinds = (ids: string[]) => g.serviceLinks.filter((l) => ids.includes(l.id)).map((l) => `${l.kind}:${l.channel}`).sort();
    expect(g.serviceLinks.map((l) => `${l.kind}:${l.channel}`).sort()).toEqual(["http:GET /stock/{}", "mq:kafka:order-created", "mq:redis-stream:stream:orders"]);

    const agg = new Aggregator();
    agg.add([
      // Feign: client span in order-service, server span in stock-service (same trace, parent → child)
      rec("order-service", "client", { method: "GET", peer: "stock-service:8082" }, "1", "1"),
      rec("stock-service", "server", { method: "GET", route: "/stock/{id}" }, "1", "2", "1"),
      // Kafka: producer → consumer (context propagated)
      rec("order-service", "producer", { msgSystem: "kafka", msgDest: "order-created" }, "2", "1"),
      rec("stock-service", "consumer", { msgSystem: "kafka", msgDest: "order-created" }, "2", "2", "1"),
    ]);
    let overlay = reconcile(g, agg.state);
    expect(kinds(Object.keys(overlay.links))).toEqual(["http:GET /stock/{}", "mq:kafka:order-created"]);

    // Redis stream: only the consumer side → not confirmed (no context propagation, both sides required)
    agg.add([rec("stock-service", "client", { dbSystem: "redis", dbOp: "XREADGROUP", dbTable: "stream:orders" }, "3", "1")]);
    overlay = reconcile(g, agg.state);
    expect(kinds(Object.keys(overlay.links))).not.toContain("mq:redis-stream:stream:orders");
    agg.add([rec("order-service", "client", { dbSystem: "redis", dbOp: "XADD", dbTable: "stream:orders" }, "4", "1")]);
    overlay = reconcile(g, agg.state);
    expect(kinds(Object.keys(overlay.links))).toContain("mq:redis-stream:stream:orders");

    const decorated = applyOverlay(g, overlay);
    expect(decorated.serviceLinks.filter((l) => l.observed).length).toBe(3);
  });

  it("a second producer of the same topic is not confirmed by the first one's traffic", async () => {
    const g = await graph();
    const order = g.services.find((s) => s.name === "order-service");
    const kafka = g.serviceLinks.find((l) => l.channel === "kafka:order-created");
    // refund-service also sends to order-created (same consumer, same channel)
    const refund = { ...order!, id: "refund-svc", name: "refund-service" };
    const refundLink = { ...kafka!, id: "refund-link", fromServiceId: refund.id };
    const g2 = { ...g, services: [...g.services, refund], serviceLinks: [...g.serviceLinks, refundLink] };
    const agg = new Aggregator();
    agg.add([
      rec("order-service", "producer", { msgSystem: "kafka", msgDest: "order-created" }, "7", "1"),
      rec("stock-service", "consumer", { msgSystem: "kafka", msgDest: "order-created" }, "7", "2", "1"),
    ]);
    const links = Object.keys(reconcile(g2, agg.state).links);
    expect(links).toContain(kafka!.id);
    expect(links).not.toContain("refund-link");
  });

  it("an unknown service name with the route in several services credits nothing", async () => {
    const g = await graph();
    const stockEp = g.entrypoints.find((e) => e.path === "/stock/{}");
    const twin = { ...stockEp!, id: "twin-ep", serviceId: g.services.find((s) => s.name === "order-service")!.id };
    const g2 = { ...g, entrypoints: [...g.entrypoints, twin] };
    const agg = new Aggregator();
    agg.add([rec("unknown_service:java", "server", { method: "GET", route: "/stock/{id}" }, "8", "1")]);
    const overlay = reconcile(g2, agg.state);
    expect(overlay.entrypoints).toEqual({});
    expect(overlay.unmatched.map((u) => u.reason)).toEqual(["ambiguous"]);
  });

  it("reports traffic no static link covers as runtime-only links", async () => {
    const g = await graph();
    const agg = new Aggregator();
    agg.add([
      rec("order-service", "producer", { msgSystem: "kafka", msgDest: "audit" }, "5", "1"),
      rec("stock-service", "consumer", { msgSystem: "kafka", msgDest: "audit" }, "5", "2", "1"),
      rec("stock-service", "client", { method: "POST", peer: "order-service:8081" }, "6", "1"),
      rec("order-service", "server", { method: "POST", route: "/orders" }, "6", "2", "1"),
    ]);
    const overlay = reconcile(g, agg.state);
    expect(overlay.runtimeLinks).toEqual(
      expect.arrayContaining([
        { fromService: "order-service", toService: "stock-service", kind: "mq", channel: "kafka:audit", count: 1 },
        { fromService: "stock-service", toService: "order-service", kind: "http", channel: "POST /orders", count: 1 },
      ]),
    );
  });

  it("extracts only the stream key from Redis stream commands", () => {
    const span = (statement: string) =>
      toSpanRecord({ traceId: "a".repeat(32), spanId: "b".repeat(16), name: "x", kind: 3, startTimeUnixNano: 0n, endTimeUnixNano: 1n, attributes: { "db.system": "redis", "db.statement": statement }, events: [], statusCode: 0 }, "svc", "lettuce").a;
    expect(span("XADD stream:orders * id 42 secret 123")).toMatchObject({ dbOp: "XADD", dbTable: "stream:orders" });
    expect(span("XREADGROUP GROUP g c COUNT 10 STREAMS stream:orders >")).toMatchObject({ dbOp: "XREADGROUP", dbTable: "stream:orders" });
    expect(JSON.stringify(span("XADD stream:orders * secret 123"))).not.toContain("123");
    expect(span("GET login_tokens:abc").dbTable).toBeUndefined();
  });
});

/** order-service → exchange order.topic (topic) → queues stock.q ("order.*") and audit.q ("order.#"), both in stock-service. */
async function rabbitGraph() {
  const files: Record<string, string> = {};
  const app = (name: string, port: number, sources: Record<string, string>) => {
    files[`${name}/pom.xml`] = pom(name);
    files[`${name}/src/main/java/${name.replace("-", "")}/App.java`] = `package ${name.replace("-", "")};\n@SpringBootApplication public class App {}\n`;
    files[`${name}/src/main/resources/application.yml`] = `server:\n  port: ${port}\nspring:\n  application:\n    name: ${name}\n`;
    for (const [f, body] of Object.entries(sources)) files[`${name}/src/main/java/${name.replace("-", "")}/${f}`] = `package ${name.replace("-", "")};\n${body}\n`;
  };
  app("order-service", 8081, {
    "OrderController.java": `
@RestController
public class OrderController {
  @Autowired private RabbitTemplate rabbitTemplate;
  @PostMapping("/orders")
  public void create(Long id) { rabbitTemplate.convertAndSend("order.topic", "order.created", id); }
}`,
  });
  app("stock-service", 8082, {
    "RabbitConfig.java": `
@Configuration
public class RabbitConfig {
  @Bean public TopicExchange orderExchange() { return new TopicExchange("order.topic"); }
  @Bean public Queue stockQueue() { return new Queue("stock.q"); }
  @Bean public Queue auditQueue() { return new Queue("audit.q"); }
  @Bean public Binding stockBinding(Queue stockQueue, TopicExchange orderExchange) { return BindingBuilder.bind(stockQueue).to(orderExchange).with("order.*"); }
  @Bean public Binding auditBinding(Queue auditQueue, TopicExchange orderExchange) { return BindingBuilder.bind(auditQueue).to(orderExchange).with("order.#"); }
}`,
    "Listeners.java": `
@Component
public class Listeners {
  @RabbitListener(queues = "stock.q") public void onStock(Long id) {}
  @RabbitListener(queues = "audit.q") public void onAudit(Long id) {}
}`,
  });
  return analyzeTree(files);
}

describe("RabbitMQ runtime confirmation (the agent reports exchange / routing key, not the queue)", () => {
  it("records runtime destinations on the static links", async () => {
    const g = await rabbitGraph();
    const stock = g.serviceLinks.find((l) => l.channel === "rabbitmq:stock.q");
    expect(stock?.runtime).toEqual({ producer: ["order.topic"], consumer: ["order.topic", "order.created", "stock.q"], strong: ["order.created", "stock.q"] });
    expect(g.serviceLinks.map((l) => l.channel).sort()).toEqual(["rabbitmq:audit.q", "rabbitmq:stock.q"]);
  });

  it("an exchange or a shared routing key alone confirms nothing; the handler that ran picks the queue", async () => {
    const g = await rabbitGraph();
    const linkOf = (q: string) => g.serviceLinks.find((l) => l.channel === `rabbitmq:${q}`)!.id;
    const agg = new Aggregator();
    agg.add([
      rec("order-service", "producer", { msgSystem: "rabbitmq", msgDest: "order.topic" }, "1", "1"),
      rec("stock-service", "consumer", { msgSystem: "rabbitmq", msgDest: "order.topic" }, "1", "2", "1"), // amqp delivery: exchange
    ]);
    expect(reconcile(g, agg.state).links).toEqual({});
    agg.add([rec("stock-service", "consumer", { msgSystem: "rabbitmq", msgDest: "order.created" }, "1", "3", "2")]); // Spring listener: routing key
    expect(reconcile(g, agg.state).links).toEqual({}); // both queues receive "order.created"
    agg.add([rec("stock-service", "internal", { cls: "stockservice.Listeners", fn: "onStock" }, "1", "4", "3")]);
    expect(Object.keys(reconcile(g, agg.state).links)).toEqual([linkOf("stock.q")]);
  });

  it("with one queue per producer, the routing key the listener reports confirms the link", async () => {
    const g = await rabbitGraph();
    const stock = g.serviceLinks.find((l) => l.channel === "rabbitmq:stock.q")!;
    const g1 = { ...g, serviceLinks: [stock] };
    const agg = new Aggregator();
    agg.add([
      rec("order-service", "producer", { msgSystem: "rabbitmq", msgDest: "order.topic" }, "2", "1"),
      rec("stock-service", "consumer", { msgSystem: "rabbitmq", msgDest: "order.created" }, "2", "2", "1"),
    ]);
    expect(Object.keys(reconcile(g1, agg.state).links)).toEqual([stock.id]);
    // without the producer seen on its exchange, nothing
    const agg2 = new Aggregator();
    agg2.add([rec("stock-service", "consumer", { msgSystem: "rabbitmq", msgDest: "order.created" }, "3", "2")]);
    expect(reconcile(g1, agg2.state).links).toEqual({});
  });
});
