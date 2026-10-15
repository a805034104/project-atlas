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
