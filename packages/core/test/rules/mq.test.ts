import { describe, expect, it } from "vitest";
import type { AtlasGraph } from "../../src/model/types.js";
import { amqpTopicMatch, parseAnnotationText, rabbitRoute, rocketTags } from "../../src/rules/mq.js";
import { analyzeTree, pom } from "../helpers/synthetic.js";

/** Two-service workspace: `producer` (with an HTTP entry) and `consumer`, package per service. */
function twoServices(producer: Record<string, string>, consumer: Record<string, string>, configs: { producer?: string; consumer?: string } = {}): Record<string, string> {
  const files: Record<string, string> = {};
  const add = (name: string, port: number, sources: Record<string, string>, extraYaml = "") => {
    files[`${name}/pom.xml`] = pom(name);
    files[`${name}/src/main/java/${name}/App.java`] = `package ${name};\n@SpringBootApplication public class App {}\n`;
    files[`${name}/src/main/resources/application.yml`] = `server:\n  port: ${port}\nspring:\n  application:\n    name: ${name}\n${extraYaml}`;
    for (const [file, body] of Object.entries(sources)) files[`${name}/src/main/java/${name}/${file}`] = `package ${name};\n${body}\n`;
  };
  add("producer", 8081, producer, configs.producer);
  add("consumer", 8082, consumer, configs.consumer);
  return files;
}

const controller = (field: string, body: string) => `
@RestController
@RequestMapping("/orders")
public class OrderController {
  @Autowired private ${field};
  @PostMapping
  public void create(String id) { ${body} }
}`;

function mqLinks(graph: AtlasGraph) {
  const eps = new Map(graph.entrypoints.map((e) => [e.id, e]));
  return graph.serviceLinks
    .filter((l) => l.kind === "mq")
    .map((l) => ({ channel: l.channel, handler: eps.get(l.toEntrypointId ?? "")?.handler.name }))
    .sort((a, b) => `${a.channel}${a.handler}`.localeCompare(`${b.channel}${b.handler}`));
}

describe("MQ pure helpers", () => {
  it("matches AMQP topic patterns", () => {
    expect(amqpTopicMatch("order.*", "order.created")).toBe(true);
    expect(amqpTopicMatch("order.*", "order.created.v2")).toBe(false);
    expect(amqpTopicMatch("order.#", "order")).toBe(true);
    expect(amqpTopicMatch("order.#", "order.a.b")).toBe(true);
    expect(amqpTopicMatch("#.paid", "pay.order.paid")).toBe(true);
    expect(amqpTopicMatch("*.paid", "pay.order.paid")).toBe(false);
  });

  it("parses RocketMQ tag expressions", () => {
    expect(rocketTags("*")).toBeUndefined();
    expect(rocketTags(undefined)).toBeUndefined();
    expect(rocketTags("tagA || tagB")).toEqual(["tagA", "tagB"]);
  });

  it("parses nested annotation text", () => {
    const qb = parseAnnotationText('@QueueBinding(value = @Queue(value = "q", durable = "true"), exchange = @Exchange(value = "x", type = ExchangeTypes.TOPIC), key = {"a.*", "b"})');
    expect(qb?.name).toBe("QueueBinding");
    expect(parseAnnotationText(qb?.args["value"] ?? "")?.args["value"]).toBe('"q"');
    expect(qb?.args["key"]).toBe('{"a.*", "b"}');
    expect(parseAnnotationText('@Queue("solo")')?.args["value"]).toBe('"solo"');
  });

  it("routes by exchange type and treats headers exchanges as undecidable", () => {
    const topology = {
      exchanges: new Map([
        ["t", "topic" as const],
        ["f", "fanout" as const],
        ["h", "headers" as const],
      ]),
      bindings: [
        { queue: "q1", exchange: "t", key: "a.*" },
        { queue: "q2", exchange: "f", key: "" },
        { queue: "q3", exchange: "d", key: "k" },
      ],
      deadLetters: new Map(),
    };
    expect(rabbitRoute(topology, "t", "a.b")).toEqual(["q1"]);
    expect(rabbitRoute(topology, "f", "anything")).toEqual(["q2"]);
    expect(rabbitRoute(topology, "d", "k")).toEqual(["q3"]);
    expect(rabbitRoute(topology, "d", "other")).toEqual([]);
    expect(rabbitRoute(topology, "", "direct-queue")).toEqual(["direct-queue"]);
    expect(rabbitRoute(topology, "h", "k")).toBeUndefined();
  });
});

describe("MQ links (synthetic two-service workspaces)", () => {
  it("Kafka: constants, placeholders, topicPattern; unresolved topics draw nothing", async () => {
    const graph = await analyzeTree(
      twoServices(
        {
          "Topics.java": 'public class Topics { public static final String CREATED = "order-created"; }',
          "OrderController.java": controller(
            "KafkaTemplate<String, String> kafkaTemplate",
            'kafkaTemplate.send(Topics.CREATED, id); kafkaTemplate.send("${app.topic.paid}", id); kafkaTemplate.send(new ProducerRecord<>("audit.order", id)); kafkaTemplate.send(dynamicTopic(), id);',
          ),
        },
        {
          "OrderListener.java": `
@Component
public class OrderListener {
  @KafkaListener(topics = "order-created", groupId = "g")
  public void onCreated(String msg) {}
  @KafkaListener(topics = "\${app.topic.paid}")
  public void onPaid(String msg) {}
  @KafkaListener(topicPattern = "audit\\\\..*")
  public void onAudit(String msg) {}
  @KafkaListener(topics = "never-sent")
  public void onNever(String msg) {}
}`,
        },
        { producer: "app:\n  topic:\n    paid: order-paid\n", consumer: "app:\n  topic:\n    paid: order-paid\n" },
      ),
    );
    expect(mqLinks(graph)).toEqual([
      { channel: "kafka:audit.order", handler: "OrderListener.onAudit" },
      { channel: "kafka:order-created", handler: "OrderListener.onCreated" },
      { channel: "kafka:order-paid", handler: "OrderListener.onPaid" },
    ]);
    const consumerEp = graph.entrypoints.find((e) => e.handler.name === "OrderListener.onCreated");
    expect(consumerEp).toMatchObject({ kind: "mq-consumer", method: "KAFKA", path: "order-created" });
    expect(graph.diagnostics.some((d) => d.code === "ATLAS-W034" && /dynamicTopic/.test(d.message))).toBe(true);
    expect(graph.unresolvedCalls.some((u) => /dynamicTopic/.test(u.expression))).toBe(true);

    // The producer's HTTP flow continues into the consumer service.
    const http = graph.entrypoints.find((e) => e.kind === "http" && e.path === "/orders");
    const flow = graph.flows.find((f) => f.entrypointId === http?.id);
    const names = flow?.stepIds.map((id) => graph.steps.find((s) => s.id === id)?.symbol.name);
    expect(names).toEqual(expect.arrayContaining(["send kafka:order-created", "OrderListener.onCreated"]));
    // and the consumer has its own flow
    expect(graph.flows.some((f) => f.entrypointId === consumerEp?.id)).toBe(true);
  });

  it("RabbitMQ: bean bindings (topic), @QueueBinding (fanout), default exchange, enum getters", async () => {
    const graph = await analyzeTree(
      twoServices(
        {
          "QueueEnum.java": `
public enum QueueEnum {
  ORDER_CANCEL("mall.order.direct", "mall.order.cancel", "mall.order.cancel");
  private final String exchange;
  private final String name;
  private final String routeKey;
  QueueEnum(String exchange, String name, String routeKey) { this.exchange = exchange; this.name = name; this.routeKey = routeKey; }
  public String getExchange() { return exchange; }
  public String getRouteKey() { return routeKey; }
}`,
          "OrderController.java": controller(
            "RabbitTemplate rabbitTemplate",
            'rabbitTemplate.convertAndSend("order.topic", "order.created", id); rabbitTemplate.convertAndSend("order.topic", "order.created.v2", id); rabbitTemplate.convertAndSend("direct.q", id); rabbitTemplate.convertAndSend("fan.out", "", id, m -> m); rabbitTemplate.convertAndSend(QueueEnum.ORDER_CANCEL.getExchange(), QueueEnum.ORDER_CANCEL.getRouteKey(), id);',
          ),
        },
        {
          "RabbitConfig.java": `
@Configuration
public class RabbitConfig {
  @Bean public Queue createdQueue() { return new Queue("order.created.q", true); }
  @Bean public TopicExchange orderExchange() { return new TopicExchange("order.topic"); }
  @Bean public Binding createdBinding(Queue createdQueue, TopicExchange orderExchange) { return BindingBuilder.bind(createdQueue).to(orderExchange).with("order.*"); }
  @Bean public DirectExchange cancelExchange() { return ExchangeBuilder.directExchange("mall.order.direct").build(); }
  @Bean public Queue cancelQueue() { return QueueBuilder.durable("mall.order.cancel").build(); }
  @Bean public Binding cancelBinding() { return BindingBuilder.bind(cancelQueue()).to(cancelExchange()).with("mall.order.cancel"); }
}`,
          "Listeners.java": `
@Component
public class Listeners {
  @RabbitListener(queues = "order.created.q")
  public void created(String m) {}
  @RabbitListener(queuesToDeclare = @Queue("direct.q"))
  public void direct(String m) {}
  @RabbitListener(bindings = @QueueBinding(value = @Queue(value = "fan.q"), exchange = @Exchange(value = "fan.out", type = ExchangeTypes.FANOUT)))
  public void fan(String m) {}
  @RabbitListener(queues = "mall.order.cancel")
  public void cancel(String m) {}
}`,
        },
      ),
    );
    expect(mqLinks(graph)).toEqual([
      { channel: "rabbitmq:direct.q", handler: "Listeners.direct" },
      { channel: "rabbitmq:fan.q", handler: "Listeners.fan" },
      { channel: "rabbitmq:mall.order.cancel", handler: "Listeners.cancel" },
      { channel: "rabbitmq:order.created.q", handler: "Listeners.created" },
    ]);
    // "order.created.v2" does not match "order.*": exactly one link into Listeners.created.
    expect(graph.serviceLinks.filter((l) => l.channel === "rabbitmq:order.created.q")).toHaveLength(1);
  });

  it("RabbitMQ: TTL delay queue forwards through its dead-letter exchange (mall-swarm pattern)", async () => {
    const graph = await analyzeTree(
      twoServices(
        { "OrderController.java": controller("AmqpTemplate amqpTemplate", 'amqpTemplate.convertAndSend("order.ttl.x", "order.ttl.k", id, new MessagePostProcessor() { public Message postProcessMessage(Message m) { return m; } });') },
        {
          "RabbitConfig.java": `
@Configuration
public class RabbitConfig {
  @Bean DirectExchange ttlDirect() { return (DirectExchange) ExchangeBuilder.directExchange("order.ttl.x").durable(true).build(); }
  @Bean DirectExchange cancelDirect() { return (DirectExchange) ExchangeBuilder.directExchange("order.x").durable(true).build(); }
  @Bean public Queue ttlQueue() { return QueueBuilder.durable("order.ttl.q").withArgument("x-dead-letter-exchange", "order.x").withArgument("x-dead-letter-routing-key", "order.cancel").build(); }
  @Bean public Queue cancelQueue() { return new Queue("order.cancel.q"); }
  @Bean Binding ttlBinding(DirectExchange ttlDirect, Queue ttlQueue) { return BindingBuilder.bind(ttlQueue).to(ttlDirect).with("order.ttl.k"); }
  @Bean Binding cancelBinding(DirectExchange cancelDirect, Queue cancelQueue) { return BindingBuilder.bind(cancelQueue).to(cancelDirect).with("order.cancel"); }
}`,
          "CancelReceiver.java": `@Component
@RabbitListener(queues = "order.cancel.q")
public class CancelReceiver { @RabbitHandler public void handle(Long id) {} }`,
        },
      ),
    );
    expect(mqLinks(graph)).toEqual([{ channel: "rabbitmq:order.cancel.q", handler: "CancelReceiver.handle" }]);
    expect(graph.serviceLinks.find((l) => l.kind === "mq")?.rationale).toMatch(/dead-letter.*order\.x.*order\.cancel\.q/);
  });

  it("RocketMQ: topic:tag against selector expressions; SQL92 is reported, not guessed", async () => {
    const graph = await analyzeTree(
      twoServices(
        { "OrderController.java": controller("RocketMQTemplate rocketMQTemplate", 'rocketMQTemplate.syncSend("order-topic:paid", id); rocketMQTemplate.convertAndSend("plain-topic", id);') },
        {
          "PaidListener.java": '@Component\n@RocketMQMessageListener(topic = "order-topic", consumerGroup = "g1", selectorExpression = "paid || refunded")\npublic class PaidListener implements RocketMQListener<String> { public void onMessage(String m) {} }',
          "CreatedListener.java": '@Component\n@RocketMQMessageListener(topic = "order-topic", consumerGroup = "g2", selectorExpression = "created")\npublic class CreatedListener implements RocketMQListener<String> { public void onMessage(String m) {} }',
          "AllListener.java": '@Component\n@RocketMQMessageListener(topic = "order-topic", consumerGroup = "g3")\npublic class AllListener implements RocketMQListener<String> { public void onMessage(String m) {} }',
          "TaggedOnlyListener.java": '@Component\n@RocketMQMessageListener(topic = "plain-topic", consumerGroup = "g4", selectorExpression = "x")\npublic class TaggedOnlyListener implements RocketMQListener<String> { public void onMessage(String m) {} }',
          "SqlListener.java": '@Component\n@RocketMQMessageListener(topic = "order-topic", consumerGroup = "g5", selectorType = SelectorType.SQL92, selectorExpression = "a > 1")\npublic class SqlListener implements RocketMQListener<String> { public void onMessage(String m) {} }',
        },
      ),
    );
    expect(mqLinks(graph)).toEqual([
      { channel: "rocketmq:order-topic", handler: "AllListener.onMessage" },
      { channel: "rocketmq:order-topic", handler: "PaidListener.onMessage" },
    ]);
    expect(graph.diagnostics.some((d) => d.code === "ATLAS-W034" && /SQL92/.test(d.message))).toBe(true);
  });

  it("Redis Stream: StreamRecords key and a listener container", async () => {
    const graph = await analyzeTree(
      twoServices(
        {
          "Keys.java": 'public class Keys { public static final String STREAM = "stream:orders"; }',
          "OrderController.java": controller("StringRedisTemplate redisTemplate", "redisTemplate.opsForStream().add(StreamRecords.newRecord().in(Keys.STREAM).ofMap(java.util.Map.of(\"id\", id)));"),
        },
        {
          "StreamConfig.java": `
@Configuration
public class StreamConfig {
  @Autowired private OrderStreamListener listener;
  @Bean
  public Subscription subscription(StreamMessageListenerContainer<String, MapRecord<String, String, String>> container) {
    return container.receive(Consumer.from("g", "c1"), StreamOffset.create("stream:orders", ReadOffset.lastConsumed()), listener);
  }
}`,
          "OrderStreamListener.java": "@Component\npublic class OrderStreamListener implements StreamListener<String, MapRecord<String, String, String>> { public void onMessage(MapRecord<String, String, String> r) {} }",
        },
      ),
    );
    expect(mqLinks(graph)).toEqual([{ channel: "redis-stream:stream:orders", handler: "OrderStreamListener.onMessage" }]);
  });

  it("Spring Cloud Stream: StreamBridge binding → destination ← functional consumer", async () => {
    const graph = await analyzeTree(
      twoServices(
        { "OrderController.java": controller("StreamBridge streamBridge", 'streamBridge.send("orders-out-0", id);') },
        {
          "Handlers.java": `
@Configuration
public class Handlers {
  @Bean public java.util.function.Consumer<String> handleOrder() { return m -> {}; }
  @Bean public java.util.function.Function<String, String> notBound() { return m -> m; }
}`,
        },
        {
          producer: "  cloud:\n    stream:\n      bindings:\n        orders-out-0:\n          destination: orders\n",
          consumer: "  cloud:\n    function:\n      definition: handleOrder\n    stream:\n      bindings:\n        handleOrder-in-0:\n          destination: orders\n",
        },
      ),
    );
    expect(mqLinks(graph)).toEqual([{ channel: "stream:orders", handler: "Handlers.handleOrder" }]);
    expect(graph.entrypoints.some((e) => e.handler.name === "Handlers.notBound")).toBe(false);
  });
});
