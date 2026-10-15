# ProjectAtlas

**[中文](README.zh-CN.md)** · English

Open a Spring / Vue / RuoYi project in VS Code and get its map in under a minute:

- **Modules and services**: Maven modules, Spring Boot apps (names from `spring.application.name`, including Nacos configs exported as SQL), Vue apps.
- **Request flows, exact where it matters**: `GET /system/user/list` → dev proxy → Spring Cloud Gateway route (`StripPrefix`) → `JwtAuthenticationTokenFilter` → `RepeatSubmitInterceptor` → `@PreAuthorize` → `SysUserController.list` → `@DataScope` aspect → `SysUserServiceImpl.selectUserList` → `SysUserMapper` → `<select id="selectUserList">`.
- **Cross-service links**: frontend → proxy → gateway → service, Feign clients, RestTemplate, and message queues (Kafka, RabbitMQ incl. topic/fanout exchanges and dead-letter queues, RocketMQ tags, Redis Stream, Spring Cloud Stream).
- **Runtime reconciliation (v0.2)**: start a service with the OpenTelemetry javaagent (paste the VM options into IDEA, or `project-atlas trace -- java -jar app.jar`) and the map shows which steps and links really ran, with latency, plus calls that only appear at runtime. Local only; SQL text, bodies and headers are never stored. [How it works](docs/runtime-tracing.md)
- **How to start it**: prerequisites, commands and ports, each pointing to the file and line it comes from.
- **Change history** per module (git), with an optional AI summary.
- **Optional AI** (bring your own key: Anthropic, any OpenAI-compatible API such as DeepSeek/Qwen, or local Ollama) for module summaries and the feature list. You see the token and cost estimate per phase before anything is sent.

Rules come first: every solid edge in a flow is derived from code and framework semantics. AI-inferred edges are dashed and labelled. When the analyzer cannot tell which method is called, it draws nothing and lists the call under "Unresolved calls". You can declare in-house HTTP helpers in `atlas.yaml`.

## Quick start

1. Install **ProjectAtlas** from the VS Code Marketplace or Open VSX.
2. Open your project and click **Atlas: Analyze** in the status bar. No key is needed.
3. Optional: **Atlas: Configure AI Model**.

CLI: `npx project-atlas analyze . --no-ai --markdown ATLAS.md` · runtime: `npx project-atlas trace -- mvn spring-boot:run` · MCP for coding agents: `atlas-mcp --dir .atlas`.

## Supported

| Area | Supported |
|---|---|
| Java | Spring MVC / Boot: `@RestController`, mapping annotations (constants and `${}` resolved), servlet filters (Spring Security order, `FilterRegistrationBean` url patterns), `HandlerInterceptor` (Ant include/exclude), `@PreAuthorize`/`@Secured`, AspectJ (`execution`, `within`, `@annotation`, `bean`…), DI (`@Primary`, `@Qualifier`, `@Resource`, Lombok constructors, multiple implementations shown as branches), MyBatis mapper XML, MyBatis-Plus `BaseMapper`, `@Scheduled` |
| Spring Cloud | Gateway routes (`Path`, `StripPrefix`, `RewritePath`, `PrefixPath`, global filters), Nacos config from SQL dumps (shared/extension configs, profiles), OpenFeign, RestTemplate/WebClient with `lb://` / service names |
| Vue | Vue 2/3, `src/api` request helpers (`request({url, method})`, `axios.get`), pages, router tables, RuoYi `sys_menu` routes, Vite/Vue CLI dev proxy |
| Message queues | Kafka (`topics`, `topicPattern`), RabbitMQ (`@RabbitListener` queues/bindings, `@Bean` Queue/Exchange/Binding, direct/topic/fanout/default exchange, dead-letter TTL queues, enum constants), RocketMQ (`topic:tag`, selector tags), Redis Stream (listener containers, `opsForStream().add`), Spring Cloud Stream bindings; unresolvable destinations are listed, never guessed |
| Runtime (Java) | OpenTelemetry javaagent 2.31.1 (pinned, sha256): filters, interceptors, aspects, controllers, services, MyBatis mappers, SQL; HTTP/Feign, Kafka, RabbitMQ, RocketMQ, Redis Stream links confirmed at runtime; Trace tab with waterfall; CLI `trace`, `trace import`; MCP `list_traces` |
| Coming next | v0.3 Go + gRPC · v0.4 Python + Dubbo · SkyWalking / Arthas trace import |

## Privacy

Analysis runs locally. With an AI provider configured, Atlas sends only summaries of "hub" files (controllers, services, top files per module) after your confirmation. `.env*`, keys and keystores are never sent, and secrets inside files are masked. Code is wrapped as untrusted data, and the model cannot call tools. No telemetry.

## Docs

[Errors](docs/errors.md) · [Runtime tracing](docs/runtime-tracing.md) · [Architecture](docs/architecture.md) · [Contributing a framework rule](CONTRIBUTING.md) · [Spec](docs/spec.md)

MIT License.
