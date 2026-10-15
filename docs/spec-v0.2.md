# ProjectAtlas v0.2 计划：本地运行时追踪（Java）+ 消息队列链路

> 状态：草案，2026-10-15。上位文档是 `docs/spec.md`：本文件只写 v0.2 的范围、取舍和新增决策；
> 设计细节（接收器、合并规则、存储、安全加固）沿用 spec.md「运行时追踪（仅本地）」「评审修订 v1.1」两节，除非本文明确改写。

## 1. 范围

| 纳入 v0.2 | 推迟 |
|---|---|
| **R** 本地运行时追踪，仅 Java（Spring Boot）：OTLP/HTTP 接收器、带追踪启动、span → 流转合并、runtime-observed 边、运行时印证 ServiceLink | Python 运行时（v0.4）、Go 中间件 diff（v0.3） |
| **M** 消息队列静态链路，仅 Java 端：Kafka、RabbitMQ、RocketMQ、Redis Stream 的生产者 ↔ 消费者配对 | Go/Python 端的 MQ 识别（随各自栈）、gRPC（v0.3）、Dubbo（v0.4） |
| **U** 界面：Trace 标签页（列表 + 瀑布图）、流转图叠加 observed（加粗 + 耗时）、拓扑图 MQ 中间节点、状态栏统一追踪状态 | 导入外部 OTLP/AppMap 数据（TODOS） |
| **C** CLI：`project-atlas trace -- <启动命令>`（注入环境变量、接收 span、写 `.atlas/traces/`），`analyze` 自动合并已有 trace | — |
| **P** MCP：`get_flow` 返回 observed 统计；新增 `list_traces` | — |

## 2. 关键决策（v0.2 新增，括号内是默认选择）

- **V1 带追踪启动的形态（默认：开一个注入了环境变量的 VS Code 终端，不改任何文件）。** spec.md 原设计是生成 `.vscode/launch.json` / tasks 并先展示 diff。改为：默认直接在集成终端里用 StartupGuide 的命令启动，环境变量（`JAVA_TOOL_OPTIONS`、`OTEL_*`）只存在于这个终端进程；另提供「保存为启动配置」，那条路径才写 launch.json 并先展示 diff。理由：首次体验不碰用户文件，撤销成本为零；需要调试断点的人再选写配置。
- **V2 OTLP 解码（默认：手写最小 protobuf 解码器，零依赖）。** Java agent 的 exporter 只支持 `grpc` 和 `http/protobuf`，不支持 `http/json`。trace 的 proto 只用到 varint、length-delimited、fixed64 三种 wire type，手写解码约 200 行，比引入 protobufjs + 生成代码轻；同时接受 JSON（便于测试和其他 SDK）。
- **V3 Java agent 获取（默认：opentelemetry-javaagent 2.31.1，Maven Central → 阿里云镜像依次尝试，sha256 写死在代码里）。** 下载到扩展 globalStorage（CLI 用 `~/.project-atlas/agents/`）；提供 `atlas.runtime.javaagentPath` 指向本地 jar 以支持离线；sha256 不符则拒绝使用。
- **V4 业务层 span（默认：`OTEL_INSTRUMENTATION_METHODS_INCLUDE` 列出静态分析得到的 Controller/Service 实现类方法；Mapper 层靠 JDBC span 归属）。** MyBatis Mapper 是 JDK 动态代理，能否被 methods 插桩要在 S0 验证。若不能：JDBC span 归属到其父 service 方法 span 对应的 FlowStep 的 Mapper 被调方——被调方唯一时直接匹配；多个时按 `db.operation` + `db.sql.table` 与 Mapper XML 语句的操作类型和表名比对（规则匹配，不用 SQL 全文指纹）；仍不唯一则只记在 service 步骤上，不猜。
- **V5 存储**：沿用评审修订 A3，`.atlas/traces/*.jsonl` 分段 + 内存索引，保留 7 天或 10 万 span（先到者为准）。span 属性只存白名单键（route、method、status、code.*、db.operation/table、messaging.*、rpc.*、server.address/port、exception.type），**SQL 参数、请求体、header 不落盘**——比 spec.md「不发送给 LLM」更严。
- **V6 MQ 配对键**：Kafka = topic；RabbitMQ = exchange + routingKey → 解析 `@Bean Binding`/`BindingBuilder` 与 `@RabbitListener(bindings=@QueueBinding)` 得到 queue；RocketMQ = topic（+ tag 表达式，`*` 匹配全部）；Redis Stream = stream key。topic/key 必须经常量和配置占位符解析后确定，否则不连线，只记未解析（W 码）。拓扑图把 topic/queue/stream 画成中间节点。
- **V7 runtime-observed 边**：运行时才出现的调用（静态没有的 caller→callee）新增为 `provenance: runtime-observed` 的边，置信度 1，样式独立；不回写到静态规则，也不进入 AI 输入。

## 3. 里程碑

| # | 内容 | 依赖 | 门 |
|---|---|---|---|
| S0 | **Spike**：便携 Maven + 便携 MySQL 跑起 RuoYi-Vue；挂 agent 2.31.1，验证 ①Controller/Service 方法 span ②Mapper JDK 代理能否插桩 ③JDBC span 属性 ④http.route 形态；手写 protobuf 解码能解出真实请求 | — | 任何一项不成立就回到本文件改 V4 / V2 |
| R1 | OTLP 接收器（127.0.0.1、Host 白名单、拒绝 Origin、会话 token、4 MB/32 MB 上限、protobuf+JSON） + JSONL 存储 + 保留策略 | S0 | 单元 + 集成测试 |
| R2 | span → FlowStep 合并：code.* → 父子 + http.route → CGLIB 类名规范化 → JDBC 归属；observed 统计（count/p50/p95/error/lastSeen/sampleTraceIds）；runtime-observed 边；跨服务 traceparent → ServiceLink 印证 | R1 | 1 万 span < 2 s |
| R3 | agent 获取与校验；CLI `trace` 命令；VS Code「带追踪启动」（终端 + 可选保存配置）；状态栏；受限模式禁用 | R1 | — |
| M1 | MQ 四类静态规则 + 合成夹具 `fixtures/synthetic/{kafka,rabbitmq,rocketmq,redis-stream}`（纯 Java，本项目自写） | — | 召回 100%、误配 0 |
| U1 | Trace 标签页、流转图 observed 叠加、拓扑 MQ 节点 | R2, M1 | 4 主题截图 |
| E1 | 端到端：RuoYi-Vue 带追踪启动 → `GET /system/user/list` → AC#3 各步 observed；Redis Stream 合成夹具跨服务 trace 印证 ServiceLink；反射调用合成用例出现 runtime-observed 边 | 全部 | v0.2 验收 |

R 与 M 两条线互不依赖，可并行。

## 4. 验收（v0.2 子集，编号沿用 spec.md）

- **AC#16（收窄）**：Kafka、RabbitMQ、RocketMQ、Redis Stream 的 Java 生产/消费配对召回 100%、误配 0；含常量和占位符解析用例。
- **AC#19**：RuoYi-Vue 带追踪启动后请求一次 `GET /system/user/list`，AC#3 每一步 10 秒内显示 observed（含耗时）；agent 经 sha256 校验。
- **AC#22（本机部分）**：Redis Stream 合成夹具两个服务跑起来后，跨服务 trace 生成或印证 ServiceLink（provenance 含 runtime-observed）。Kafka/RabbitMQ/RocketMQ 的运行时版本只在 Linux CI（docker）跑。
- **AC#23**：反射调用合成用例出现 `runtime-observed` 边。
- **AC#24**：接收器只监听 127.0.0.1；带 Origin 的请求被拒；发给 LLM 的 payload 不含任何 span 属性值；SQL 参数和请求体不落盘。
- **AC#25**：1 万 span 合并 < 2 s；超出保留上限自动清理。
- **AC-RT-DX（新增）**：已有 v0.1 分析结果的 RuoYi-Vue，从点「带追踪启动」到流转图出现第一条 observed，除去服务自身启动时间不超过 30 秒，且不修改工作区任何文件（V1 默认路径）。

## 5. 风险

| 风险 | 应对 |
|---|---|
| Mapper 代理无法插桩，Mapper 步骤缺 observed | V4 的 JDBC 归属兜底；S0 先验证 |
| 国内网络下载 agent 失败 | 阿里云镜像 + 本地路径配置；错误码给出手动下载命令 |
| 用户项目自带别的 javaagent（SkyWalking 等） | 检测已有 `-javaagent`，提示冲突，不强行叠加 |
| JAVA_TOOL_OPTIONS 已被用户设置 | 追加而不是覆盖 |
| Spring Boot 3 / Java 21 与 agent 兼容 | 2.31.1 支持 Java 8+；S0 在 RuoYi-Vue（Boot 2.x / Java 8 目标）和一个 Boot 3 合成服务上都验证 |
| 本机无 Docker | Kafka/RabbitMQ/RocketMQ 运行时 E2E 只放 Linux CI；本机用 Redis Stream 覆盖跨服务运行时 |

## 6. 测试估算

单元：protobuf 解码、接收器加固、存储与保留、合并各优先级、MQ 四类规则（含占位符）、CLI trace 参数，约 +70。集成：接收器真实 HTTP、合成 span 流合并到 RuoYi 图，约 +8。E2E：S0 脚本化成 `scripts/runtime-e2e.mjs`（RuoYi-Vue + Redis Stream 夹具），本机和 Linux CI 均可跑。
