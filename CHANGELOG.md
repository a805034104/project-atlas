# Changelog

## 0.3.0 — 2026-10-16

ProjectAtlas becomes a download-and-run web app; the flow diagram becomes a top-down pyramid.
Plan and review record: docs/spec-v0.3-web.md.

- **Single-file program** (Windows x64, macOS Apple silicon, Linux x64; Node SEA, no Node.js needed): double-click,
  the browser opens, import a project by path, folder picker or public git URL, see the map. One instance per user (a
  second launch opens the running one), exits 30 minutes after the last page closes, recent projects on the home page,
  `--self-test` proves the packaged parser runs on worker threads.
- **Local web server** (127.0.0.1 only): exact Host / Origin / Sec-Fetch-Site / content-type checks, one-time launch
  codes in the URL fragment exchanged for an HttpOnly SameSite=Strict per-port cookie, strict CSP, no framing; the
  source panel reads only inside imported roots (realpath on both sides, the ProjectAtlas home always refused); UNC
  paths refused; git imports keep the v0.1 clone guards plus `core.symlinks=false`. Questions the analysis waits for
  (AI cost, clone confirmation, service pick) become dialogs in the page.
- **Pyramid flow**: entry on top, one row per call depth, callers centred over callees; aspects (also chains of
  @Before/@AfterReturning/@Around at the entry) drawn beside the method they advise; more than 6 callees fold into
  the first 5 plus "+N"; recursion loops on the right; service frames, a rail naming each row's layers, layer chips,
  zoom. Replaces the staircase in the extension too. Verified on every flow of RuoYi-Vue, RuoYi-Cloud and mall-swarm
  (every step drawn, nothing overlaps).
- **Shared host**: the analysis and runtime lifecycles moved from the extension into `core/host` (HostEnv interface);
  the extension and the web app use the same code. The receiver lock is created atomically.
- **Settings in the web app**: language, AI provider / model / base URL, API key (write-only, stored in
  `~/.project-atlas/credentials.json`), test connection; theme follows the OS with a manual switch.
- **Verified**: `scripts/web-e2e.mjs` drives headless Chrome over CDP (import RuoYi-Vue → pyramid → source panel →
  second launch) against the source build and the single-file build; CI builds and tests the executables on
  Windows, Linux and macOS and attaches them to tagged releases.

## 0.2.1 — 2026-10-16

Closes the items v0.2.0 shipped as partial.

- **Fixed — webview dropped the v0.2 runtime messages**: the host-message allow-list lacked `runtimeState`,
  `runtimeUpdated` and `traceDetail`, so in VS Code the Trace waterfall stayed on "Loading…" and live updates did not
  refresh the open view. The list is now a `Record` over the message union (a missing type fails to compile).
- **Fixed — Ctrl-C with an HTTP(S) proxy set**: the CLI re-runs itself to enable `NODE_USE_ENV_PROXY`; the parent died
  on Ctrl-C while the child kept printing. It now outlives the child.
- **Windows Ctrl-C ends the process tree**: after Ctrl-C, whatever still runs 10 s later (a JVM stuck in shutdown hooks,
  `mvn.cmd` waiting at "Terminate batch job (Y/N)?") is ended with `taskkill /T /F`; a second Ctrl-C ends it at once.
  Exit code 130. `scripts/runtime-win.mjs` (AC-RT-WIN) drives a real console Ctrl-C through `mvn.cmd` with the agent in a
  Chinese + space path.
- **Overloads, static**: calls pick the overload from the statically evident argument types (literals, `new`, casts,
  locals, parameters, fields, `Type.CONSTANT`, string concatenation, same-class helper and getter return types, Lombok
  getters; fixed arity before varargs). Undecidable calls are listed as `ambiguous-overload` instead of taking the first
  method. Held-out: mall-swarm `deleteBatch(List)` now reaches `deleteBrand(List)` (was `deleteBrand(Long)`), JeecgBoot
  `AiragModelController.test` reaches the `AiragModel` overloads; 2 undecidable calls left in JeecgBoot, none in the
  RuoYi pair or mall-swarm.
- **Overloads, runtime**: the agent instruments by method name, so one span name covers every overload. Steps record
  `overloads`; such a step is credited only where its caller pins it (the route's controller method, or a certain caller
  with a static edge to it), with that edge's counts; otherwise the span is reported as ambiguous.
- **RabbitMQ runtime confirmation**: links carry the destinations the agent reports (publish → exchange or `<default>`;
  delivery → exchange; Spring listener → routing key). A link is confirmed when the producer was seen on its exchange and
  the consumer on its routing key or queue; an exchange-only match, or several queues behind one exchange, also needs the
  listener method observed. Spring Cloud Stream channels match on any binder. Verified on a real broker in CI
  (`runtime-rabbitmq`: rabbitmq:3.13 service container, `fixtures/synthetic/rabbitmq`, topic exchange → queue).
- **AC#23 on a real JVM**: `fixtures/synthetic/reflection` + `node scripts/runtime-e2e.mjs --reflection-only` — reflection
  into another bean is listed as runtime-only reachability with no edge; reflection inside one class draws a
  runtime-observed edge.
- **Performance**: route lookups indexed per graph; opening one trace reads only lines containing its id; distinct
  aggregate keys capped (20 000 nodes / 50 000 edges, overflow counted); static-path searches memoised per reconcile.
- **UI**: Trace empty state no longer says "waiting for the first request" when the receiver failed; theme matrix
  screenshots (8 states × Dark / Light / Dark HC / Light HC) in `docs/screenshots/v0.2`, regenerated by
  `scripts/theme-shots.mjs` from the webview dev harness (`?theme=hc-dark|hc-light`, `?runtime=<state>`, `?observed=1`).

## 0.2.0 — 2026-10-15

Runtime reconciliation (Java) and message-queue links. Plan and review record: docs/spec-v0.2.md; spike evidence: docs/s0-spike.md.

- **Message queues (static)**: Kafka (`topics`, `topicPattern`, template default topic), RabbitMQ (`@RabbitListener`
  queues / `queuesToDeclare` / `@QueueBinding`, `@Bean` Queue/Exchange/Binding via BindingBuilder / ExchangeBuilder /
  QueueBuilder / `new Binding`, direct · topic `*` `#` · fanout · default exchange, one dead-letter hop for TTL delay
  queues), RocketMQ (`topic:tag`, `a || b` selectors; SQL92 reported), Redis Stream (`opsForStream().add`, listener
  containers, `read`), Spring Cloud Stream functional bindings. Destinations fold through constants, enum getters and
  `${}` config; anything else is listed (ATLAS-W034), never guessed. Consumers are `mq-consumer` entrypoints; producer
  flows continue into the consumer service; topology draws topics/queues/streams as channel nodes.
- **Runtime reconciliation**: local OTLP receiver (127.0.0.1, Host allow-list, Origin rejected, per-workspace token
  checked before the body is read, size caps), hand-written protobuf + JSON decoder fuzzed against protobufjs,
  whitelisted span records (no SQL text, bodies, headers, Redis values, command lines), incremental aggregates
  independent of raw-span retention (7 days / 100 000 spans), reconciliation onto the static graph (observed steps,
  edges, entrypoints, coverage; same-class runtime edges; everything else "reachable", never a guessed edge),
  cross-service confirmation (HTTP/Feign client→server, Kafka/RabbitMQ/RocketMQ consumers, Redis streams from both
  sides of a key).
- **Capture**: pinned OpenTelemetry javaagent 2.31.1 (sha256; Maven Central then Aliyun; ASCII-path copy), agent
  config generated from the graph (filters, interceptors, aspects, controllers, services; MyBatis on), per-launcher
  injection (`java -jar`, `mvn spring-boot:run` via `spring-boot.run.agents`, `JAVA_TOOL_OPTIONS` otherwise with
  build-tool JVMs dropped). VS Code: "Copy VM options" (IDE-agnostic primary path), "Launch with tracing" (command
  shown first, no file written), status bar, first-observation toast, 60 s no-span hint. CLI: `project-atlas trace
  [--print-config] [-- <command>]`, `trace import <file>`, observed stats in `show`. MCP: observed stats in `get_flow`,
  `list_traces` (aggregates only).
- **UI**: Trace tab (receiver status, empty state with a request that needs no login, live list, waterfall with layer
  badges and async marks, static-vs-observed report), observed badges and `count · p95 · errors` on the flow, single-
  trace mode, observed links and channel nodes on the topology.
- **Static precision**: data objects (entities, DTOs, enums, `AjaxResult`) and plain accessors are no longer flow
  steps (199 such steps in RuoYi-Vue; JeecgBoot "flows reaching a service" 1635 → 1613, all removed ones were
  accessor-only).
- **Verified**: S0 spike on a real RuoYi-Vue run; `scripts/runtime-e2e.mjs` — RuoYi-Vue through
  `project-atlas trace -- java -jar` (GET /system/user/list observed on 9/9 steps), Redis stream and Kafka (local KRaft)
  two-service scenarios confirming their links; VS Code E2E (copy VM options → receiver → observed flow in ~3 s);
  10 000 spans reconciled < 2 s; 720 000-span soak.

## 0.1.0 — 2026-10-15

First release. Scope per docs/spec.md "范围裁决 v1.2".

- Deterministic project map for Java Spring + Vue (no AI key needed): services, modules, entrypoints,
  request flows (filters → interceptors → @PreAuthorize → aspects → controller → service → mapper → SQL),
  startup guides with file:line evidence, per-module git history.
- Cross-service links: dev proxy → Spring Cloud Gateway (StripPrefix, RewritePath, PrefixPath,
  default-filters, GlobalFilters) → service; OpenFeign; RestTemplate/WebClient; Nacos configs from SQL dumps
  (shared/extension configs, spring.config.import).
- Optional BYO-key AI (Anthropic, OpenAI-compatible, Ollama): module summaries, feature list, change summaries;
  per-phase cost confirmation, secret redaction, evidence check, input-hash cache. Disabled in Restricted Mode.
- VS Code extension: Atlas panel (overview, topology, modules, features, startup, flow swimlane, history),
  activity-bar tree, CodeLens, walkthrough, "mark edge as wrong" → .atlas/overrides.yaml, HTML/ATLAS.md export,
  diagnostics bundle. atlas.yaml v1 (services incl. hardened shallow clones, wrappers, edges, ignoreEntrypoints).
- CLI `project-atlas analyze|show|estimate`, read-only MCP server `atlas-mcp`.
- Verified: RuoYi-Vue 148/148 and RuoYi-Cloud 137/137 endpoints; 50k-file synthetic repo in ~30 s / <700 MB;
  E2E in VS Code (no-key map in ~5 s).
