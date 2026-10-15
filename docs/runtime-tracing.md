# 运行时对账 / Runtime reconciliation (v0.2)

> 中文在前，English below.

ProjectAtlas 先用静态规则画出请求流转（过滤器 → 拦截器 → 切面 → Controller → Service → Mapper → SQL，跨服务的网关、Feign、MQ）。v0.2 加上**运行时对账**：用 OpenTelemetry javaagent 在本机启动你的 Spring Boot 服务，发几个请求，Atlas 就会标出哪些步骤和链路**真的执行了**、耗时多少，哪些调用**只在运行时出现**。

数据只在本机：接收器只监听 `127.0.0.1`，span 存在工作区的 `.atlas/traces/`（7 天或 10 万个 span），**SQL 文本、请求体、header、Redis 的值一律不落盘**，也不会发给任何 AI。

## 快速开始

### 1. IntelliJ IDEA / Eclipse（推荐）

1. VS Code：Atlas 面板 → **启动** 标签页 → 服务旁的「复制追踪用的 VM 参数」（或命令 `Atlas: Copy VM Options for Tracing`）。首次使用会下载固定版本的 `opentelemetry-javaagent-2.31.1.jar`（约 25 MB，先 Maven Central、再阿里云镜像，校验 sha256）。
2. IDEA：Run ▸ Edit Configurations ▸ Modify options ▸ **Add VM options**，粘贴。
3. 重启服务，发一个请求（Trace 标签页会给出一个不需要登录的 `curl`，若依是 `/captchaImage`）。
4. 流转图上真正执行过的步骤会出现 `✓ p95` 角标；Trace 标签页列出每个请求和瀑布图。

命令行也一样：

```bash
project-atlas trace --print-config      # 打印 VM 参数，然后持续接收，Ctrl-C 结束并打印摘要
```

### 2. 直接从命令行启动

```bash
project-atlas trace -- java -jar ruoyi-admin/target/ruoyi-admin.jar
project-atlas trace -- mvn -pl ruoyi-admin spring-boot:run     # 先在根目录 mvn install 一次
project-atlas trace -- mvn test                                 # 把测试套件当作请求来源
```

`java -jar` 会在 `java` 之后插入 agent 参数；`mvn spring-boot:run` 通过 `-Dspring-boot.run.agents` 注入（Maven 自身的 JVM 不会被插桩）；其他命令（`mvn test`、Gradle、`sh ry.sh start`）通过 `JAVA_TOOL_OPTIONS` 追加，构建工具 JVM 发来的 span 会按命令行自动丢弃。命令结束（或 Ctrl-C）后打印观测到的入口、步骤覆盖率和「仅运行时」调用；退出码原样透传。加 `--json` 时，应用自己的输出走 stderr，stdout 只有一份 JSON。

### 3. VS Code 里一键启动

启动标签页 →「带追踪启动」：选择启动命令（来自启动指南），确认对话框会显示**将要执行的完整命令和注入的环境变量**，然后在集成终端里运行。不修改工作区里的任何文件。

### 4. 已有的 trace 文件

```bash
project-atlas trace import traces.pb    # 或 OTLP/JSON
```

## 怎么读结果

| 标记 | 含义 |
|---|---|
| 步骤上的 `✓ 21 ms` | 运行时观测到，p95 耗时；红框表示有错误 |
| 边上的 `12× · p95 12ms ⚠ 1/12` | 这条调用被观测 12 次，1 次出错 |
| 「步骤覆盖 9/9」 | 该入口流转上可插桩的步骤里，有几个被观测到（`@PreAuthorize` 这类注解不计入） |
| `●` 运行时边 | 静态规则内联掉的同类内调用（如 `selectCaptchaEnabled → selectConfigByKey`） |
| `⇝` 运行时可达 | 中间隔着没插桩的代码（框架分发、反射、未被入口走到的方法），**只列出，不画边**（宁缺勿错） |
| 单条 trace 模式 | 从瀑布图点「在流转图中查看」：只显示这一次请求的耗时，没经过的步骤变暗 |
| 拓扑图 `· 3×` | 跨服务链路被运行时印证：HTTP/Feign/网关看父子 span；Kafka/RabbitMQ/RocketMQ 看消费端；Redis Stream 不传播 trace 上下文，生产和消费两端都在同一个 key 上出现才算 |

## 离线 / 内网

下载 `opentelemetry-javaagent-2.31.1.jar`（sha256 `bbf83c151b6400709e2f225bdd07a04f839d9d13b8b93464241333fd25d3e3ba`）：

```text
https://maven.aliyun.com/repository/public/io/opentelemetry/javaagent/opentelemetry-javaagent/2.31.1/opentelemetry-javaagent-2.31.1.jar
```

然后在 VS Code 用户设置里填 `atlas.runtime.javaagentPath`，或命令行设 `ATLAS_JAVAAGENT_PATH`。路径里有中文时会自动复制到纯 ASCII 目录（JDK 在 GBK 代码页下遇到某些字符会启动失败）。

## 常见问题

| 现象 | 处理 |
|---|---|
| 60 秒内没有 span（ATLAS-W033） | 服务输出里应有 `opentelemetry-javaagent - version: 2.31.1`；没有说明 VM 参数没生效。还要确认 `http.nonProxyHosts` 没让 127.0.0.1 走公司代理 |
| 状态栏显示「已拒绝 N」（ATLAS-W030） | 多半是旧会话里启动的应用在用失效的地址：重新复制 VM 参数后重启服务 |
| 下载失败 / sha256 不符（E070 / E071） | 按提示里的命令手动下载；sha 不符多是代理返回了登录页 |
| 已有 SkyWalking / Arthas agent（E072） | 两个 agent 可能互相干扰；本次可以先去掉，或确认叠加 |
| CLI 和 VS Code 同时追踪同一个工作区（E074） | 每个工作区只能有一个接收器；第二个 CLI 会自动复用第一个的接收器 |
| 某个 Mapper 步骤没有 ✓ | 默认开启 MyBatis 插桩；如果你在配置里关了它，SQL 只能按 Service 归属，有多个 Mapper 时不猜 |

## 隐私与安全

- 接收器只绑定 127.0.0.1；拒绝带 `Origin` 的请求（浏览器）和非本机 Host（DNS rebinding）；每个工作区一个随机 token，存在 `~/.project-atlas/tokens/`，在读取请求体之前校验。
- 落盘字段是白名单：路由、方法、状态码、类名和方法名、SQL 操作名和表名、MQ 目的地、Redis Stream 的 key、异常类型、线程名。`process.command_line`、主机名、`db.statement`、URL 查询串、状态消息一律丢弃。
- MCP（`list_traces`、`get_flow`）只返回聚合值（次数、耗时、路由、状态），不返回 span 属性。
- 受限模式（Workspace Trust）下不能启动追踪；启动命令来自仓库内容，运行前总会显示。

---

# Runtime reconciliation (English)

v0.2 adds **runtime reconciliation**: start your Spring Boot service with the OpenTelemetry javaagent, send a few requests, and Atlas marks which steps and cross-service links really ran, how long they took, and which calls only appear at runtime. Everything stays on this machine: the receiver listens on `127.0.0.1` only, spans live in `.atlas/traces/` (7 days or 100 000 spans), and **SQL text, request bodies, headers and Redis values are never stored** or sent to any AI.

## Quick start

- **IDE (recommended):** Atlas panel ▸ Startup ▸ "Copy VM options for tracing" (or `Atlas: Copy VM Options for Tracing`), paste into IDEA ▸ Run ▸ Edit Configurations ▸ Modify options ▸ Add VM options, restart, send a request. The first use downloads the pinned `opentelemetry-javaagent-2.31.1.jar` (Maven Central, then Aliyun mirror; sha256-checked). CLI equivalent: `project-atlas trace --print-config`.
- **CLI launch:** `project-atlas trace -- java -jar app.jar`, `project-atlas trace -- mvn spring-boot:run` (run `mvn install` at the root once), `project-atlas trace -- mvn test`. The command's exit code is passed through; with `--json` the app's output goes to stderr.
- **VS Code launch:** Startup ▸ "Launch with tracing" shows the exact command and injected environment before it runs in an integrated terminal; no workspace file is written.
- **Existing traces:** `project-atlas trace import traces.pb` (protobuf or OTLP/JSON).

## Reading the result

`✓ 21 ms` on a step = observed, p95. `12× · p95 12ms ⚠ 1/12` on an edge = observed 12 times, one error. "Steps observed 9/9" = instrumentable steps of the flow that ran (annotation markers such as `@PreAuthorize` are not counted). `●` runtime edges are same-class calls the static rules inline; `⇝` "reachable" calls went through uninstrumented code (framework dispatch, reflection) and are listed, never drawn. Topology links show `· N×` when confirmed: HTTP by client/server spans, Kafka / RabbitMQ / RocketMQ by consumers, Redis streams (no context propagation) only when both sides were seen on the same key.

## Offline

Download `opentelemetry-javaagent-2.31.1.jar` (sha256 `bbf83c151b6400709e2f225bdd07a04f839d9d13b8b93464241333fd25d3e3ba`) and set `atlas.runtime.javaagentPath` (user settings) or `ATLAS_JAVAAGENT_PATH`. Paths with non-ASCII characters are copied to an ASCII directory automatically.

## Troubleshooting

See the table above (ATLAS-W033 no spans, W030 rejected requests, E070/E071 download, E072 another agent, E074 receiver in use) and [errors.md](errors.md).
