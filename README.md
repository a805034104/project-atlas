# ProjectAtlas

**[中文](README.zh-CN.md)** · English

Open a Spring / Vue / RuoYi project in VS Code and get its map in under a minute:

- **Modules and services**: Maven modules, Spring Boot apps (names from `spring.application.name`, including Nacos configs exported as SQL), Vue apps.
- **Request flows, exact where it matters**: `GET /system/user/list` → dev proxy → Spring Cloud Gateway route (`StripPrefix`) → `JwtAuthenticationTokenFilter` → `RepeatSubmitInterceptor` → `@PreAuthorize` → `SysUserController.list` → `@DataScope` aspect → `SysUserServiceImpl.selectUserList` → `SysUserMapper` → `<select id="selectUserList">`.
- **Cross-service links**: frontend → proxy → gateway → service, Feign clients, RestTemplate.
- **How to start it**: prerequisites, commands and ports, each pointing to the file and line it comes from.
- **Change history** per module (git), with an optional AI summary.
- **Optional AI** (bring your own key: Anthropic, any OpenAI-compatible API such as DeepSeek/Qwen, or local Ollama) for module summaries and the feature list. You see the token and cost estimate per phase before anything is sent.

Rules come first: every solid edge in a flow is derived from code and framework semantics. AI-inferred edges are dashed and labelled. When the analyzer cannot tell which method is called, it draws nothing and lists the call under "Unresolved calls". You can declare in-house HTTP helpers in `atlas.yaml`.

## Quick start

1. Install **ProjectAtlas** from the VS Code Marketplace or Open VSX.
2. Open your project and click **Atlas: Analyze** in the status bar. No key is needed.
3. Optional: **Atlas: Configure AI Model**.

CLI: `npx project-atlas analyze . --no-ai --markdown ATLAS.md` · MCP for coding agents: `atlas-mcp --dir .atlas`.

## Supported in v0.1

| Area | Supported |
|---|---|
| Java | Spring MVC / Boot: `@RestController`, mapping annotations (constants and `${}` resolved), servlet filters (Spring Security order, `FilterRegistrationBean` url patterns), `HandlerInterceptor` (Ant include/exclude), `@PreAuthorize`/`@Secured`, AspectJ (`execution`, `within`, `@annotation`, `bean`…), DI (`@Primary`, `@Qualifier`, `@Resource`, Lombok constructors, multiple implementations shown as branches), MyBatis mapper XML, MyBatis-Plus `BaseMapper`, `@Scheduled` |
| Spring Cloud | Gateway routes (`Path`, `StripPrefix`, `RewritePath`, `PrefixPath`, global filters), Nacos config from SQL dumps (shared/extension configs, profiles), OpenFeign, RestTemplate/WebClient with `lb://` / service names |
| Vue | Vue 2/3, `src/api` request helpers (`request({url, method})`, `axios.get`), pages, router tables, RuoYi `sys_menu` routes, Vite/Vue CLI dev proxy |
| Coming next | v0.2 local runtime tracing + MQ (Redis Stream, Kafka, RabbitMQ, RocketMQ) · v0.3 Go · v0.4 Python + Dubbo/gRPC |

## Privacy

Analysis runs locally. With an AI provider configured, Atlas sends only summaries of "hub" files (controllers, services, top files per module) after your confirmation. `.env*`, keys and keystores are never sent, and secrets inside files are masked. Code is wrapped as untrusted data, and the model cannot call tools. No telemetry.

## Docs

[Errors](docs/errors.md) · [Architecture](docs/architecture.md) · [Contributing a framework rule](CONTRIBUTING.md) · [Spec](docs/spec.md)

MIT License.
