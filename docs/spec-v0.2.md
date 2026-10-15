<!-- /autoplan restore point: /c/Users/admin/.gstack/projects/project-atlas/feat-v0.2-autoplan-restore-20261015-124844.md -->
# ProjectAtlas v0.2 计划：运行时对账（Java）+ 消息队列链路

> 状态：/autoplan 评审后修订版，2026-10-15，等待最终闸门。上位文档是 `docs/spec.md`：本文件只写 v0.2 的范围、取舍和新增决策；
> 未在此改写的细节沿用 spec.md「运行时追踪（仅本地）」「评审修订 v1.1」两节。**本文与 spec.md 冲突时以本文为准。**

## 0. 定位（评审后新增）

v0.2 的价值不是「又一个 trace 查看器」（SkyWalking、Jaeger、IDEA 都做得更好），而是**把运行时观测与静态图对账**：哪些静态边被真实请求证实、哪些从未走到、哪些调用只在运行时出现。产出物是「已验证调用图」，人在面板里看，AI 代理通过 MCP 读。采集方式要与 IDE 无关：目标用户（若依 / Spring Cloud Alibaba 的中国 Java 开发者）大多在 IntelliJ IDEA 里启动服务。

## 1. 范围

| 纳入 v0.2 | 推迟 |
|---|---|
| **R** Java 运行时：OTLP/HTTP 接收器（IDE 无关）、agent 获取与校验、span → 流转对账、runtime-observed 边（严格条件）、跨服务印证 ServiceLink | Python 运行时（v0.4）、Go 中间件 diff（v0.3） |
| **R+** 采集入口：①「复制 VM 参数」给 IDEA/Eclipse/`java -jar`（主路径）②VS Code「带追踪启动」（便捷路径）③CLI `trace -- <命令>`（含 `mvn test` 测试运行采集）④OTLP 文件导入 | SkyWalking 导入、Arthas 导入、docker 内服务（TODOS） |
| **D** 对账输出：静态 vs 实测差异（已证实 / 静态但从未走到 / 仅运行时 / 未匹配），面板 + `ATLAS.md` + MCP | 规则精度自动度量报表 |
| **M** MQ 静态链路（Java 端）：Kafka、RabbitMQ、RocketMQ、Redis Stream、Spring Cloud Stream bindings | Go/Python 端 MQ、gRPC（v0.3）、Dubbo（v0.4） |
| **U** 界面：独立追踪状态栏项、Trace 标签页（列表 + 简洁瀑布图）、流转图「聚合 / 单条 trace」两种模式、拓扑图 MQ 节点 | 动画回放 |
| **C/P** CLI `trace`、`trace import`、`trace --print-config`；MCP `get_flow` 带 observed，新增 `list_traces`（只返回聚合值） | — |

## 2. 关键决策

- **V1 采集入口与注入方式。**
  - **主路径（IDE 无关）**：接收器常驻（扩展激活时或 `project-atlas trace --print-config` 启动），给出可直接粘贴的 VM 参数：`-javaagent:<短路径>/opentelemetry-javaagent.jar -Dotel.javaagent.configuration-file=<配置文件>`。配置文件里写端点、token、服务名、方法清单。VS Code 里是「复制 VM 参数」按钮（启动视图每个目标一个）。
  - **便捷路径**：VS Code 终端启动，环境变量通过终端 API 的 `env` 字段注入，绝不拼进命令字符串；默认不改任何文件。「保存为启动配置」另行提供，只引用工作区外的 env 文件（不把 token/端口写进 `launch.json`）。启动前显示「将注入什么」的单屏说明，并显示即将执行的命令（命令来自仓库内容，受信任工作区也要展示）。
  - **按启动器注入**：`java -jar` → 直接加 `-javaagent`；`mvn spring-boot:run` → `-Dspring-boot.run.agents=<jar>` 加 `-Dspring-boot.run.jvmArguments=...`（不用 `JAVA_TOOL_OPTIONS`，避免 Maven 自身 JVM 被插桩）；`mvn test` / Gradle / 其他 → `JAVA_TOOL_OPTIONS`（追加不覆盖），并在文档中说明构建工具 JVM 也会产生 span，按 `service.name` 过滤。
  - **用户自己的 `OTEL_*` 优先**，端点、headers（token）除外。
- **V2 OTLP 解码**：手写解码器，零运行时依赖。
  - 支持 wire type 0/1/2/5，未知字段一律跳过。
  - 时间戳用 BigInt；`AnyValue` 嵌套深度上限 8。
  - varint 长度与 length 越界检查；gzip 解压后上限 32 MB，请求体上限 4 MB。
  - 返回标准的 `ExportTraceServiceResponse`；同时接受 JSON。
  - 测试：用 protobufjs（devDependency）生成的编码做对照模糊测试，并用 S0 抓到的 2.31.1 真实请求做黄金文件。
- **V3 agent 获取。**
  - 版本：opentelemetry-javaagent **2.31.1**，sha256 `bbf83c151b6400709e2f225bdd07a04f839d9d13b8b93464241333fd25d3e3ba`（2026-10-15 已与 Maven Central 的 `.sha256` 文件核对）。
  - 来源：Maven Central → 阿里云镜像，下载走代理（复用 `f6fb4a1` 的代理处理）。
  - 写入：先下到临时文件，有大小上限，校验后原子改名。
  - 缓存：CLI 与扩展共用 `~/.project-atlas/agents/`；**每次启动前重新校验 sha256**。
  - 路径含空格或非 ASCII 字符时（Java 8 不支持引号），复制到纯 ASCII 短路径。
  - `atlas.runtime.javaagentPath` 设为 machine 级设置，工作区设置改不了它。
  - 校验失败时报告字节数和 content-type，便于识别代理返回的 HTML 登录页。
- **V4 业务层 span。**
  - 方法清单写入 agent 配置文件（`otel.instrumentation.methods.include`），不用环境变量，避开 Windows 32 K 限制，诊断包里也可见。
  - 清单 = 静态图中**所有 FlowStep 的方法**：Filter#doFilter / doFilterInternal、Interceptor#preHandle、切面通知方法、Controller、Service 实现类方法。不含 getter 和工具类。
  - Mapper 层：先用 agent 自带的 MyBatis 插桩（S0 验证）；不行再按 JDBC span 归属。被调方唯一时直接匹配；否则按 `db.operation` + 表名与 Mapper XML 比对；PageHelper 的 `count(0)` 或缺表名时只记在 service 步骤上，不猜。
  - 重载方法匹配到多个步骤时进入「未解析」。
- **V5 存储：原始 span 与聚合分离。**
  - 原始 span 写 `.atlas/traces/*.jsonl`，属性只落白名单：`http.route`、`http.request.method`、状态码、code.*（新旧两代）、`db.operation`/`db.collection.name`（只存操作名和表名，**不存 SQL 文本**）、`messaging.*`、`rpc.*`、`server.address/port`、`exception.type`。
  - 永不落盘：Status.message、`url.query`/`url.full`、请求体、header、SQL 参数。
  - 保留 7 天或 10 万 span，按段删除。
  - **聚合单独存** `.atlas/traces/aggregates.json`：按「规范键」（类 FQN + 方法名，或 route + method、MQ destination）累计计数、错误数、分位数草图。原始 span 被淘汰后统计仍在；每次展示时把规范键重新解析成当前图里的步骤 ID。
  - 解析不到的进入「过期」计数；源文件哈希变化的步骤标「代码已改动」。
- **V6 MQ 配对。**

  | 消息系统 | 配对规则 |
  |---|---|
  | Kafka | topic，含 `topicPattern` 正则、`KafkaTemplate` 默认 topic |
  | RabbitMQ | 按交换机类型匹配（direct 精确；topic 支持 `*`/`#`；fanout 忽略 key；默认交换机 `""` 按队列名）。绑定来自 `@Bean Binding`/`BindingBuilder`/`Declarables`/`@QueueBinding`；`RabbitTemplate` 有默认交换机；SpEL `#{}` 记为未解析 |
  | RocketMQ | `"topic:tag"` 目的地、`tagA \|\| tagB`；SQL92 选择器记为未解析 |
  | Redis Stream | stream key |
  | Spring Cloud Stream | `spring.cloud.stream.bindings.<name>-in-0/out-0.destination` |

  无法确定的一律不连线，只记未解析（W 码）。拓扑图把 topic/queue/stream 画成中间节点。
- **V7 runtime-observed 边（宁缺勿错）。** span 的父节点只是「最近的被插桩帧」，不一定是直接调用者。只有同时满足两个条件才新增边：①静态图里 parent → child 没有任何路径；②child 的所有静态调用方都在插桩清单里。其余情况记为「运行时可达」（不画成边，在差异报告里列出）。跨线程（@Async、线程池）的父子标为异步。
- **V8 接收器单例**：每个工作区一个接收器，`.atlas/receiver.json` 记录 pid、端口和锁。端口按工作区固定（默认从 43180 起找空闲端口，避开本机 collector 常用的 4318）；token 在本机存储、按工作区固定，不随重启变化，避免旧终端里的应用发到失效 token。第二个实例（另一窗口、CLI）发现锁后转发或报 ATLAS-E074 拒绝；写入只追加整行，读取容忍最后一行不完整；轮转删除在 Windows 上遇到 EBUSY 时重试。
- **V9 突发与吞吐**：配置 `otel.bsp.schedule.delay=500`、`otel.bsp.max.queue.size=8192`；接收端立即应答、异步追加；聚合在 worker 中增量、防抖更新，不重写分片图；内存索引只存偏移和键。按 (traceId, spanId) 用有界 LRU 去重（exporter 重试）。`service.name=unknown_service:java` 时按包前缀归属服务。
- **V10 MCP 与隐私**：MCP 只返回聚合值、ID、route 和状态码，不返回任何 span 属性值，与 AC#24 一致。`list_traces(entrypoint?, since?, limit=20, errorsOnly?)`。

## 3. 里程碑

| # | 内容 | 依赖 | 门 |
|---|---|---|---|
| S0 | **Spike**：便携 Maven + 便携 MySQL 跑起 RuoYi-Vue（关闭验证码：`sys.account.captchaEnabled=false`），挂 agent 2.31.1 + 方法清单配置文件。验证：①过滤器/拦截器/切面/Controller/Service 的方法 span ②CGLIB 是否重复 span ③MyBatis 插桩或 JDBC span 属性 ④`http.route` 是否含 context-path ⑤semconv 属性代际 ⑥`mvn spring-boot:run` 注入方式不插桩 Maven 自身 ⑦中文/空格路径。抓取真实 protobuf 请求存为黄金夹具 | — | 任何一项不成立就回到本文件改 V1/V4/V5 |
| M1 | MQ 静态规则（V6）+ 合成夹具 `fixtures/synthetic/{kafka,rabbitmq,rocketmq,redis-stream,scs}` + 保留集（mall-swarm 的 RabbitMQ，另选一个 RocketMQ/Kafka 开源项目） | — | 夹具召回 100%、误配 0；保留集人工抽查 |
| R1 | 接收器（V2、V8、安全加固）+ 原始 span 存储 + 聚合存储（V5）+ 保留策略 | S0 | 单元 + 集成 + 模糊测试 |
| R2 | 对账：规范键匹配（code.* 新旧代 → 父子 + route → CGLIB 规范化 → MyBatis/JDBC 归属）、聚合、V7 边、跨服务印证、差异报告 | R1 | 1 万 span < 2 s |
| R3 | agent 获取（V3）；CLI `trace` / `trace import` / `--print-config`；VS Code 复制 VM 参数、带追踪启动、状态栏；受限模式禁用 | R1 | Windows `mvn.cmd` 启动、Ctrl-C 结束整棵进程树、退出码透传 |
| U1 | 界面（见第 6 节） | R2, M1 | 状态矩阵每一行都有截图；4 主题 |
| E1 | 端到端（见第 4 节）；`docs/runtime-tracing.md`（中英） | 全部 | v0.2 验收 |

M1 与 S0/R 系列互不依赖，**先做 M1**（低风险、可独立验证），S0 并行。

## 4. 验收（编号沿用 spec.md，带 ★ 为本次修订）

- **AC#16★**：MQ 五类（含 Spring Cloud Stream）合成夹具召回 100%、误配 0；含常量、占位符、topic 交换机通配、`topic:tag` 用例；保留集人工抽查无误配。
- **AC#19★**：RuoYi-Vue 用「复制 VM 参数」方式启动（脚本模拟 IDEA：`java -jar` + VM 参数）并请求一次 `GET /system/user/list`。AC#3 的过滤器、拦截器、切面、Controller、Service、Mapper/SQL 各步在 10 秒内显示 observed（含耗时）。经 S0 证实确实无法插桩的步骤显示「不可插桩」，不算失败。agent 经 sha256 校验。
- **AC#22★（本机）**：两条线：①Kafka KRaft 单机（无需 docker）上的合成夹具，跨服务 trace 印证 ServiceLink；②Redis Stream 不传播 trace 上下文，改为「生产端和消费端都在同一已解析 key 上被观测到」即视为印证。RabbitMQ/RocketMQ 的运行时版本只在 Linux CI（docker）上跑。
- **AC#23★**：两个合成用例：反射调用（静态无路径）出现 runtime-observed 边；中间隔一个未插桩方法时**不**生成假边，只记为「运行时可达」。
- **AC#24★**：
  - 接收器只监听 127.0.0.1；带 Origin、Host 不在白名单、token 错误的请求一律拒绝；token 在解压和解析之前先校验（常量时间比较）。
  - 发给 LLM 和 MCP 的内容里没有任何 span 属性值。
  - SQL 文本、SQL 参数、请求体不落盘。
- **AC#25**：1 万 span 合并 < 2 s；超出保留上限自动清理；**原始 span 淘汰后聚合统计仍在**。
- **AC-RT-DX★**：已有 v0.1 分析结果的 RuoYi-Vue，从「复制 VM 参数」或「带追踪启动」到流转图出现第一条 observed，除去服务自身启动时间：首次（含下载 agent）≤ 5 分钟，之后 ≤ 2 分钟；不修改工作区任何文件。
- **AC-RT-SOAK（新增）**：200 span/s 持续 1 小时，扩展宿主 RSS 增长 < 100 MB，丢弃计数准确。
- **AC-RT-WIN（新增）**：Windows 上 agent 路径含中文和空格、`mvn.cmd` 启动、Ctrl-C 结束子进程树，三项都通过。

## 5. 错误码（v0.2 新增，写入 docs/errors.md）

| 码 | 场景 | 修复提示要点 |
|---|---|---|
| ATLAS-E070 | agent 下载失败（全部来源） | 给出阿里云 URL 的 `curl` 和 `Invoke-WebRequest` 命令、sha256、`atlas.runtime.javaagentPath` |
| ATLAS-E071 | sha256 不符 | 报告字节数和 content-type（识别代理登录页），删除文件 |
| ATLAS-E072 | 已存在 `-javaagent`（SkyWalking 等） | VS Code 弹框「仍然叠加 / 取消」；CLI 需 `--allow-agent-conflict` |
| ATLAS-E073 | Java 版本过低（< 8）或检测失败 | 显示 `java -version` 输出 |
| ATLAS-E074 | 接收器已被另一实例占用且无法转发 | 显示占用者 pid 和窗口 |
| ATLAS-I010 | 端口被占用，已换端口 | 状态栏显示实际端口 |
| ATLAS-W030 | 请求被拒（Host/Origin/token） | 诊断包列出最近 20 条拒绝原因 |
| ATLAS-W031 | 解码失败或超限 | 同上 |
| ATLAS-W033 | 60 秒无 span | 排查清单：输出里有没有 `Picked up JAVA_TOOL_OPTIONS` 或 agent 启动日志、token 是否过期、`http.nonProxyHosts` 是否让 127.0.0.1 走了代理、协议是否为 http/protobuf |
| ATLAS-W034 | MQ 目的地无法解析 | 列出表达式位置 |
| ATLAS-W035 | span 匹配不到步骤 / 重载歧义 | 差异报告「未匹配」 |

## 6. 界面

**状态栏**：新增**独立**的追踪项，第一次使用前隐藏，与现有分析项分开。

| 状态 | 显示 |
|---|---|
| 下载 agent | `$(cloud-download) Agent 42%` |
| 等待 span | `$(debug-start) 等待请求` |
| 接收中 | `$(pulse) 132 spans · 3 dropped` |
| 接收器异常 | `$(error) 接收器` |

点击打开 Trace 标签页；悬停显示端口、会话开始时间和匹配覆盖率。

**第一次看到 observed 的过程**：
1. 启动后，Trace 标签页显示「等待请求」卡片，给出可复制的 `curl`。地址优先选不需要登录的入口（如 `/captchaImage`），端口取自启动指南；任何 span 都算「第一条」。
2. 第一条匹配上的根 span 到达时弹出提示「已观测 GET /system/user/list · 38 ms → 打开流转」。
3. 若该入口的流转图已打开，被证实的边原地高亮一次（遵守减少动态效果设置）。

**流转图两种模式**：
- **聚合**（默认）：边上标 `次数 · p95`，节点角标显示自身耗时 p95（避免父节点耗时在每条子边上重复计算）。
- **单条 trace**（从瀑布图进入）：顶部横幅「Trace 4f2a… · 14:02:11 EDT · ✕ 退出」，只显示该 trace 的耗时，未经过的步骤变暗（不隐藏）。

每种模式都标明时间范围。

**边的编码**（不只靠颜色）：

| 维度 | 编码 |
|---|---|
| 来源（实线 / 虚线 / 点线，沿用 v0.1） | 线型 |
| 是否被观测 | 线宽 |
| 异步 | 空心箭头 + `⇢` |
| 错误 | 标签 `⚠ 3/40` |
| 追踪进行中但未走到 | 50% 透明度 |
| 代码已改动 | 角标「旧」 |

图例同步增加以上各行。

**Trace 标签页**：
- 列表列：时间（本地时区绝对时间）、方法 + route、涉及服务、耗时、状态、span 数、匹配覆盖率。
- 默认最新在前；可按入口过滤，也可按 route 分组。
- 新数据到达不打断用户当前选中，只显示「N 条新 ↑」。
- 瀑布图每行带层级标记（Controller/Service/Mapper/SQL）和「定位」；匹配不到静态步骤的行标「无静态步骤」；悬停与流转图节点双向高亮。

**MQ 节点**：
- 形状：胶囊形 + 消息系统图标，一个 topic/queue/stream 只画一个节点。
- 布局：生产者在左、消费者在右。
- 未解析：开关「N 个未解析 topic」，展开后显示为 `?` 占位节点。
- 泳道：topic 单独一列，边上标排队等待时间（消费开始 − 生产结束）。

**启动入口**：
- 主入口在启动视图，每个目标一个「复制 VM 参数」和「带追踪启动」；Trace 空状态和状态栏是次入口。
- 多个目标时用 QuickPick 选择。
- 受限模式下按钮置灰并显示原因。

**状态矩阵（v0.2 新增行）**：

| 场景 | 加载 | 空 | 错误 | 部分 | 过期 |
|---|---|---|---|---|---|
| agent 获取 | 进度（MB、正在尝试的来源） | — | 全部来源失败：手动命令 +「设置 javaagentPath」；sha 不符：阻断，不自动重试 | — | — |
| 接收 | 等待请求卡片 | 从未启动：主按钮 | 接收器异常、端口变化：提示重新启动应用 | 有丢弃：计数 | 应用退出：回到空闲，统计保留为历史 |
| 对账 | — | 无匹配：「未匹配 N」与覆盖率 | 叠加数据损坏：重建 | 「含 N 条未归属 SQL」 | 代码改动：「旧」角标 |

**线框（Trace 标签页）**：
```
┌ Trace ───────────────────────────────────────────────── 接收器 127.0.0.1:43180 · 132 spans ┐
│ [入口 ▾] [按 route 分组 ☐] [仅错误 ☐]                                    3 条新 ↑          │
│ 14:02:11 EDT  GET /system/user/list   ruoyi-admin   38 ms  200  14 spans  覆盖 93%         │
│ 14:01:58 EDT  GET /captchaImage       ruoyi-admin   12 ms  200   3 spans  覆盖 100%        │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ 瀑布图  Trace 4f2a…                                                      [在流转图中查看]   │
│ [Filter]     JwtAuthenticationTokenFilter.doFilterInternal ███████████████████████  38 ms  │
│ [Controller]  SysUserController.list                         ██████████████████    30 ms   │
│ [Service]      SysUserServiceImpl.selectUserList               ████████████        21 ms   │
│ [SQL]           SELECT sys_user                                  ███████           12 ms   │
│ [—]           无静态步骤: HikariPool.getConnection                ▌                 0.4 ms │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 7. 风险

| 风险 | 应对 |
|---|---|
| 过滤器、拦截器、切面插不上桩 | S0 先验证；不行就显示「不可插桩」 |
| 国内网络下载 agent 失败 | 阿里云镜像、代理支持、本地路径配置；E070 给出可复制命令 |
| 用户已有 SkyWalking 等 agent | E072 让用户选择，不强制拒绝 |
| 服务跑在 docker 里 | v0.2 明确不支持（接收器只听 127.0.0.1）；`--listen` 选项进 TODOS |
| 构建工具 JVM 被插桩 | 按启动器分别注入（V1） |
| semconv 属性在版本间变化 | 新旧两代都认；用 S0 黄金夹具做回归 |
| 本机没有 docker | 本机只跑 Kafka KRaft 和 Redis；RabbitMQ、RocketMQ 放 Linux CI |

## 8. 测试估算

| 层级 | 覆盖内容 | 数量 |
|---|---|---|
| 单元 | 解码器（含模糊测试、gzip 炸弹）、接收器加固、存储与聚合淘汰、对账各优先级、V7 两个反例、MQ 五类（含通配和占位符）、CLI 参数与 Windows 启动、MCP 不泄露属性 | 约 +110 |
| 集成 | 真实 HTTP 接收器、黄金夹具合并到 RuoYi 图、CLI 与扩展并发、重新分析期间持续接收 | 约 +12 |
| E2E | `scripts/runtime-e2e.mjs`：RuoYi-Vue + Kafka KRaft 夹具 + Redis Stream 夹具；1 小时耐久脚本 | — |

详见测试计划产物。

---

# /autoplan 评审记录（2026-10-15）

> Codex CLI 未安装：所有阶段都是「主审 + 独立 Claude 子代理」模式（`[subagent-only]`）。各阶段子代理彼此独立、互不知道其他阶段结论。

## Phase 1 — CEO 评审（模式：SELECTIVE EXPANSION）

### 0A 前提审查

| # | 原计划隐含的前提 | 评估 → 处理 |
|---|---|---|
| P1 | 用户从 VS Code 启动服务 | **不成立**（目标用户以 IDEA 为主）→ V1 改为 IDE 无关主路径 |
| P2 | agent 能给过滤器、拦截器、切面、Controller、Service 出 span | 部分成立：agent 默认不出这些 span（2.x 还关了 controller span），但方法清单可以显式列出它们 → V4 改为列出全部 FlowStep 方法，S0 验证 |
| P3 | 只有自采数据 | 不成立 → 加 OTLP 文件导入和测试运行采集；SkyWalking/Arthas 导入推迟 |
| P4 | span 属性名稳定 | 不成立 → 新旧两代 semconv 都认 |
| P5 | MQ 与运行时必须一起做 | 无依赖 → 先做 M1，与 S0 并行 |
| P6 | 没有外部用户反馈也可以规划 v0.2 | 用户已两次明确要求做 v0.2 运行时（U1、2026-10-15）。主审与子代理意见不一致（主审认为可与 v0.1 发布并行），**不构成用户挑战**；闸门处建议用户并行完成 v0.1 发布 |

### 0B 现有代码可复用
- 稳定 ID：`model/ids.ts`。
- 运行时预留字段：`RuntimeStats`、`Provenance: runtime-observed`、`ServiceLinkKind: mq`、`EntrypointKind: mq-consumer`、`FlowLayer: mq`。
- 配置解析：`config/view.ts`（MQ 目的地复用）；`xservice` 出口（MQ 配对复用）。
- 隐私：`llm/redact.ts`、`isExcludedFromAI`。
- 代理：`f6fb4a1` 的代理处理。
- 缺口：`FlowStep` 没有 `observed` 字段；图每次分析都整体重建 → 统计必须存在图之外（V5）。

### 0C 梦想状态
```
  v0.1：静态规则图 + AI 摘要     →   v0.2：静态图 + 运行时对账层（IDE 无关采集、     →   12 个月：任何 trace 来源（含 SkyWalking/Arthas）
  无法证明哪条边真的会走               测试运行采集、文件导入、差异报告、MCP 已验证边）       都能对账；规则精度自动度量；AI 代理只信已验证边
```

### 0C-bis 实现路线

| 路线 | 概要 | 工作量 | 风险 | 结论 |
|---|---|---|---|---|
| A 原计划 | VS Code 终端启动为主路径 + 瀑布图 | L | 中 | 押错启动入口 |
| B 最小 | 只做 CLI + 文件导入 | M | 低 | 编辑器里看不到实时状态 |
| **C 对账层** | IDE 无关主路径 + 便捷启动 + 测试采集 + 文件导入 + 差异报告 | L | 中 | **采用**：和 A 共用同一套接收与对账代码，只换主入口 |

### 0D 扩张候选

| # | 候选 | 裁决 |
|---|---|---|
| X1 | 复制 VM 参数 / `--print-config` | 纳入 |
| X2 | `trace -- mvn test` 测试运行采集 | 纳入 |
| X3 | 静态 vs 实测差异报告 + MCP 字段 | 纳入 |
| X4 | OTLP 文件导入 | 纳入 |
| X5 | SkyWalking 导入 | 推迟，**品味决策 T3** |
| X6 | Arthas 导入 | 推迟，**品味决策 T3** |
| X8 | MQ 真实写法 + 保留集 | 纳入 |

### 0E 时间推演
- **第 1 小时**：接收器放在 core，扩展和 CLI 共用 → V8。
- **第 2–3 小时**：匹配键的规范化 → V4、V5。
- **第 4–5 小时**：重新分析后 ID 变化 → 规范键 + 过期计数。
- **第 6 小时以后**：测试 → 用 S0 黄金夹具驱动单测。

### 各节结论

| 节 | 结论 |
|---|---|
| 1 架构 | 3 处，均已写入 V5、V8；架构图见 Phase 3 |
| 2 错误 | 见第 5 节错误码，无未处理缺口 |
| 3 安全 | 本机端口防护（Host、Origin、token 先于解析）；解码边界；供应链（sha256 每次校验、machine 级路径）；注入（终端 env 字段）；数据最小化 → AC#24★ |
| 4 边界 | 无 span → W033；缺 code.* → 退化为按 route 匹配；畸形请求 → 400；重复 → LRU 去重；时钟偏差 → 只用 span 自身时长 |
| 5 代码质量 | 新增 `core/src/runtime/*` 和 `rules/mq.ts`，不新建抽象层 |
| 6 测试 | 补模糊测试和黄金夹具 |
| 7 性能 | 增量聚合加分位数草图 |
| 8 可观测性 | 独立状态栏项；诊断包 |
| 9 发布 | `atlas.runtime.enabled` 开关；删除 `.atlas/traces/` 即可回滚 |
| 10 长期 | 可逆性 4/5；统一内部 SpanRecord 格式，为以后的导入器留口 |

### CLAUDE SUBAGENT（CEO — 战略独立性）[subagent-only]

| # | 发现 | 级别 | 处理 |
|---|---|---|---|
| ① | 在没有 v0.1 用户反馈时规划 v0.2 | Critical | 见 P6 |
| ② | 启动入口押错 IDE | Critical | 采纳，V1 |
| ③ | AC#19 不可达 | Critical | 采纳，V4 与 AC#19★ |
| ④ | semconv 漂移 | High | 采纳 |
| ⑤ | 排斥 SkyWalking/Arthas 用户 | High | 部分采纳：E072 允许叠加；导入推迟 |
| ⑥ | 替代路线未分析 | High | 采纳，X1–X4 |
| ⑦ | 真正的 10x 是对账而不是瀑布图 | High | 采纳，第 0 节与 X3；瀑布图从简，见 T2 |
| ⑧ | MQ 被运行时拖住，验收循环论证 | Medium | 采纳，M1 先做 + 保留集 |
| ⑨ | protobuf 解码风险 | Medium | 采纳，V2 |
| ⑩⑪ | 竞争风险 | High | 采纳，第 0 节定位 |

```
CEO DUAL VOICES — CONSENSUS TABLE:
═══════════════════════════════════════════════════════════════
  Dimension                           Claude  Codex  Consensus
  ──────────────────────────────────── ─────── ─────── ─────────
  1. Premises valid?                   No      N/A    flagged → 修订 V1/V4
  2. Right problem to solve?           Reframe N/A    flagged → 第 0 节
  3. Scope calibration correct?        No      N/A    flagged → M1 先行 / T1
  4. Alternatives sufficiently explored? No    N/A    fixed（路线 C）
  5. Competitive/market risks covered? No      N/A    fixed（定位）
  6. 6-month trajectory sound?         No      N/A    fixed（X3）
═══════════════════════════════════════════════════════════════
```

### CEO 完成摘要

| 项目 | 结果 |
|---|---|
| 模式 | SELECTIVE EXPANSION |
| 路线 | C |
| 扩张 | 纳入 X1–X4、X8；推迟 X5、X6 |
| 错误路径 | 11 条，0 缺口 |
| 安全威胁 | 6 项，全部有缓解 |
| 可逆性 | 4/5 |
| 完整性 | 6/7 选了完整选项 |

> **Phase 1 complete.** Codex: N/A。Claude 子代理：11 项发现。共识：单一外部声音，关键发现全部标记并处理；无用户挑战。Passing to Phase 2.

## Phase 2 — 设计评审

### 初评与改进

| 项目 | 结果 |
|---|---|
| 初始完整度 | 3/10（原计划的界面只有一行） |
| 修订后 | 8/10 |
| DESIGN.md | 不存在；沿用 spec.md 第 713–860 行的设计规范，只用 `--vscode-*` 主题 token |

### CLAUDE SUBAGENT（设计 — 独立评审）[subagent-only]
9 项发现：
1. 首次 observed 时刻缺少编排（Critical）
2. 缺状态（Critical）
3. 状态栏与现有分析项冲突（High）
4. 瀑布图与泳道的映射未定义（Critical）
5. 边的编码与 v0.1 的线型冲突，缺异步、错误、未走到三种编码（High）
6. MQ 节点的位置和形状未定（High）
7. 启动入口过于笼统（High）
8. Trace 列表层级未说明（Medium）
9. U1 的门槛太薄（Medium）

**全部为结构性问题，按规则自动修复，已写入第 6 节。**

### 设计 litmus 记分卡

| 维度 | 修订前 | 修订后 | 说明 |
|---|---|---|---|
| 1 信息层级 | 3 | 8 | 状态栏 → 等待卡片 → 提示 → 流转图 |
| 2 状态覆盖 | 2 | 8 | 新增矩阵三行 |
| 3 用户旅程 | 3 | 8 | 第一次 observed 的过程 |
| 4 具体性 | 2 | 8 | 线框、编码表 |
| 5 可访问性 | 4 | 7 | 不只靠颜色；减少动态效果；键盘操作沿用 v0.1 |
| 6 一致性 | 5 | 8 | 线型保持原义，新增维度换编码 |
| 7 AI 套路风险 | 4 | 8 | 无通用仪表盘，只放对账信息 |

Codex 列：N/A。

> **Phase 2 complete.** Codex: N/A。Claude 子代理：9 项发现，全部结构性、已修复。Passing to Phase 2.5.

## Phase 2.5 — DX 评审（模式：DX POLISH）

### 开发者旅程（修订后）

| # | 阶段 | 体验 |
|---|---|---|
| 1 | 发现 | README 中「运行时对账」一节 |
| 2 | 安装 | v0.1 扩展里已带 |
| 3 | 第一次使用 | 启动视图的「复制 VM 参数」 |
| 4 | 获取 agent | 进度、换源、校验 |
| 5 | 配置 IDEA | 粘贴一行 VM 参数 |
| 6 | 产生请求 | 等待卡片给出免登录的 curl |
| 7 | 看到结果 | 提示 → 流转图 |
| 8 | 出错 | W033 排查清单 |
| 9 | 进阶 | `trace -- mvn test`、`trace import`、MCP |

### 开发者视角叙事
我在 IDEA 里开着若依。原计划要我去 VS Code 里点「带追踪启动」，可我从不在 VS Code 里跑服务，第一步就卡住了。修订后，我复制一行 VM 参数贴进 IDEA 的运行配置，重启服务，面板提示我 `curl /captchaImage`，几秒后流转图上的边变粗了。唯一不舒服的是第一次要下载 25 MB 的 agent，好在能看到进度，失败了也有阿里云的命令可以复制。

### TTHW（从零到看到第一条 observed）
- 原计划：约 7 步、10 分钟以上，而且 `/system/user/list` 要先登录，30 秒的目标根本达不到。
- 修订后：首次 ≤ 5 分钟（含下载）、之后 ≤ 2 分钟（不含服务启动），已写入 AC-RT-DX★。

### CLAUDE SUBAGENT（DX — 独立评审）[subagent-only]
主要发现：
1. 第一条请求怎么产生没有说明（Critical）
2. IDEA、docker、jar 用户没有路径（Critical）
3. `JAVA_TOOL_OPTIONS` 会插桩 Maven 自身（High）
4. CLI 参数未定义（High）
5. Windows 下 `.cmd` 启动问题（High）
6. 错误码不全（High）
7. 文档缺失（High）
8. V4 与 v1.1 修订矛盾、环境变量长度上限（High）
9. 覆盖优先级、缓存重复下载（Medium）
10. `list_traces` 与 AC#24 冲突（Medium）

全部采纳，写入 V1、V3、V4、V10、第 5 节和下面的清单。

```
DX DUAL VOICES — CONSENSUS TABLE:
═══════════════════════════════════════════════════════════════
  Dimension                           Claude  Codex  Consensus
  ──────────────────────────────────── ─────── ─────── ─────────
  1. Getting started < 5 min?          No→fixed N/A   flagged, fixed
  2. API/CLI naming guessable?         No→fixed N/A   fixed（参数表）
  3. Error messages actionable?        No→fixed N/A   fixed（第 5 节）
  4. Docs findable & complete?         No→fixed N/A   fixed（runtime-tracing.md）
  5. Upgrade path safe?                Yes      N/A   —（叠加层独立、开关可关）
  6. Dev environment friction-free?    No→fixed N/A   fixed（Windows / 中文路径）
═══════════════════════════════════════════════════════════════
```

### DX 记分卡（修订后）

| 维度 | 分数 |
|---|---|
| 上手 | 8 |
| CLI/API 设计 | 8 |
| 错误信息 | 8 |
| 文档 | 7 |
| 逃生口 | 8 |
| 升级 | 8 |
| 环境 | 7 |
| 社区 | 6 |
| **总分** | **7.5**（修订前约 4） |

### DX 实施清单
- **CLI 参数**：`trace` 支持 `--port --agent --agent-url --service --dir --include --exclude --sampler --no-methods --print-config --allow-agent-conflict --json`。每个参数都有对应的 `atlas.runtime.*` 设置，与 `atlas.llm.*` 一致。
- **CLI 子命令**：`trace import <file>`。
- **Windows 启动**：命令解析对 `.cmd` 用 shell 并做转义；Ctrl-C 结束整棵进程树；退出码透传；结束时打印摘要「N spans / M 条流转被观测 → project-atlas show …」。
- **没有分析结果时**：工作区还没有 `.atlas`，`trace` 自动执行一次 `analyze --no-ai`。
- **优先级**：用户自己的 `OTEL_*` 优先（端点和 token 除外）。
- **可覆盖项**：采样器、保留期、启动哪些服务、额外 agent 参数、关闭 JDBC 插桩。
- **方法清单**：`atlas.yaml` 新增 `runtime.methods.include/exclude`，可增删。
- **文档**：
  - `docs/runtime-tracing.md`（中英）：VS Code、CLI、IDEA、`mvn spring-boot:run`、`java -jar` 五种快速开始；离线安装；按症状排查；隐私说明。
  - `trace --help` 带 3 个示例。
  - `errors.md` 加 v0.2 表。
  - README 加一节。

> **Phase 2.5 complete.** DX 总分 7.5/10。TTHW：原计划无法达成 → 首次 5 分钟、之后 2 分钟。Codex: N/A。Claude 子代理：10 项发现。Passing to Phase 3.

## Phase 3 — 工程评审

### Step 0 范围审查（对照实际代码）

| 子问题 | 对应现有代码 | 结论 |
|---|---|---|
| 匹配的键 | `model/ids.ts` 的方法键含参数类型，而 span 的 `code.function` 不含签名 | 规范键必须用 FQN + 方法名，重载有歧义时记为未解析（V4） |
| 统计挂在哪 | `graph/builder.ts` 每次分析都重建图 | 统计不能写进分片图，独立存放（V5） |
| MQ 配对 | `rules/xservice.ts` 的 ServiceLink 出口 | 复用 |
| 规模 | 新增约 12 个文件（runtime 6、mq 1、cli 2、vscode 2、webview 若干） | 超过「8 个文件」阈值，但 R 和 M 是两条独立的线，各自都在阈值内，不缩减（规则：工程阶段不缩减范围） |

### CLAUDE SUBAGENT（工程 — 独立评审）[subagent-only]

| # | 发现 | 级别 | 处理 |
|---|---|---|---|
| 1 | Redis Stream 不传播 trace 上下文，原 AC#22 不可达 | Critical | 采纳，AC#22★ |
| 2 | 父 span 不等于直接调用者，V7 会造假边 | Critical | 采纳，V7 严格条件 + AC#23★ 反例 |
| 3 | 原始 span 淘汰后统计丢失；方法键含签名导致重载问题 | Critical | 采纳，V5、V4 |
| 4 | protobuf 解码的错误假设 | High | 采纳，V2 |
| 5 | V4 与 v1.1 修订矛盾、长度上限 | High | 采纳，配置文件方式 |
| 6 | 突发流量被静默丢弃、导出延迟 | High | 采纳，V9 |
| 7 | `JAVA_TOOL_OPTIONS` 影响所有 JVM、中文路径 | High | 采纳，V1、V3 |
| 8 | token 泄露进 launch.json；窗口重载后接收器失效 | High | 采纳，V1、V8 |
| 9 | 并发写入 | High | 采纳，V8 |
| 10 | semconv 漂移、context-path | High | 采纳 |
| 11 | MyBatis 插桩优先 | Medium | 采纳，V4 |
| 12 | MQ 规则复杂度 | Medium | 采纳，V6 |
| 13 | MCP 与 AC#24 冲突 | Medium | 采纳，V10 |
| 14 | 去重与 unknown_service | Medium | 采纳，V9 |
| 安全 | token 先于解析校验、machine 级路径、每次校验 sha256、原子写、展示命令 | — | 全部采纳 |

```
ENG DUAL VOICES — CONSENSUS TABLE:
═══════════════════════════════════════════════════════════════
  Dimension                           Claude  Codex  Consensus
  ──────────────────────────────────── ─────── ─────── ─────────
  1. Architecture sound?               Yes(*)  N/A    receiver/merge 放 core 正确；统计须独立存放 → fixed
  2. Test coverage sufficient?         No      N/A    flagged → 测试计划补 11 项
  3. Performance risks addressed?      No      N/A    fixed（V9、AC-RT-SOAK）
  4. Security threats covered?         Partly  N/A    fixed（AC#24★）
  5. Error paths handled?              No      N/A    fixed（第 5 节）
  6. Deployment risk manageable?       Yes     N/A    开关 + 独立目录
═══════════════════════════════════════════════════════════════
```

### Section 1 架构图
```
 采集入口                                     packages/core/src/runtime (新)
 ┌─────────────────────┐   OTLP/HTTP pb   ┌─────────────────────────────────────────────────────────┐
 │ IDEA (VM 参数)       │─────────────────▶│ receiver.ts  127.0.0.1:43180 · Host/Origin/token · 4/32MB │
 │ VS Code 终端 (env)   │                  │      │ ack 立即返回                                       │
 │ CLI trace -- cmd    │                  │      ▼                                                    │
 │ mvn test (surefire) │                  │ otlp-decode.ts (wire 0/1/2/5, BigInt, depth≤8)            │
 └─────────────────────┘                  │      ▼                                                    │
 OTLP 文件 ──trace import────────────────▶│ span-record.ts (白名单属性, semconv 新旧代归一)            │
                                          │      ├──▶ store.ts   .atlas/traces/*.jsonl  (保留 7d/100k)  │
                                          │      └──▶ aggregate.ts (worker, 增量) aggregates.json      │
                                          │                │  规范键 → 统计                             │
 静态分析 (v0.1)                           │                ▼                                           │
 analyze ─▶ rules/{spring,mybatis,mq(新)}  │ match.ts  规范键 ⨝ 当前图 → observed / V7 边 / 差异报告     │
        ─▶ xservice ─▶ AtlasGraph ────────▶│ receiver.json 锁 (V8)                                      │
                                          └──────────────┬──────────────────────────────────────────┘
                                                         ▼
                        vscode (状态栏/启动/复制 VM 参数) · webview (Trace/流转/拓扑) · cli (trace/show) · mcp
```

### Section 2 代码质量
- 统一 SpanRecord 内部格式，导入器和接收器共用。
- `rules/mq.ts` 复用 `config/view.ts` 解析目的地，不另写占位符解析（DRY）。
- 启动器检测（java -jar、mvn、gradle）单独一个纯函数，便于单测。

### Section 3 测试图

| 新路径 | 测试类型 | 关键用例 |
|---|---|---|
| 解码 | 单元 + 模糊 | 对照 protobufjs；fixed32 flags；BigInt；深度 9 被拒；gzip 炸弹；截断 varint |
| 接收器 | 集成 | 非本机地址连接失败；Origin、Host、token 拒绝；token 先于解压校验；并发两个实例 |
| 存储 | 单元 | 追加整行；最后一行不完整可读；按段淘汰；EBUSY 重试 |
| 聚合 | 单元 + 耐久 | 淘汰后统计仍在；分位数误差；1 小时 200 span/s |
| 对账 | 单元（黄金夹具） | code.* 新旧代；CGLIB；context-path；重载歧义；MyBatis 与 JDBC 归属；PageHelper |
| V7 | 单元 | 反射调用 → 新增边；中间未插桩帧 → 不建边；@Async → 标异步 |
| 跨服务 | E2E | Kafka KRaft 印证；Redis Stream 按 key 印证 |
| MQ 规则 | 单元 | 五类 × 常量、占位符、通配、`topic:tag`、`topicPattern`、SpEL 未解析 |
| agent 获取 | 单元 + 集成 | 换源；sha 不符（HTML 页面）；原子改名；中文路径复制 |
| CLI | 集成 | `mvn.cmd`、Ctrl-C 进程树、退出码、无 `.atlas` 时自动分析、`--print-config` |
| VS Code | E2E | 复制 VM 参数；终端 env 注入；受限模式禁用；窗口重载后提示重新启动 |
| MCP | 单元 | 输出不含属性值；`list_traces` 参数 |
| 界面 | 组件测试 | 状态矩阵每一行；两种模式；图例 |

测试计划产物：`~/.gstack/projects/project-atlas/admin-feat-v0.2-test-plan-20261015.md`

### Section 4 性能
- 单条请求约 15 span；200 span/s 时增量聚合约 1 ms/批。
- 慢路径：①首次加载 10 万 span 的 JSONL（只建偏移索引，< 1 s）；②拓扑重新布局（沿用 Web Worker）。

### NOT in scope（v0.2）
- SkyWalking/Arthas 导入、docker 内服务（`--listen`）、浏览器 span → TODOS
- Python/Go 运行时、gRPC/Dubbo → 后续版本
- 动画回放、规则精度自动报表、性能剖析

### What already exists
见 Phase 1 的 0B 与 Phase 3 的 Step 0。

### 失败模式登记表

| 代码路径 | 失败模式 | 已处理 | 有测试 | 用户可见 | 有日志 |
|---|---|---|---|---|---|
| 接收器 | 扩展重载后应用仍在导出 | 是（固定端口/token + 提示重启） | 计划中 | 是 | 是 |
| 解码 | 静默误解析 | 是（模糊测试） | 计划中 | — | 是 |
| 对账 | 假边 | 是（V7） | 计划中 | 是 | — |
| 对账 | 重载歧义 | 是（未解析） | 计划中 | 是 | — |
| 聚合 | 淘汰后丢统计 | 是（独立聚合） | 计划中 | 是 | — |
| exporter | 队列溢出丢 span | 是（V9） | 耐久测试 | 是（丢弃计数） | 是 |
| 启动 | Maven JVM 被插桩 | 是（V1） | 计划中 | — | — |
| 启动 | 中文路径 | 是（V3） | AC-RT-WIN | 是 | 是 |

无关键缺口。

### 工程完成摘要

| 项目 | 结果 |
|---|---|
| 范围 | 不缩减 |
| 子代理发现 | 14 项 + 安全 5 项，全部采纳 |
| 测试图 | 13 条路径，全部有对应测试 |
| 关键缺口 | 0 |

> **Phase 3 complete.** Codex: N/A。Claude 子代理：19 项发现。共识：单一外部声音，全部处理。Passing to Phase 4.

## 跨阶段主题

| 主题 | 出现的阶段 | 信号 |
|---|---|---|
| IDEA 用户没有路径 | CEO、DX | 高置信 |
| 第一条请求怎么产生 | 设计、DX | 高置信 |
| semconv 漂移和 controller span 默认关闭 | CEO、工程 | 高置信 |
| 方法清单不该放环境变量 | DX、工程 | 高置信 |
| `JAVA_TOOL_OPTIONS` 影响构建工具 JVM | DX、工程 | 高置信 |
| MCP 与 AC#24 冲突 | DX、工程 | 高置信 |
| MQ 规则需要真实写法和保留集 | CEO、工程 | 高置信 |

## 品味决策（最终闸门）

- **T1 MQ 发布顺序**：推荐「同一分支先做 M1，发布标签等远程仓库建好后再定」。替代方案：把 M1 单独作为 v0.1.1 先发布（需要先有远程仓库）。
- **T2 瀑布图**：推荐「保留简洁瀑布图」，它是进入单条 trace 模式的入口。替代方案：按 CEO 子代理建议完全删掉，只保留列表和差异报告，能省约半天，但单条 trace 模式就没有入口了。
- **T3 SkyWalking / Arthas 导入**：推荐「推迟到 TODOS」。替代方案：v0.2 就做 SkyWalking 导入（约 1 天，需要一个在跑的 SkyWalking 才能验证）。

## Decision Audit Trail
<!-- AUTONOMOUS DECISION LOG -->

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|---|---|---|---|---|---|
| 1 | CEO | 模式 SELECTIVE EXPANSION | Mechanical | 上下文默认 | 在现有系统上迭代 | EXPANSION |
| 2 | CEO | 路线 C（对账层） | Mechanical | P1 | 覆盖 A 的全部能力，入口正确 | A、B |
| 3 | CEO | V1 主路径改为 IDE 无关 | Mechanical | P1 | 目标用户以 IDEA 为主 | 终端为主 |
| 4 | CEO | 纳入 X1–X4、X8 | Mechanical | P2 | 在爆炸半径内，都小于 1 天 | — |
| 5 | CEO | X5、X6 推迟 | Taste(T3) | P3 | 新外部依赖，超过 1 天 | 现在做 |
| 6 | CEO | P6 不作为用户挑战 | Mechanical | 规则 | 两个声音不一致，用户方向明确 | 暂停 v0.2 |
| 7 | CEO | E072 改为允许叠加 | Mechanical | P1 | 不把 SkyWalking 用户拒之门外 | 拒绝 |
| 8 | CEO | MQ 先做 | Taste(T1) | P6 | 无依赖、低风险 | 捆绑在 S0 之后 |
| 9 | Design | 补齐状态矩阵、编码、两种模式、线框 | Mechanical | P5+P1 | 结构性缺失，自动修复 | — |
| 10 | Design | 独立的追踪状态栏项 | Mechanical | P5 | 避免与分析项冲突 | 共用一个 |
| 11 | Design | 保留简洁瀑布图 | Taste(T2) | P1 | 单条 trace 模式需要入口 | 删除 |
| 12 | DX | 按启动器注入 | Mechanical | P1 | 避免插桩 Maven JVM | 统一用 JAVA_TOOL_OPTIONS |
| 13 | DX | 方法清单写进配置文件 | Mechanical | P5 | 避开长度上限；与 v1.1 修订一致 | 环境变量 |
| 14 | DX | 错误码 E070–E074、W030–W035 | Mechanical | P1 | 每条都给出问题、原因、修复 | — |
| 15 | DX | docker 在 v0.2 不支持并写明 | Mechanical | P3 | 保持只听 127.0.0.1 的安全边界 | `--listen` |
| 16 | DX | CLI 与扩展共用 agent 缓存 | Mechanical | P4 | 避免重复下载 | 各自缓存 |
| 17 | Eng | AC#22 改为 Kafka KRaft + Redis 按 key 印证 | Mechanical | P1 | 原 AC 在本机不可达 | — |
| 18 | Eng | V7 严格条件 | Mechanical | 宁缺勿错 | 父 span 不等于直接调用者 | 宽松建边 |
| 19 | Eng | 聚合与原始 span 分离存储 | Mechanical | P1 | 淘汰后统计不丢 | 每次从原始 span 重算 |
| 20 | Eng | 解码器规格（V2） | Mechanical | P1 | 堵住 DoS 与误解析 | — |
| 21 | Eng | V8 单例锁 + 固定端口和 token | Mechanical | P5 | 并发写入与窗口重载 | — |
| 22 | Eng | V9 BSP 调参与有界去重 | Mechanical | P1 | 突发流量不静默丢失 | — |
| 23 | Eng | V10 MCP 只返回聚合值 | Mechanical | P1 | 与 AC#24 一致 | 返回属性 |
| 24 | Eng | 工程阶段不缩减范围 | Mechanical | 规则 | — | — |
