# ProjectAtlas

**[中文](README.zh-CN.md)** · English

[![ci](https://github.com/a805034104/project-atlas/actions/workflows/ci.yml/badge.svg)](https://github.com/a805034104/project-atlas/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/a805034104/project-atlas)](https://github.com/a805034104/project-atlas/releases)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/a805034104/project-atlas/blob/main/LICENSE)

**A map of your Spring / Vue / RuoYi project, in your browser.** Download one file, double-click it, paste the path of a repository, and within a minute you can follow any request from the Vue page through the gateway, filters, interceptors, aspects, controller, service and mapper down to the SQL statement, drawn top-down like a pyramid. Every step opens the file and line it came from. Nothing to install, no account, nothing leaves your computer.

![Request flow of GET /system/user/list in RuoYi-Cloud](https://github.com/a805034104/project-atlas/raw/main/docs/images/flow.png)

<sub>Real output for [RuoYi-Cloud](https://gitee.com/y_project/RuoYi-Cloud): `GET /system/user/list`, from the Vue page `listUser()`, through the gateway `AuthFilter` / `XssFilter` and route, `SysUserController.list` (with its `@Around` aspect beside it), `SysUserServiceImpl` (with `@DataScope`), down to the mapper XML `<select>`.</sub>

## Get started

| Your computer | Download from [Releases](https://github.com/a805034104/project-atlas/releases/latest) |
|---|---|
| Windows 10/11 (x64) | `project-atlas-win-x64.exe` |
| macOS (Apple silicon) | `project-atlas-macos-arm64` |
| Linux (x64) | `project-atlas-linux-x64` |

1. Double-click the file (Linux / macOS terminal: `chmod +x project-atlas-* && ./project-atlas-*`). A small window says where ProjectAtlas is running and your browser opens.
2. Paste the folder of a Spring Boot / Spring Cloud / Vue project (or a public git URL) and click **Analyze**. No key is needed.
3. Open **Flow** and pick an endpoint. Close the window to quit.

The files are not code-signed yet:
- **Windows SmartScreen**: *More info* ▸ *Run anyway*.
- **macOS**: right-click ▸ *Open* once, or `xattr -d com.apple.quarantine project-atlas-macos-arm64`.

Every file has a `.sha256` next to it, built in public CI from this repository.

![Import a project](https://github.com/a805034104/project-atlas/raw/main/docs/images/home.png)

## Why

Joining a large Spring Cloud codebase usually means a week of reading code to answer simple questions: which filters run before this endpoint, which service does this page call, and what writes to this table? Generic code search doesn't know about Spring Security filter order, Ant patterns in `HandlerInterceptor`s, AspectJ pointcuts, gateway `StripPrefix`, Feign clients or MyBatis XML. ProjectAtlas does.

- **Rules first, AI optional.** Every solid edge is derived from code and framework semantics. When the analyzer cannot tell which method runs (an interface with several beans, an overload the arguments don't decide, a dynamic topic), it draws nothing and lists the call under *Unresolved*. AI-inferred edges are dashed and labelled.
- **Runtime confirms the static map.** Start a service with the OpenTelemetry javaagent and the map marks what actually ran, with call counts and p95 latency.
- **Local by default.** Analysis runs on your machine. No telemetry. AI is off until you configure a key, and even then you see a cost estimate before anything is sent.

## Features

| | |
|---|---|
| **Request flows** | Frontend call → dev proxy → Spring Cloud Gateway (routes, `StripPrefix`/`RewritePath`, global filters) → servlet filters in Spring Security order → `HandlerInterceptor`s (Ant include/exclude) → `@PreAuthorize` → AspectJ advice → controller → service (DI with `@Primary`, `@Qualifier`, `@Resource`; several implementations shown as branches) → MyBatis mapper XML / MyBatis-Plus → SQL |
| **Cross-service links** | Frontend → gateway → service, OpenFeign, RestTemplate / WebClient with `lb://`, and message queues: Kafka, RabbitMQ (direct / topic / fanout / default exchange, dead-letter TTL queues), RocketMQ tags, Redis Stream, Spring Cloud Stream |
| **Runtime reconciliation** | Pinned OpenTelemetry javaagent 2.31.1 (sha256-checked). Steps, edges and links observed at runtime with count · p95 · errors; a Trace tab with a waterfall; calls seen only at runtime are listed, never drawn as guesses |
| **Startup guide** | Prerequisites (JDK, MySQL, Redis, Nacos…), build and run commands, ports, each with the file and line it comes from |
| **Modules & history** | Maven modules, Spring Boot apps (`spring.application.name`, Nacos configs exported as SQL), Vue apps; per-module git history |
| **Optional AI** | Module summaries and a feature list from Anthropic, any OpenAI-compatible API (DeepSeek, Qwen…) or a local Ollama. Keys stay on your computer (`~/.project-atlas/credentials.json`; VS Code SecretStorage in the extension); `.env`/keys are never sent and secrets in files are masked |
| **CLI & MCP** | `project-atlas analyze` / `show` / `trace` for terminals and CI; a read-only MCP server so coding agents query verified call chains instead of guessing them |

![Runtime overlay: every step of GET /system/user/list observed, with latency](https://github.com/a805034104/project-atlas/raw/main/docs/images/flow-runtime.png)

<sub>Runtime overlay from a real RuoYi-Vue run: each step and edge shows how often it ran and its p95.</sub>

<table><tr>
<td><img src="https://github.com/a805034104/project-atlas/raw/main/docs/images/overview.png" alt="Overview"></td>
<td><img src="https://github.com/a805034104/project-atlas/raw/main/docs/images/startup.png" alt="Startup guide"></td>
</tr><tr>
<td align="center"><sub>Overview: services, modules, entrypoints, how to run</sub></td>
<td align="center"><sub>Startup guide with sources</sub></td>
</tr></table>

## Other ways to run it

- **VS Code extension**: the same map inside the editor. Install the `.vsix` from [Releases](https://github.com/a805034104/project-atlas/releases) (*Extensions* ▸ `…` ▸ *Install from VSIX…*), then run **Atlas: Analyze**. Requires VS Code 1.95+.
- **From source** with Node.js 20+: `node packages/web/dist/main.js` starts the same web app; the CLI and MCP server are below.

Runtime tracing additionally needs a JDK 8+ for your own application.

### From source

```bash
git clone https://github.com/a805034104/project-atlas.git
cd project-atlas
npm ci && npm run build          # Node.js 20+
npx vitest run                   # optional: the test suite
node packages/cli/dist/bin.js analyze /path/to/your/project --no-ai
```

`node packages/web/dist/main.js` starts the web app from the checkout; `node packages/web/build-sea.mjs` builds the single-file program for your OS. Press F5 in VS Code with `packages/vscode` open to run the extension in a development host.

## Usage

**In the browser**: import a project, then browse the tabs: Overview, Topology, Modules, Features, Startup, Flow, History, Trace. In **Flow**:
- The entry is on top, and each call is one row lower.
- Aspects are drawn beside the method they advise.
- A method with many callees folds into "+N", which you can expand.
- Clicking a step opens its source on the right, with links to open it in VS Code or IDEA.
- *Export HTML* writes a single offline file you can share.

Recent projects stay on the home page. The data lives in `~/.project-atlas` and in each project's `.atlas` folder.

**In VS Code**: *Atlas: Analyze*. CodeLens on controller methods opens the flow of that endpoint.

**CLI**

```bash
project-atlas analyze . --no-ai --markdown ATLAS.md     # analyze, write a Markdown map
project-atlas show "GET /system/user/list"              # print one flow in the terminal
project-atlas trace -- mvn spring-boot:run              # run with the javaagent, print what was observed
project-atlas trace --print-config                      # VM options to paste into IDEA
```

(From a source checkout, `project-atlas` is `node packages/cli/dist/bin.js`.)

**MCP** — `atlas-mcp --dir .atlas` serves entrypoints, flows, service links and runtime aggregates (never span attribute values) to coding agents over stdio.

**Runtime tracing**: on the Startup tab, click *Copy VM options for tracing* and paste them into your IDE run configuration. Restart the service and send a request.
- Spans go to a receiver on 127.0.0.1 only.
- SQL text, request bodies and headers are never stored.

See [docs/runtime-tracing.md](https://github.com/a805034104/project-atlas/blob/main/docs/runtime-tracing.md).

## Supported

| Area | Supported |
|---|---|
| Java | Spring MVC / Boot 2–3: mapping annotations (constants and `${}` resolved), filters (`FilterRegistrationBean` url patterns), interceptors, `@PreAuthorize`/`@Secured`, AspectJ (`execution`, `within`, `@annotation`, `bean`…), DI incl. Lombok constructors, MyBatis XML, MyBatis-Plus `BaseMapper`, `@Scheduled` |
| Spring Cloud | Gateway routes and filters, Nacos config from SQL dumps (shared/extension configs, profiles), OpenFeign, RestTemplate / WebClient |
| Vue | Vue 2/3, `src/api` request helpers, pages, router tables, RuoYi `sys_menu` routes, Vite / Vue CLI dev proxy |
| Message queues | Kafka, RabbitMQ, RocketMQ, Redis Stream, Spring Cloud Stream; unresolvable destinations are listed, never guessed |
| Runtime (Java) | Filters, interceptors, aspects, controllers, services, MyBatis mappers, SQL; HTTP/Feign, Kafka, RabbitMQ, RocketMQ and Redis Stream links confirmed at runtime |
| Tested on | RuoYi-Vue, RuoYi-Cloud (+ Vue 3), pig, JeecgBoot, mall-swarm |
| Next | Go + gRPC, Python + Dubbo, SkyWalking / Arthas trace import |

## How it works

tree-sitter (WASM) parses Java, JS/TS and Vue into per-file facts (cached by content hash). Framework rules turn facts into a graph of steps and edges with stable IDs; per-entrypoint flows are projections over that graph. The runtime side is an OTLP receiver plus a reconciler that maps spans onto steps without changing the saved graph. Details: [docs/architecture.md](https://github.com/a805034104/project-atlas/blob/main/docs/architecture.md).

## Contributing

Bug reports with a minimal reproduction (or a link to a public repository) are the most useful thing you can send. Adding a framework rule is described in [CONTRIBUTING.md](https://github.com/a805034104/project-atlas/blob/main/CONTRIBUTING.md); every rule ships with a fixture and a test. Please report security issues privately, see [SECURITY.md](https://github.com/a805034104/project-atlas/blob/main/SECURITY.md).

## Docs

[Runtime tracing](https://github.com/a805034104/project-atlas/blob/main/docs/runtime-tracing.md) · [Errors](https://github.com/a805034104/project-atlas/blob/main/docs/errors.md) · [Architecture](https://github.com/a805034104/project-atlas/blob/main/docs/architecture.md) · [Changelog](https://github.com/a805034104/project-atlas/blob/main/CHANGELOG.md) · [Spec](https://github.com/a805034104/project-atlas/blob/main/docs/spec.md) · [v0.2 spec](https://github.com/a805034104/project-atlas/blob/main/docs/spec-v0.2.md)

## License

[MIT](https://github.com/a805034104/project-atlas/blob/main/LICENSE)
