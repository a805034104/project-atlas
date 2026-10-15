# [Epic] ProjectAtlas — VS Code 扩展：AI 项目地图（模块 / 功能 / 启动 / 修改记录 / 请求流转）

> v1 · 2026-10-15 · 状态：已确认
> 名称 `ProjectAtlas`，MIT 许可。

## Context

开发者接手一个陌生项目（或回看自己半年前的项目）时，要花数小时到数天才能搞清：项目分几个模块、核心功能是什么、怎么启动、哪些模块最近改得最多、一个请求从进入到落库经过了哪些层。现有工具要么只画依赖图（不懂业务），要么纯靠 AI 读代码（会编造调用链）。

ProjectAtlas 是开源 VS Code 扩展：打开一个工作区 → 一键分析 → 在 Webview 里看到项目地图。确定性的部分（模块、路由、调用链、git 历史）用静态分析算出来，AI 只负责归纳业务含义和补全静态分析看不到的边，并且在图上明确标注哪些是 AI 推断的。

用户：开源社区开发者，覆盖 Java Spring / Vue / Go / Python 四种技术栈。

## 已锁定的决策

| # | 决策 | 结论 |
|---|------|------|
| D1 | 形态 | VS Code 扩展（Webview 面板），分析引擎独立成 npm 包，以后可以复用为 CLI |
| D2 | 技术栈 | Java Spring/RuoYi、Python、Go、Vue |
| D3 | 定位 | 开源，MIT 许可，发布到 VS Code Marketplace + Open VSX |
| D5 | LLM | 用户自带 Key：Anthropic、OpenAI 兼容接口（DeepSeek/通义/Moonshot 等）、本地 Ollama |
| D6 | 流转数据来源 | tree-sitter 静态分析 + 框架规则（确定边，实线）；AI 补全（推断边，虚线，带置信度） |
| D7 | 首版范围 | **四种栈全部做精确流转规则后才发布 v0.1** |
| D8 | 修改记录 | 按模块聚合 git 时间线 + 热力图 + AI 演进摘要 |
| D9 | 运行时追踪 | **v0.1 纳入**。只做本地：扩展内置 OTLP 接收器（仅绑定 127.0.0.1），在 VS Code 里「带追踪启动」本地服务；不接 Jaeger/Zipkin/SkyWalking |
| D10 | Go 运行时 | 生成 otelhttp/otelgin/otelgorm 等中间件接入的代码 diff，用户审阅确认后才写入；不做 eBPF |
| D11 | 跨服务链路 | **v0.1 纳入**全部四类：HTTP + 网关 + 注册中心、消息队列（Kafka/RabbitMQ/RocketMQ/Redis Stream）、RPC（gRPC/Dubbo）、前端 → 网关 → 服务 |
| D12 | 多仓库导入 | VS Code 多根工作区 + 可选 `atlas.yaml`（声明本机路径或 git 地址，按声明浅克隆） |

## 架构

```
packages/
  core/      分析引擎（纯 Node，不依赖 vscode API）
    ingest/     文件遍历、忽略规则、语言识别、web-tree-sitter(WASM) 解析、符号索引
    detect/     模块识别、启动方式识别（确定性）
    flow/       入口点 + 调用图 + 框架规则插件（spring / vue / go / python）
    services/   服务身份识别 + 配置解析（yml/properties/.env/docker-compose/Nacos 导出）
    xservice/   跨服务连线规则（http / gateway / registry / mq / rpc / frontend-proxy）
    runtime/    OTLP/HTTP 接收器（protobuf + JSON）、trace 存储、span → FlowStep 合并
    git/        git log --numstat 解析、文件→模块映射
    llm/        provider 适配、token 预估、脱敏、map-reduce 摘要、内容哈希缓存
    model.ts    AtlasGraph 数据模型（见下）
  vscode/    扩展宿主：命令、SecretStorage、进度、打开源码定位、「带追踪启动」（生成 launch/task 配置、注入环境变量）、Go 中间件 diff 预览
  webview/   React + @xyflow/react + elkjs 布局；中英双语 UI
fixtures/    验收用的仓库清单（git submodule，固定 commit）
```

选择 web-tree-sitter（WASM）而不是 native 绑定：扩展要在 Win/macOS/Linux 都能直接安装，native 模块要针对每个平台和 Electron ABI 单独编译。

缓存：`<workspace>/.atlas/`（自动写入 `.atlas/.gitignore`），以文件内容 sha256 为 key；改动 1 个文件只会重算这个文件和它上游的摘要链。

## 数据模型（core/model.ts）

```ts
interface AtlasGraph {
  schemaVersion: 1;
  project: { name: string; roots: string[]; stacks: Stack[]; analyzedAt: string /* UTC ISO */ };
  services: Service[];
  serviceLinks: ServiceLink[];
  modules: Module[];
  features: Feature[];
  startup: StartupGuide[];
  entrypoints: Entrypoint[];
  flows: Flow[];
  history: ModuleHistory[];
  llmUsage: { provider: string; model: string; inputTokens: number; outputTokens: number };
}
type Stack = 'java-spring' | 'vue' | 'go' | 'python';
interface Service {
  id: string;
  name: string;                                       // spring.application.name / atlas.yaml / docker-compose service 名 / 目录名（按此优先级）
  root: string; gitHead?: string;
  stack: Stack;
  kind: 'backend' | 'gateway' | 'frontend' | 'worker';
  evidence: SourceRef;
}
interface ServiceLink {
  id: string;
  fromServiceId: string; toServiceId: string;
  kind: 'http' | 'gateway-route' | 'mq' | 'grpc' | 'dubbo' | 'frontend-proxy';
  channel: string;                                    // 例如 "GET /user/info/{username}"、"topic:order-created"、"stream:orders:created"、"grpc:pkg.UserService/Get"
  fromStepId: string; toEntrypointId?: string;        // 连到具体调用点和对端入口
  provenance: Provenance; confidence: number;
  evidence: SourceRef[];
}
type Provenance = 'static' | 'framework-rule' | 'ai-inferred' | 'runtime-observed';
interface Module {
  id: string; serviceId: string; name: string; path: string;   // 相对 service root
  kind: 'build-module' | 'package' | 'frontend-app' | 'ai-grouped';
  summary?: string;                                   // AI
  dependsOn: string[];                                // module ids，来自 import/构建依赖
  fileCount: number; loc: number;
}
interface Feature {
  id: string; title: string; description: string;
  tier: 'core' | 'secondary';                         // 主体功能 / 其余功能
  moduleIds: string[]; entrypointIds: string[];        // 证据，必须非空
}
interface StartupGuide {
  target: string;                                     // 例如 "backend" / "ruoyi-ui"
  prerequisites: { name: string; version?: string; evidence: SourceRef }[];  // JDK17、MySQL、Redis…
  steps: { command: string; cwd: string; evidence: SourceRef }[];            // 每条命令必须能在仓库文件中找到出处
  ports: { port: number; evidence: SourceRef }[];
  configFiles: SourceRef[];
}
interface Entrypoint {
  id: string;
  kind: 'http' | 'mq-consumer' | 'scheduled' | 'cli-main' | 'frontend-route' | 'websocket';
  method?: string; path?: string;                     // http
  handler: SymbolRef;
}
interface Flow { entrypointId: string; steps: FlowStep[]; edges: FlowEdge[] }
interface FlowStep {
  id: string;
  layer: 'frontend' | 'filter' | 'interceptor' | 'middleware' | 'aspect' | 'controller'
       | 'service' | 'repository' | 'sql' | 'external-http' | 'mq' | 'cache';
  symbol: SymbolRef;
}
interface FlowEdge {
  from: string; to: string; order: number;
  provenance: Provenance;                             // 被运行时 span 证实的静态边保留原 provenance，另设 observed
  confidence: number;                                 // static/rule/runtime = 1；AI 推断 0–1
  rationale?: string;                                 // AI 推断边必填
  observed?: RuntimeStats;                            // 运行时数据叠加
}
interface RuntimeStats { count: number; p50Ms: number; p95Ms: number; errorCount: number; lastSeen: string /* UTC */; sampleTraceIds: string[] }
interface ModuleHistory {
  moduleId: string;
  commits: { sha: string; authorTime: string /* UTC */; author: string; message: string; added: number; deleted: number; files: string[] }[];
  aiSummary?: string;                                 // 最近 50 次提交归纳的演进阶段
}
interface SymbolRef { file: string; line: number; name: string }
interface SourceRef { file: string; line?: number }
```

## 框架规则（四栈都要精确）

| 栈 | 入口 | 中间层 | 业务层 → 数据层 |
|----|------|--------|-----------------|
| Java Spring | `@RestController/@Controller` + `@{Get,Post,Put,Delete,Patch,Request}Mapping`（拼接类级前缀）；`@Scheduled`；`@RabbitListener/@KafkaListener` | `Filter`/`OncePerRequestFilter`（含 Spring Security `addFilterBefore` 顺序）、`HandlerInterceptor`（在 `WebMvcConfigurer.addInterceptors` 中注册，包括 `addPathPatterns/excludePathPatterns`）、`@Aspect` 切点匹配 | 字段注入、构造器注入和 `@Resource` 解析接口 → 唯一实现类；MyBatis Mapper 接口 → XML `<select id>`；MyBatis-Plus `BaseMapper`；`@FeignClient`；`RestTemplate`/`WebClient` |
| Vue | Vue Router 静态路由；RuoYi 风格动态路由（后端菜单返回 `component` 字符串）→ 解析 `views/**` 下的同名组件，标记为 framework-rule | — | 页面 import 的 `src/api/*.js` 函数 → `request({url, method})` / `axios.get` → 匹配后端 Entrypoint（路径参数归一化 + baseURL 前缀） |
| Go | `net/http` `HandleFunc`；gin、echo、chi 的路由组和前缀 | `Use()` 中间件链（含 group 级）| 静态调用图（tree-sitter + 包内符号解析，接口调用解析为唯一实现，多个实现时拆成多条分支）；gorm / `database/sql` / sqlx / go-redis 调用识别 |
| Python | FastAPI（`APIRouter` 前缀、`Depends`）、Flask（Blueprint、`before_request`）、Django（`urls.py` include、settings `MIDDLEWARE`）；非 HTTP 入口：`if __name__ == "__main__"`、`asyncio.run`、Redis Stream `xreadgroup` 循环、Celery task、APScheduler | FastAPI/Starlette middleware、Flask hooks、Django middleware 顺序 | import 解析 + 调用图；SQLAlchemy / Django ORM / redis / httpx / requests 识别 |

静态分析解析不了的情况（反射、动态 import、字符串拼出的 URL）交给 AI，AI 只能产出 `ai-inferred` 边，并且 `rationale` 必填。

## 跨服务连线规则

先识别服务身份，再解析配置：`${...}` 占位符按 `application.yml` → `application-{profile}.yml` → `bootstrap.yml` → `.env` → `docker-compose` environment 的顺序展开；Nacos 配置从仓库内导出的 yml 或 `config_info` SQL dump 读取（RuoYi-Cloud 就把配置放在 `sql/ry_config_*.sql`）。

| 类型 | 调用方识别 | 被调方识别 | 配对键 |
|------|-----------|-----------|--------|
| HTTP + 注册中心 | `@FeignClient(name/value/url/path)`；`@LoadBalanced` RestTemplate / WebClient 的 `http://<service-name>/...`；Go `net/http`、resty；Python requests、httpx（base URL 来自配置） | 对端服务的 HTTP Entrypoint | 服务名（Nacos/Eureka 即 `spring.application.name`）+ 方法 + 归一化路径 |
| 网关 | — | Spring Cloud Gateway 路由（yml/Nacos：`Path` 断言、`StripPrefix`、`RewritePath`、`lb://`）；Nginx `location` + `proxy_pass` | 网关对路径改写后，按上一行规则配对 |
| 前端 → 网关 → 服务 | Vue `src/api` 请求 + `VITE_APP_BASE_API`/`VUE_APP_BASE_API` + `vite.config`/`vue.config` dev proxy | 经网关改写后的服务入口 | 完整路径链（浏览器路径 → 代理 → 网关 → 服务路径） |
| Kafka | `KafkaTemplate.send`、sarama/kafka-go、kafka-python/aiokafka producer | `@KafkaListener(topics)`、Go/Python consumer | topic（常量和配置解析后的值） |
| RabbitMQ | `RabbitTemplate.convertAndSend(exchange, routingKey)`、amqp091-go、pika/aio-pika | `@RabbitListener(queues)` + binding 配置 | exchange + routingKey → binding → queue |
| RocketMQ | `RocketMQTemplate.send/syncSend` | `@RocketMQMessageListener(topic, selectorExpression)` | topic + tag |
| Redis Stream | `XADD`（Jedis/Lettuce/RedisTemplate `opsForStream().add`、go-redis、redis-py `xadd`） | `XREADGROUP`/`XREAD`、`StreamMessageListenerContainer` | stream key（常量和配置解析后的值） |
| gRPC | 生成的 `*Stub` / `New*Client` 调用 | `Register*Server`、`*ImplBase` 子类、`add_*Servicer_to_server` | `.proto` 中的 `package.Service/Method` |
| Dubbo | `@DubboReference` / `@Reference` 字段调用 | `@DubboService` / `@Service(dubbo)` 实现类 | 接口全限定名 + group + version |

topic、stream 或服务名在解析常量和配置后仍不确定时，不连线，只生成 `ai-inferred` 候选边。

## 运行时追踪（仅本地）

- **接收器**：扩展激活后按需启动 OTLP/HTTP 接收器，绑定 `127.0.0.1:4318`（端口被占用时自动换一个，并把实际端口注入启动配置）。只监听本机，不开放到局域网。
- **「带追踪启动」**：对每个服务的 StartupGuide 生成 VS Code launch/task 配置（写入 `.vscode/launch.json` 前展示 diff，用户确认后才写）：
  - Java：下载固定版本的 `opentelemetry-javaagent.jar` 到扩展 globalStorage，并校验 sha256。通过 `JAVA_TOOL_OPTIONS=-javaagent:...` 注入，同时设置 `OTEL_SERVICE_NAME`、`OTEL_EXPORTER_OTLP_ENDPOINT`、`OTEL_TRACES_SAMPLER=always_on`。另外根据静态分析得到的 Service/Mapper 类生成 `OTEL_INSTRUMENTATION_METHODS_INCLUDE`，这样业务层方法也会产生 span。
  - Python：检测项目 venv，经用户确认后安装固定版本的 `opentelemetry-distro` + `opentelemetry-exporter-otlp`，然后用 `opentelemetry-instrument` 包装启动命令。
  - Go：生成 otelhttp / otelgin / otelecho / otelchi / otelgorm / redisotel 的接入 diff 和 `go.mod` 变更，用户审阅后应用；另提供「一键撤销」，还原成应用前的文件。
  - Vue：前端不采集浏览器 span。前端到后端的连线靠静态规则，再用后端 span 的 `http.route` 印证。
- **合并**：span 按 `code.namespace` + `code.function`、`http.route` + method、`db.statement`、`messaging.destination.name`、`rpc.service/method` 匹配到 FlowStep。匹配上的静态边叠加 `observed` 统计；运行时才出现、静态分析没发现的调用新增为 `runtime-observed` 边。跨服务的 span 通过 traceparent 父子关系，自动生成或印证 ServiceLink。
- **存储与隐私**：trace 存在 `.atlas/traces/`（SQLite），默认保留 7 天或 10 万个 span，以先到者为准。span 属性（SQL 参数、请求体、header）**永不发送给 LLM**；AI 最多只能看到聚合后的调用结构和计数。

## AI 分析流程

1. 确定性阶段（不联网）：解析、模块、入口、流转、启动方式证据、git。
2. 预估本次要发送的 token 和费用（按 provider 价格表，Ollama 记为 0）→ **用户确认后**再发送。
3. Map：逐文件生成摘要（按内容哈希缓存）→ Reduce：模块摘要 → 项目级功能清单（core/secondary，每条必须引用 module/entrypoint 证据）。
4. 启动指南：AI 根据证据文件写成步骤，**每条命令都要回查仓库，原文中找不到的命令一律丢弃**。
5. 模块演进摘要：每个模块最近 50 次提交（只发 message + 文件列表 + numstat，不发 diff）。
6. 发送前脱敏：默认排除 `.env*`、`*.pem`、`*.key`、`application-*.yml` 中的 password/secret/token 字段值、高熵字符串；`.atlasignore` 支持自定义规则。
7. 单次分析设 token 上限（默认 2M input，可配置），超过上限就停下来询问。

## Webview 视图

0. 服务拓扑：服务节点 + ServiceLink（按 http/mq/grpc/dubbo/gateway 分色，MQ 的 topic 显示为中间节点）；运行时有数据时，边上显示 QPS 和 p95 延迟。
1. 总览：技术栈、服务数、模块数、入口数、主体功能卡片、AI 用量。
2. 模块图：模块节点 + 依赖边，节点颜色 = 近 90 天改动热度；点击查看摘要和文件。
3. 功能清单：主体 / 其余两栏，点击跳到相关模块和入口。
4. 启动方式：分 target 列出前置依赖、命令（可一键复制）、端口、配置文件。
5. 修改记录：模块 × 时间热力图 + 选中模块的提交时间线 + AI 演进摘要；时间按用户本地时区显示，存储一律用 UTC。
6. 请求流转：先选入口（可搜索 `GET /system/user/list`）→ 泳道图（前端 → 过滤器 → 拦截器 → 切面 → 控制器 → 服务 → Mapper → SQL）；实线 = 确定边，虚线 = AI 推断边（悬停显示依据和置信度），运行时证实的边加粗并标出延迟，仅运行时才出现的边用独立颜色；遇到跨服务调用时，泳道会延伸到对端服务（例如 网关 → system 服务 → Feign → auth 服务，或 producer → topic → consumer）；任意节点点击即可打开源码对应行。
7. Trace 列表：本地收到的最近 trace，点进去看瀑布图，并可一键跳到对应的流转图。

## 验收夹具（固定 commit）

| 栈 | 仓库 | 用途 |
|----|------|------|
| Java + Vue | `yangzongzhuan/RuoYi-Vue`（固定 commit；6 个 Maven 模块 + ruoyi-ui，约 36 个 Controller、约 219 个方法级 Mapping 注解，确切数字在固定 commit 后由参考脚本生成） | 主验收 |
| Go + Vue | `flipped-aurora/gin-vue-admin` | gin + gorm + 前端联动 |
| Python FastAPI | `fastapi/full-stack-fastapi-template` | |
| Python Flask | `miguelgrinberg/microblog` | |
| Python Django | `gothinkster/django-realworld-example-app` | |
| Python 非 HTTP | `fixtures/synthetic/python-worker`（主循环 + Redis Stream 消费 + APScheduler） | 非 HTTP 入口 |
| 微服务 Java + Vue | `yangzongzhuan/RuoYi-Cloud` | Gateway + Nacos + Feign + 前端代理，跨服务主验收 |
| 跨语言跨服务 | `fixtures/synthetic/polyglot-stream`：Python 生产者 → Redis Stream → Spring 消费者 → Vue 前端 | 跨语言多根工作区 |
| 私有本地夹具（可选） | 在 `fixtures/local.yaml`（已 gitignore）中声明本机仓库路径和预期结果，只在本机运行，不进 CI | 维护者用真实私有项目回归 |
| MQ / RPC 合成夹具 | `fixtures/synthetic/{kafka,rabbitmq,rocketmq,redis-stream,grpc,dubbo}`：每个目录 2–3 个服务，混合 Java/Go/Python，由本项目自己编写，带 docker-compose | 精确覆盖每种 MQ/RPC 的生产和消费配对，也用于运行时 E2E |

每个夹具都有一份手工核对的 `expected.json`（入口清单 + 20 条随机抽样的完整流转），作为黄金标准。

## Acceptance Criteria

1. RuoYi-Vue：识别出 7 个顶层模块（6 个 Maven module + ruoyi-ui），模块依赖边与 pom.xml 中的 `<dependency>` 一致。
2. 各夹具的 HTTP 入口召回率 100%、精确率 ≥ 98%（对照 expected.json）。RuoYi 的方法级端点数与参考脚本 grep 统计一致。
3. 各夹具抽样 20 条流转：确定性边（static/framework-rule）逐条与人工核对一致的 ≥ 19 条；RuoYi 的 `GET /system/user/list` 必须按以下顺序包含：`JwtAuthenticationTokenFilter` → `RepeatSubmitInterceptor`（`ResourcesConfig.java:48` 注册在 `/**`）→ `@PreAuthorize("@ss.hasPermi('system:user:list')")` 权限校验 → `SysUserController.list`（`SysUserController.java:61`）→ `ISysUserService.selectUserList` 解析到 `SysUserServiceImpl.selectUserList`（`:78`）→ `@DataScope` 切面（包裹在该 Service 方法外层）→ `SysUserMapper.selectUserList` → `SysUserMapper.xml` 中 `<select id="selectUserList">`。
4. RuoYi-ui 与 gin-vue-admin 前端的 `src/api` 请求函数，≥ 95% 能匹配到后端入口。
5. 每个夹具的启动指南中，每一条命令都能在仓库文件里找到 `evidence`；伪造命令数 = 0（自动校验）。
6. 每个模块的提交数与 `git log --oneline -- <module path> | wc -l` 完全一致。
7. 确定性阶段（不调用 LLM）：RuoYi-Vue 在 4 核笔记本上 < 30 s；内存峰值 < 1 GB。
8. 增量：修改 1 个 Java 文件后重新分析，发送的 token ≤ 首次全量的 5%。
9. 隐私：未配置 Key 或用户未确认时，网络请求数 = 0（集成测试 mock fetch 断言）；含 `.env` 和假密钥的夹具，发出的 payload 中不包含该密钥字符串。
10. 每个 AI 功能条目都至少引用 1 个 module 或 entrypoint；没有引用的条目会被丢弃。
11. Webview 渲染 500 节点模块图时，拖拽和缩放不出现超过 200 ms 的卡顿。
12. CI（GitHub Actions）在 windows-latest / macos-latest / ubuntu-latest 上全绿；`.vsix` 能在这三个平台安装运行。
13. 三个 provider（Anthropic / OpenAI 兼容 / Ollama）各跑通一次 RuoYi 全量分析（E2E，手动 + 录屏）。

**跨服务**

14. RuoYi-Cloud：识别出的服务清单和服务名与 expected.json 一致；所有 `@FeignClient` 调用 100% 连到对端服务的具体入口。
15. RuoYi-Cloud 的 ruoyi-ui `src/api` 请求，≥ 95% 能经过 dev proxy、网关 `Path` + `StripPrefix` 解析到具体服务入口。
16. 合成夹具：Kafka、RabbitMQ、RocketMQ、Redis Stream、gRPC、Dubbo 的生产和消费（或调用和实现）配对召回率 100%、误配 0 条；需要经过常量和配置占位符解析的用例单独覆盖。
17. `polyglot-stream` 多根工作区：识别出 Python `XADD` 与 Spring Stream 消费端之间的 Redis Stream 链路（stream key 经常量和配置解析后一致），并连到 Vue 前端的查询入口。
18. 多根工作区与 `atlas.yaml`（本机路径 + git 地址各一个）导入的结果一致；git 地址只做浅克隆（`--depth`），克隆失败时给出明确错误，不会中断其余服务的分析。

**运行时追踪**

19. RuoYi-Vue「带追踪启动」后，请求一次 `GET /system/user/list`：AC#3 中列出的每一步在 10 秒内都显示 observed（含耗时）；javaagent 下载经 sha256 校验。
20. FastAPI 夹具（opentelemetry-instrument）和 gin-vue-admin（应用中间件 diff 后）同样能把一次请求的 span 合并到对应流转上，覆盖 controller/handler、service、DB 三层。
21. Go diff 应用后可一键撤销，撤销后 `git diff` 为空。
22. 合成夹具 docker-compose 跑起来后，跨服务 trace 能自动生成或印证 ServiceLink（provenance 含 runtime-observed）。
23. 运行时出现、静态分析未覆盖的调用，以 `runtime-observed` 边单独显示（用一个故意用反射调用的合成用例来验证）。
24. 接收器只监听 127.0.0.1（集成测试从非 loopback 地址连接必须失败）；发给 LLM 的 payload 中不出现任何 span 属性值（mock 断言）。
25. 1 万个 span 合并到流转图耗时 < 2 s；超出保留上限后自动清理。

## Testing Plan

| 层 | 内容 | 数量 |
|----|------|------|
| Unit | 每条框架规则（路由前缀拼接、拦截器路径匹配、DI 解析、Mapper XML 映射、gin group、FastAPI Depends、Django include…） | +80 |
| Unit | 脱敏、token 预估、缓存失效、git numstat 解析（含 rename、merge） | +25 |
| Integration | 每个夹具全量确定性分析 vs expected.json | +6 |
| Integration | LLM 层用录制回放（不真实调用）验证 map-reduce 和证据校验 | +8 |
| Unit | 跨服务规则（Feign、网关改写、dev proxy、各 MQ 配对、gRPC/Dubbo、占位符解析） | +60 |
| Unit | OTLP 解码（protobuf/JSON）、span → FlowStep 匹配、保留策略 | +20 |
| Integration | RuoYi-Cloud + 6 个合成夹具的跨服务连线 vs expected.json | +7 |
| Integration | 运行时：Java agent / Python instrument / Go diff 三条链路，在 docker 中起服务、发请求、断言合并结果 | +6 |
| E2E | @vscode/test-electron：打开 RuoYi → 运行命令 → Webview 出现 6 个视图 → 点击节点跳转源码 | +4 |

## Child Issues

| # | 标题 | 优先级 | 依赖 | 工作量（human / CC） |
|---|------|--------|------|------|
| 1 | Monorepo 脚手架 + AtlasGraph 模型 + 缓存 | Critical | — | 3d / 2h |
| 2 | Ingest：遍历、忽略、tree-sitter WASM、符号索引 | Critical | 1 | 5d / 4h |
| 3 | 模块 + 启动方式确定性识别（四栈） | High | 2 | 5d / 4h |
| 4 | LLM 层：3 个 provider、SecretStorage、预估确认、脱敏、map-reduce、哈希缓存 | Critical | 1 | 6d / 5h |
| 5 | 功能分析（core/secondary + 证据校验）+ 启动指南命令回查 | High | 3,4 | 3d / 3h |
| 6 | Git 模块历史 + 热力图数据 + AI 演进摘要 | High | 3,4 | 3d / 3h |
| 7 | Flow 引擎通用层：入口模型、调用图、AI 补边 | Critical | 2,4 | 6d / 5h |
| 8 | Spring 规则 | Critical | 7 | 6d / 5h |
| 9 | Vue 规则 + 前后端连线 | High | 7,8 | 4d / 3h |
| 10 | Go 规则（net/http、gin、echo、chi） | High | 7 | 6d / 5h |
| 11 | Python 规则（FastAPI、Flask、Django、非 HTTP 入口） | High | 7 | 8d / 6h |
| 12 | Webview 8 个视图（含服务拓扑、Trace 列表）+ 源码跳转 + 中英 i18n | High | 1（mock 数据可并行） | 11d / 8h |
| 13 | 夹具 expected.json + 合成 MQ/RPC 夹具 + CI 三平台 + 打包发布 + README | High | 全部 | 7d / 5h |
| 14 | 服务身份识别 + 配置解析（占位符、profile、.env、docker-compose、Nacos 导出）+ 多根工作区 / atlas.yaml | Critical | 2 | 5d / 4h |
| 15 | 跨服务：HTTP + 注册中心 + 网关 + 前端代理 | Critical | 8,9,14 | 6d / 5h |
| 16 | 跨服务：Kafka / RabbitMQ / RocketMQ / Redis Stream + gRPC / Dubbo | High | 7,14 | 7d / 5h |
| 17 | OTLP 接收器 + trace 存储（SQLite）+ 保留策略 | High | 1 | 4d / 3h |
| 18 | 带追踪启动：Java agent / Python instrument / Go 中间件 diff（含撤销） | High | 3,17 | 6d / 5h |
| 19 | span ↔ 静态流转合并 + runtime-observed 边 + 运行时印证 ServiceLink | High | 7,15,16,17 | 4d / 3h |

合计约 human 18 周 / CC 11–14 天（比上一版多约 8 周 / 5–6 天）。

## Dependency Graph

```
#1 ─┬─> #2 ─┬─> #3 ─┬─> #5
    │       │       ├─> #6
    │       │       └─> #18 <── #17
    │       ├─> #7 ─┬─> #8 ──> #9 ──┐
    │       │       ├─> #10         ├─> #15 ──┐
    │       │       ├─> #11         │         ├─> #19
    │       │       └─> #16 <───────┼── #14   │
    │       └─> #14 ────────────────┘         │
    ├─> #4 ──> （#5 #6 #7 用到）               │
    ├─> #17 ──────────────────────────────────┘
    └─> #12（用 mock AtlasGraph 并行开发）
#13 最后收口
```

排序理由：数据模型（#1）是引擎、运行时和 UI 之间的契约，必须最先冻结。Service/ServiceLink 和 Provenance 在 #1 就一次性定好，避免后面改 schema。Webview 和 OTLP 接收器（#17）都只依赖模型，可以并行开发。跨服务 HTTP（#15）必须等单服务的 Spring/Vue 入口（#8/#9）准确之后再做，否则连线建立在错误的入口上。运行时合并（#19）放在最后，因为它要拿静态结果做比对。

## Rollback Plan

新仓库，不涉及任何现有系统。扩展发布后如有严重问题，从 Marketplace 下架当前版本（unpublish version），用户回退到上一个 `.vsix`；`.atlas/` 缓存带 `schemaVersion`，版本不兼容时自动丢弃并重建。

## Out of Scope（v0.1）

- 接入已有链路系统（Jaeger / Zipkin / SkyWalking / Tempo），以及读取测试或生产环境的 trace
- Go eBPF 自动插桩；浏览器端（前端）span 采集
- 运行时性能剖析（CPU/内存 profile）、指标和日志采集
- 提交对请求流转的影响分析（D8 的 C 选项），放到 v0.2
- JetBrains / 其他 IDE、SaaS 托管版
- 其他语言和框架：Node/Express/NestJS 后端、PHP、C#、Rust、React/Angular 前端
- 其他 MQ/RPC：ActiveMQ、NATS、Pulsar、Thrift、Spring Cloud Stream binder 抽象（只识别它底层直连 Kafka/RabbitMQ 的写法）
- 从运行中的 Nacos/Eureka/K8s 服务端拉取配置（只读仓库内的文件）
- 代码修改、重构建议、自动生成文档文件
- VS Code LM API（Copilot）provider
