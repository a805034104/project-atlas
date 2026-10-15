<!-- /autoplan restore point: /c/Users/admin/.gstack/projects/project-atlas/main-autoplan-restore-20261015-095157.md -->
# [Epic] ProjectAtlas — VS Code 扩展：AI 项目地图（模块 / 功能 / 启动 / 修改记录 / 请求流转）

> v1.2 · 2026-10-15 · 状态：已评审并批准（/autoplan）。**范围以「范围裁决 v1.2」一节为准**
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


## 范围裁决 v1.2（U1 + T1–T5，2026-10-15 用户在最终闸门拍板，规范性，优先级最高）

**U1 采纳评审意见：v0.1 收窄范围。** 用户原来的 D7、D9、D11（四栈精确 + 运行时 + 四类跨服务都进 v0.1）由用户本人改为下面的分期：

| 版本 | 范围 | 涉及的子 issue |
|------|------|---------------|
| **v0.1** | Java Spring + Vue 的精确流转；跨服务覆盖 HTTP（Feign、RestTemplate/WebClient、注册中心）、网关（Spring Cloud Gateway、Nginx）、前端代理到网关再到服务；模块、功能、启动、修改记录（Spring/Vue/Maven/Gradle/npm）；LLM 层；Webview + TreeView + CodeLens；CLI + 导出；**只读 MCP（T2）**；中文 README、Gitee 镜像（T4） | #1 #2 #3(仅 Java/Vue) #4 #5 #6 #7 #8 #9 #12 #13 #14 #15 + 新增 **#20 MCP** |
| v0.2（暂定，按需求调整） | 本地运行时追踪（先做 Java agent）+ 消息队列（Redis Stream、Kafka、RabbitMQ、RocketMQ） | #16(MQ 部分) #17 #18(Java) #19 |
| v0.3（暂定） | Go（net/http、gin、echo、chi）+ Go 运行时 diff + gRPC | #10 #16(gRPC) #18(Go) |
| v0.4（暂定） | Python（FastAPI、Flask、Django、非 HTTP 入口 + pyright LSP）+ Python 运行时 + Dubbo | #11 #16(Dubbo) #18(Python) |

- **数据模型不缩减**：`Stack`、`ServiceLink.kind`、`Provenance` 中 v0.2 以后才用到的取值（`go`、`python`、`mq`、`grpc`、`dubbo`、`runtime-observed`）在 v0.1 的 schema 里就要保留，避免后续升级 schemaVersion。这些能力在 v0.1 不会产生对应数据，UI 也隐藏相关入口（Trace 标签页、「带追踪启动」）。
- **v0.1 的验收标准**：保留 AC#1、#3、#6–#15、#18 以及 AC-DX1、AC-HO、AC-SEC（去掉 OTLP 那一条）、AC-PERF。AC#2、#4、#5 只覆盖 Spring/Vue 夹具。AC#16、#17、#19–#25 以及 AC-SEC 中 OTLP 和运行器的部分，**移到对应的版本**。
- **v0.1 的夹具**：RuoYi-Vue、RuoYi-Cloud；保留集换成 Jeecg-boot、pig、mall-swarm（T4，全部是 Spring + Vue，只做人工评分）。
- **T1**：v0.1 只用到「tree-sitter + 规则 + 宁缺勿错」；pyright LSP 留到 v0.4 和 Python 一起实现。
- **T2**：新增 #20 `packages/mcp`，提供只读工具：`list_services`、`list_entrypoints`、`get_flow(entrypoint)`、`find_symbol`、`get_module_history`，数据读自 `.atlas/graph/`，不触发分析也不调用 LLM。约 0.5–1 个 CC 日。
- **T3**：在仓库内定义 `RuleSet` 接口，并配 CONTRIBUTING 规则贡献指南；不做运行时插件加载器（已记入 TODOS）。
- **T5**：TreeView、CodeLens、walkthrough 进入 v0.1（#12）。
- **工作量**：v0.1 约人工 9 周，或 CC 6–7 天。

### 工程复核（U1 修改后重跑的工程评审 delta）
- **架构**：范围只减不增；新增的 MCP 只读 `.atlas/graph/` 分片，没有新的写入路径，与 GraphStore 共用读取代码（DRY），没有新的安全面（stdio 传输，不监听端口）。通过。
- **依赖关系**：原关键路径 S1→S2→S4→S7 不变；S5、S6、S10 以及 S12 中的 launcher 部分移出 v0.1；新增 S14 MCP（依赖 S1 和 GraphStore），可以和 S11 并行。
- **测试**：去掉运行时 E2E 和 MQ/RPC 合成夹具（随版本后移）；新增 MCP 工具的单元测试（每个工具 2 条）和一条集成测试（用 RuoYi 的 graph 调用 `get_flow`）。
- **风险**：v0.2 需要在 schema 不升版本的前提下接入运行时 → 已通过「数据模型不缩减」覆盖。
- **结论**：工程评审 CLEAR，没有新的 critical gap。

## 评审修订 v1.1（规范性，与正文冲突时以本节为准）

> 来源：2026-10-15 /autoplan 评审中的机械决策，详见文末「决策审计表」。U1、T1–T5 等待用户在最终闸门裁决，不在本节内。

**架构**
- core 的解析和规则运行在 worker_threads 池中（N = min(4, CPU-1)），每个 worker 独立执行 `Parser.init()`，通过 `locateFile` 加载 wasm；解析完成后调用 `tree.delete()`。LLM 请求在主线程发起，可通过 AbortSignal 取消。所有长任务都接收 `CancellationToken`。
- 新增 `packages/cli`（`npx project-atlas analyze [--json] [--no-ai] [--out]`），以及导出单文件 HTML 和 `ATLAS.md` 的功能（E1/E2）。
- AtlasGraph 按服务和视图分片存放在 `.atlas/graph/`，webview 按需请求切片和分页；ELK 布局放在 webview 的 Web Worker 中执行。
- 调用关系存为一张**全局调用图**，`Flow` 改为 `{ entrypointId, stepIds[], edgeIds[] }` 形式的投影。
- **稳定 ID**：`id = base32(sha1(kind\0serviceName\0canonicalKey))[0..16]`，不包含行号。`SymbolRef` 和 `SourceRef` 新增 `rootId`；`llmUsage` 改为数组。
- **缓存键** = 内容哈希 + analyzerVersion + rulesetVersion + promptVersion + model。上游摘要以下游的**输入哈希**为键；失效沿依赖 DAG 传播。
- trace 存储由 SQLite 改为 `.atlas/traces/*.jsonl` 分段文件 + 内存索引。
- pyright 以 `pyright-langserver --stdio` 子进程方式接入（它没有稳定的库 API）：懒启动，空闲 60 秒退出，崩溃或超时（120 秒）时降级为只用 tree-sitter。
- `extensionKind: ["workspace"]`，不支持 vscode.dev；打包为一个通用 vsix。
- **宁缺勿错**：接收者类型无法确定时不生成边，计入「未解析调用」并列出；精确率只统计已生成的边。
- Spring 规则补充：`@Bean` 工厂方法、Lombok 构造器注入、多实现时依次按 @Primary → @Qualifier/@Resource → 字段名匹配，仍有歧义就生成分支边；AspectJ 只支持 `execution`/`@annotation`/`within`/`bean` 子集；`@PreAuthorize` 归为 interceptor 层；`@ConditionalOn*` 和 SpEL 不求值，只做标注。
- 配置解析补充：嵌套占位符和循环检测、多文档 on-profile、宽松绑定、Nacos shared/extension-configs；网关 RewritePath 用 Java 正则子集转换。
- span 匹配优先级：code.* → 父子关系 + http.route → CGLIB 代理类名规范化 → Mapper 方法 span；不以 SQL 文本作为指纹。启动配置中显式设置 `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`。
- LLM 默认只给「枢纽文件」（入口、Service、每个模块 PageRank 前 20 的文件）生成摘要，token 成本与模块数成正比。Ollama 请求使用 `format: "json"`。
- 文件编码：先认 BOM；UTF-8 校验失败时用 iconv-lite 按 GBK 解码；超过 2 MB 的文件跳过。

**安全**
- Workspace Trust：`untrustedWorkspaces: limited`。受限模式下禁用以下操作：带追踪启动、改写 launch.json、pip 安装、git clone、Go 补丁。
- 提示注入防护：代码只作为数据传入，并用分隔符包裹；LLM 只能返回 schema 化的 JSON，不允许调用任何工具；输出里出现的 id 必须在已知集合中；外发内容只能来自脱敏后的集合（脱敏范围包括源码中的高熵串和凭据赋值）。
- clone 加固：`GIT_ALLOW_PROTOCOL=https:ssh`；URL 前加 `--`；加 `--no-recurse-submodules`；目录名使用 sha1(url)；克隆前需要用户确认。
- OTLP 加固：Host 白名单；拒绝带 Origin 的请求；会话 token 通过 `OTEL_EXPORTER_OTLP_HEADERS` 注入；请求体上限 4 MB，解压后上限 32 MB。
- 运行器加固：pip 使用 `--require-hashes`；Go 补丁快照 go.mod 和 go.sum，撤销前校验哈希；Java 方法清单写入 agent 配置文件。
- Webview：严格 CSP（nonce），markdown 渲染前经过 DOMPurify 清理，其余文本一律当纯文本渲染。

**体验 / DX**（细节见「Phase 2 设计评审」和「Phase 2.5 DX 评审」，两节内容同样属于规范）
- 信息架构：原生 TreeView 加单例面板，标签页顺序为 总览 → 拓扑（服务数大于 1 时才显示）→ 模块 → 功能 → 启动 → 流转 → 修改记录 → Trace。每个视图都要按状态矩阵处理空、错、部分、过期四种状态。
- 来源编码不只靠颜色（线型 + ✓⚙✨● 标记），图支持键盘遍历，并提供列表视图作为替代；只使用 `--vscode-*` 主题 token。
- 命令和设置统一使用 `atlas.*` 前缀（完整清单见 DX 评审 Pass 2）；`atlas.llm.provider` 默认为 `none`。
- `atlas.yaml` v1 提供 JSON Schema，支持 services、wrappers、edges.add/remove、ignoreEntrypoints；webview 中可以「标记为错误」，结果写入 `.atlas/overrides.yaml`。
- 错误契约：code + problem + cause + fix + docsUrl，错误码前缀 ATLAS-Exxx。新增命令 `atlas.diagnose`，用于导出诊断包。
- 首次使用引导：walkthrough（选模型 → 测试连接 → 可跳过）；费用确认框按阶段列出并可逐项勾选；状态栏统一显示追踪状态。
- 生成的文件都带 `atlas:generated v<x>` 标记；atlas.yaml 和设置项升级时自动迁移。

**验收标准修订**
- **AC-DX1（新增）**：在没有任何 Key 的机器上打开 RuoYi-Vue，60 秒内能看到确定性地图（模块、入口、流转、启动、修改记录），且全程网络请求数为 0。
- **AC#3**：改为按符号断言，不再写死行号。黄金文件采用「机器快照 + 人工审核 diff + 20 条固定种子抽样的手工断言」。
- **AC#6**：比较对象改为 `git log --numstat -z -- <path>`（语义一致）；浅克隆的服务不适用这条。
- **AC#12**：运行时 E2E 只在 Linux 上跑；macOS 和 Windows 只跑单元测试、集成测试和 vsix 冒烟测试。
- **新增 AC-HO**：在 3 个从未见过的仓库上（保留集），人工抽样评分达到发布门槛：确定性边的精确率 ≥ 95%。
- **新增 AC-SEC**：
  - 恶意 README 测试：发出的 payload 中不包含 .env 内容；
  - 浏览器页面向 OTLP 发送带 Origin 的请求，必须被拒绝；
  - 受限模式下，以上禁用的操作全部不可用。
- **新增 AC-PERF**：用合成的 5 万文件仓库测试，确定性阶段在 4 核机器上 < 90 s，内存峰值 < 1.5 GB。
- 测试补充：LLM 混沌测试、取消和重入、缓存损坏、畸形配置文件、gzip 炸弹。夹具以 tarball 形式按 sha256 缓存；修复规则缺陷时附带回归夹具。

**子 issue 调整**：#13 增加 CLI 与导出（E2/E1）、docs 信息架构、CONTRIBUTING（规则贡献指南）、`docs/errors.md`；#12 增加 TreeView、CodeLens（T5 通过时）、walkthrough。内部里程碑 **M1** = #1 → #2 → #8 → #9 → 流转视图（不对外发布）。


---

# /autoplan 评审记录（2026-10-15）

> 本节是 /autoplan 的评审过程和结论。以上方 spec 正文为准；评审中被接受的修改会回写到正文，并记入「决策审计表」。
> 本机未安装 Codex，所有「双声道」都降级为 Claude 独立子代理 `[subagent-only]`。它和主评审属于同一模型家族，参考权重应相应调低。

## Phase 1 — CEO 评审（模式：SELECTIVE EXPANSION）

### 系统审计
- 仓库是新建的：只有 1 个提交 `3e636ab docs: add ProjectAtlas v0.1 spec`，没有 CLAUDE.md、TODOS.md，也没有现有代码。
- 没有 office-hours 设计文档。spec 本身已经包含问题陈述、已锁定的决策和备选方案，所以把它作为设计来源，不再补跑 /office-hours（autoplan 中途不打断用户）。
- 本地 RuoYi-Vue 已核实：36 个 Controller、219 个方法级 Mapping 注解，`ResourcesConfig.java:48` 注册了 `/**`，`SysUserServiceImpl.java:77` 上有 `@DataScope`。这份本地副本相对上游有改动，spec 已改为引用上游的固定 commit。

### 竞品格局（WebSearch）
- **CodeViz**（YC 孵化，VS Code 扩展）：用静态分析加 AI 生成架构图和函数调用图，点节点可跳转源码，支持自然语言查询流程。和本项目的「模块图 + 请求流转」高度重合。[来源](https://www.ycombinator.com/companies/codeviz)
- **AppMap**（VS Code / JetBrains，agent 开源）：在本地录制运行时 trace，生成交互式时序图，支持 Java、Python、JS、Ruby，数据存在本机。和本项目的「本地运行时追踪」高度重合。[来源](https://dev.to/appmap/auto-magically-generate-sequence-diagrams-of-your-codes-runtime-behavior-597a?bb=3869)
- **CodeVisualizer**（开源）：函数级流程图和依赖图。[来源](https://dev.to/techresolve/solved-codevisualizer-instantly-map-your-entire-codebase-in-vs-code-2cog)
- 三层综合：
  - [L1] 成熟做法是静态依赖图（Sourcetrail、CodeViz）和运行时录制（AppMap）各做各的。
  - [L2] AI 生成仓库 wiki 和架构图已经很普遍，「AI 编造调用」是公认的痛点。
  - [L3] 第一性原理来看，还没有人把**框架语义规则**当作真值：Spring 拦截器注册顺序、网关 StripPrefix、Feign 服务名、Redis Stream key 这些都能直接从代码确定。以规则为准、用运行时 span 印证、让 AI 只补空白，这是本项目的差异化。另外，**中国企业 Java 生态**（RuoYi、Jeecg、Nacos、Dubbo、RocketMQ）在西方工具里基本没有覆盖，是一个真实的切入点。

### 0A 前提挑战
| # | 前提 | 评估 | 处理 |
|---|------|------|------|
| P1 | 开发者理解陌生项目要花很多时间，愿意为此装扩展 | 成立：CodeViz、AppMap 都有用户 | 接受 |
| P2 | 「确定性规则 + AI 补全」比纯 AI 更可信 | 成立，这是核心差异 | 接受 |
| P3 | **四个技术栈全部做到精确后才发 v0.1**（用户决策 D7），同时 D9 运行时追踪、D11 四类跨服务也都放进 v0.1 | 存疑：第一个外部反馈要等 11–14 个 CC 日或 18 个人工周以上。独立子代理认为这个估算偏乐观。开源项目最需要早期用户帮忙校正规则 | **User Challenge U1，留到最终闸门由用户裁决**（用户原方向不变，除非用户亲自改） |
| P4 | 运行时追踪用 OpenTelemetry，而不是自研或采用 AppMap 格式 | 成立 | 接受（子代理认为整块功能应延后，归入 U1） |
| P5 | 用户愿意自带 LLM Key | 对开源用户成立；Ollama 可覆盖「代码不能外发」的场景 | 接受 |
| P6 | 仅用 tree-sitter 就能做到「精确」的类型解析 | **部分不成立**：tree-sitter 只有语法，没有类型。Spring 的 @Primary/@Qualifier/@Conditional、Go 的结构化接口、Python 的动态分派都需要类型信息 | 品味决策 T1（见 0C-bis） |

### 0B 现有可复用资产
| 子问题 | 现成方案 | 处理 |
|--------|---------|------|
| 语法和注解 | web-tree-sitter + grammar（WASM） | 复用 |
| Python 类型推断 | pyright（npm 包，可在 Node 中运行） | 复用（T1） |
| Go 类型和接口实现 | `go/packages` + `go/types`（需要用户本机有 Go 工具链）；没有工具链时回退到 tree-sitter 方法集匹配 | 复用（T1） |
| Java 类型 | 没有纯 Node 的现成方案；scip-java 需要先编译项目 | tree-sitter + 自建符号表，并补充 @Primary/@Qualifier/泛型规则（T1） |
| 运行时 agent | opentelemetry-javaagent、opentelemetry-instrument、otelgin 等 | 复用 |
| OTLP 解码 | opentelemetry-proto 定义 + protobufjs | 复用 |
| 布局和画布 | elkjs、@xyflow/react | 复用 |
| git | 系统自带的 `git` CLI（`-z` 输出） | 复用 |
| trace 存储 | 原计划用 SQLite（原生模块）→ 改为 JSONL 分段文件 + 内存索引 | 见 A3 |

### 0C 梦想状态
```
  现状                          本计划                                   12 个月理想状态
  读 README、全局搜索、         VS Code 一键生成地图：                    共享地图（导出 / MCP / CI）
  打断点，花数小时到数天   ──▶  模块 / 功能 / 启动 / 修改记录 /     ──▶  PR 影响分析
                                请求流转（规则边 + AI 边 + 运行时边）     AI 编码助手直接读 AtlasGraph
                                + 跨服务拓扑                              社区贡献框架规则
```
差距：AtlasGraph 作为稳定契约，是通往理想状态的地基。还缺两样：AI 助手出口（MCP，见 T2）和社区规则机制（见 T3）。

### 0C-bis 实现方案
```
方案 A：全部用 tree-sitter WASM + 自建符号表 + 框架规则（spec 原方案，最小可行）
  工作量 XL  风险 中
  优点：纯 Node，三平台零原生依赖；CLI 和扩展共用
  缺点：Python 和 Go 的接口/动态调用精度低；在样本上能达标，在陌生仓库上会掉点
方案 B：直接用真正的索引器（scip-java / scip-go / scip-python 或 LSP）产出符号和调用边，tree-sitter 只负责注解和路由（理想精度）
  工作量 XL  风险 高
  优点：类型精度最高
  缺点：scip-java 需要先 mvn/gradle 编译，没法做到「导入即看」；依赖 JDK/Go 工具链；Windows 上安装麻烦
方案 C（混合）：A 作为底座；Python 接 pyright 做类型推断；本机有 Go 工具链时用 go/types 增强，没有就退回 A；Java 在 A 的基础上补 Spring 注解语义规则；预留 SCIP 导入接口，以后可以接入用户已有的索引
  工作量 XL（比 A 多约 1.5 个 CC 日）  风险 中
建议：C。完整度高（P1），不强制编译也不要求原生依赖（P5），能补上 P6 指出的缺口。B 和 C 都可行 → 品味决策 T1。
```

### 0D SELECTIVE EXPANSION
- **复杂度**：19 个子 issue、3 个包。这是用户在 D7/D9/D11 中明确选择的范围，HOLD 基线不擅自缩减。是否缩减交给 U1。
- **最小价值链路**：#1 → #2 → #8 → #9 → 流转视图。定为**内部里程碑 M1**（不发布），用于尽早验证架构。只调整内部顺序，不改变 D7 的发布门槛，属于机械决策。
- **扩展候选**：
| # | 候选 | 工作量 | 裁决 | 依据 |
|---|------|--------|------|------|
| E1 | 导出为单文件 HTML / `ATLAS.md`（团队分享，可提交进仓库传播） | S | **接受** | 在影响范围内且 <1 天（P2）；子代理也独立提出 |
| E2 | CLI `npx project-atlas analyze`（CI 跑样本需要） | S | **接受** | 在影响范围内且 <1 天（P2）；AC#12 的前提 |
| E3 | 「问地图」对话 | M | 延后 → TODOS | 超出影响范围（P3） |
| E4 | 只读 MCP server，向 AI 助手暴露 AtlasGraph | S–M | **品味决策 T2**（建议接受） | 主评审建议延后，子代理建议首日就做 |
| E5 | 框架规则插件 API | M | **品味决策 T3**（建议延后） | 子代理建议放进 v0.1 |
| E6 | 导入 AppMap 文件 | S | 跳过 | 和 OTel 重复（P4） |
| E7 | GitHub Action，在 PR 中更新 ATLAS.md | S | 延后 → TODOS | 依赖 E1、E2 |
| E8 | 中国生态定位：中文 README、Gitee 镜像、新增 Jeecg-boot 和 pig 样本 | S | **品味决策 T4**（建议接受） | 子代理指出这是唯一有防御性的切入点 |

### 0E 时间推演
- **第 1 小时**：节点 ID 规则必须现在定下来：`id = sha1(serviceId + kind + 规范化 key)`。否则增量缓存和运行时合并都对不上 → 写入数据模型（机械决策）。
- **第 2–3 小时**：`@RequestMapping` 支持数组和 `${}` 占位符；拦截器路径按 AntPathMatcher 语义匹配 → 需要独立的 Ant 匹配器模块并配单测。
- **第 4–5 小时**：Windows 路径与大小写；git 的 quotepath 会把中文路径转义，必须用 `-z`；多根工作区里同一仓库要按 realpath 去重。
- **第 6 小时以后**：LLM 返回非法 JSON 时重试；5 万文件以上的仓库需要采样、进度显示和取消。

### 双声道 — CEO
CODEX SAYS：`[codex-unavailable: binary not found]`

CLAUDE SUBAGENT（CEO，战略独立视角）要点：
1. **Critical**：主要使用者选错了。人看地图只在入职那几天，真正需要「已验证调用图」的是 AI 编码助手 → 第一天就做 MCP 和 CLI，并把 VS Code LM API 加回范围。
2. **Critical**：仅靠 tree-sitter 做不到「精确」→ 应使用真正的索引器（SCIP/LSP）。
3. **Critical**：D7 + D9 + D11 叠加，v0.1 可能永远发不出来 → v0.1 只做 Spring + Vue + RuoYi-Cloud 跨服务 + MCP；Go、Python、MQ/RPC、运行时都放到 v0.2 以后。
4. **High**：运行时追踪在重复 AppMap，而且启动摩擦大 → 从 v0.1 移出，以后改为导入已有的 OTLP 或 AppMap 数据。
5. **High**：真正的切入点是中国企业级 Spring Cloud Alibaba + Vue 生态 → 调整定位，新增 Jeecg/pig 样本，提供中文 README 和 Gitee 镜像，Python 延后。
6. **High**：前提都没验证过 → 在做 #8 之前，先拿纯静态原型给 10 个 RuoYi 开发者试用，看他们是否会回来再用。
7. **Medium**：AC 对样本过拟合（写死了行号）→ 增加没见过的保留集，由人工抽样评分。
8. **Medium**：静态导出被排除了，而它正是传播渠道 → 增加导出功能 + GitHub Action。
9. **High**：竞争窗口很短 → 规则插件 API 放进 v0.1，让社区承担长尾框架。

```
CEO 双声道共识表：
═══════════════════════════════════════════════════════════════
  维度                                Claude主审  子代理   共识
  ──────────────────────────────────── ────────── ─────── ─────────
  1. 前提成立？                        部分(P3,P6) 部分     CONFIRMED（P3、P6 存疑）
  2. 解决的是对的问题？                是          部分     DISAGREE（使用者：人 vs AI 助手）→ T2
  3. 范围校准正确？                    否(U1)      否       CONFIRMED → User Challenge U1
  4. 备选方案充分探讨？                补了 C      否(SCIP) DISAGREE → T1
  5. 竞争风险已覆盖？                  部分        否       CONFIRMED（补定位 T4）
  6. 6 个月轨迹合理？                  有风险      否       CONFIRMED（并入 U1）
═══════════════════════════════════════════════════════════════
Codex 缺席，以上一律视作 [subagent-only]。
```
被接受为机械决策的子代理意见：#7（新增保留集，见 AC 补丁）、#8（导出，已由 E1 覆盖；Action 记入 TODOS）。
运行时延后（#4）和 VS Code LM API 加回（#1 的一部分）都推翻了用户的明确决策（D9、D5）。主审没有同时主张这两项，因此不构成「双方一致」。归入 U1 的说明，同时在闸门列出 **D5 的反方意见**。

### Section 1 架构
```
                 ┌──────────────────── VS Code 扩展宿主 (packages/vscode) ─────────────────────┐
 用户命令 ───────▶ commands ─┬─▶ AnalysisController ─▶ core.analyze() [worker_threads] ─┐      │
 Webview ◀─postMessage(切片)─┤                                                          │      │
                 │           ├─▶ SecretStorage（LLM keys）                               │      │
                 │           ├─▶ TraceLauncher ─▶ launch.json diff / env 注入           │      │
                 │           └─▶ OtlpReceiver(127.0.0.1) ─▶ .atlas/traces/*.jsonl ──┐   │      │
                 └──────────────────────────────────────────────────────────────────┼───┼──────┘
 packages/core: ingest ─▶ detect(services/modules/startup) ─▶ flow(RuleSet×4) ─▶ xservice ─▶ merge(runtime) ─▶ AtlasGraph
                    └──▶ llm（预估 → 确认 → 脱敏 → map-reduce → 证据校验）──────────┘          │
 packages/webview: React + xyflow + elkjs                                          .atlas/graph.json + cache/
 packages/cli (E2) ─▶ core ─▶ graph.json / ATLAS.md / atlas.html (E1)      [packages/mcp (T2 若接受)]
```
- **A1 耦合**：webview 只通过 postMessage 获取 AtlasGraph 切片，不直接读磁盘。边界清晰，没有问题。
- **A2 扩展性**：大仓库的 graph.json 可能有几十 MB → webview 改为按视图请求切片。机械决策，P5。
- **A3 原生依赖**：SQLite（better-sqlite3）在 Electron 下有 ABI 问题 → 改用 JSONL 分段文件 + 内存索引（10 万 span 上限）。机械决策，P5。
- **A4 端口占用**：spec 已定义自动换端口。
- **A5 回滚**：扩展版本可回退；schemaVersion 不一致时重建；Go diff 可撤销。已覆盖。
- **A6 取消**：缺口 → `CancellationToken` 一路透传到 core 的 worker 和 LLM 请求的 AbortSignal。机械决策。
- **A7 稳定 ID**：见 0E，写入数据模型。

### Section 2 错误与恢复登记表
| 代码路径 | 可能的错误 | 错误类型 | 是否处理 | 处理方式 | 用户看到 |
|---------|-----------|---------|---------|---------|---------|
| ingest.parseFile | 语法错误、超时、超大文件（>2 MB） | `ParseError` | 是 | 跳过，记入 diagnostics | 总览显示「N 个文件跳过」，可展开 |
| ingest.walk | 符号链接成环、无权限 | `WalkError` | 是 | 用 realpath 去重，跳过 | 同上 |
| llm.call | 401/403 | `LlmAuthError` | 是 | 停止，不重试 | 「API Key 无效」+ 设置入口 |
| llm.call | 429 | `LlmRateLimitError` | 是 | 读 retry-after，指数退避 3 次 | 进度显示「限流等待」 |
| llm.call | 超时 / 网络错误 | `LlmTransportError` | 是 | 重试 2 次，失败的批次可以续跑 | 「N 个摘要失败，点此重试」 |
| llm.call | 非法 JSON / 不符合 schema | `LlmSchemaError` | 是 | 附上校验错误再重试 1 次，仍失败则丢弃 | 该区块显示「AI 摘要不可用」 |
| llm.call | 拒答 / 空响应 | `LlmEmptyError` | 是 | 同上 | 同上 |
| llm.call | 超出 token 预算 | `LlmBudgetExceeded` | 是 | 暂停并询问 | 确认框 |
| llm.evidence | 无证据，或命令找不到出处 | `EvidenceRejected` | 是 | 丢弃并计数 | 诊断区显示计数 |
| git.log | 不是仓库 / 浅克隆 | `GitUnavailable` | 是 | 降级 | 修改记录显示空状态，说明原因 |
| xservice.clone | 克隆失败 / 协议被拒 | `CloneError` | 是 | 只让该服务失败 | 拓扑图上显示红色节点和原因 |
| otlp.receive | 请求过大 / 格式错误 | `OtlpDecodeError` | 是 | 返回 400 + 日志 | 「丢弃 N 条」 |
| otlp.listen | 端口被占用 | `EADDRINUSE` | 是 | 换端口 | 无感知 |
| launcher.java | 下载失败 / sha256 不匹配 | `AgentIntegrityError` | 是 | 删除文件并中止 | 「agent 校验失败，重试」 |
| launcher.python | 找不到 venv / pip 失败 | `PythonEnvError` | 是 | 显示 pip 输出 | 输出面板 |
| launcher.go | 文件已被改动 | `PatchConflictError` | 是 | 拒绝应用 | 「请重新生成」 |
| merge | span 无法匹配 | 不是错误 | — | 生成 runtime-observed 边 | 用独立颜色显示 |

禁止 catch-all。每个错误都要带上下文（文件、服务、批次 id）。**原 spec 没有这张表 → 补入（T-CEO-1，机械决策，P1）。**

### Section 3 安全
| 威胁 | 可能性 | 影响 | 缓解（补入 spec） |
|------|--------|------|------------------|
| 提示注入（仓库注释或 README 诱导外发 .env） | 中 | 高 | 代码一律作为数据，用分隔符包裹；LLM 只返回 schema JSON；**LLM 不能调用任何工具**；外发内容只能来自脱敏后的集合 |
| atlas.yaml 恶意地址（`ext::`、`file://`） | 低 | 高 | 只允许 https 和 git@；clone 时加 `-c protocol.ext.allow=never --no-recurse-submodules`；克隆前需要确认 |
| 不受信任的工作区 | 中 | 高 | `untrustedWorkspaces: limited`：受限模式下禁用带追踪启动、修改 launch.json、pip、clone 和 Go diff |
| Webview XSS（代码字符串、提交信息） | 中 | 中 | 严格 CSP（`default-src none`，脚本用 nonce），所有内容按纯文本渲染 |
| javaagent 被中间人篡改 | 低 | 高 | 固定版本 + sha256（spec 已有） |
| API Key 泄漏 | 低 | 中 | 存 SecretStorage；不写 settings 和日志 |
| 本机进程向 OTLP 投毒 | 低 | 低 | 只绑定 loopback；数据只用于展示 |
| 供应链 | 低 | 中 | 锁定版本，CI 跑 npm audit |

### Section 4 数据流与交互边界
```
 源文件 ─▶ 遍历 ─▶ 解析 ─▶ 符号表 ─▶ 规则 ─▶ AtlasGraph ─▶ 脱敏 ─▶ LLM ─▶ 证据校验 ─▶ 合并 ─▶ 视图
 [空仓]   [5万文件] [语法错] [同名类]  [0入口]  [旧schema]   [全排除] [超时]  [无证据]    [无span]
 [二进制] [符号环]  [超大]   [循环import][多实现]            [非UTF8] [非法JSON]
```
| 交互 | 边界情况 | 处理（补入 spec） |
|------|---------|------------------|
| 点击「分析」 | 重复点击 | 同一时间只跑一个任务，再点就聚焦到进度 |
| 分析过程中 | 关闭窗口 / 切换工作区 | 可以取消；已完成的批次进缓存，下次续跑 |
| 分析过程中 | 文件被修改 | 以开始时的哈希为准，结束后提示增量更新 |
| 不支持的技术栈 | 0 个入口 | 空状态，并列出检测到的语言 |
| 流转视图 | 1 万个入口 | 虚拟列表 + 搜索 + 按服务和方法过滤 |
| 流转视图 | 200 步以上 / 递归 | 默认展开深度 12；检测到环时显示「↺ 递归」 |
| 带追踪启动 | 服务起不来 | 显示输出面板；60 秒内没有 span 时给出排查提示 |
| Go diff | 应用后用户又手动修改，再撤销 | 先校验哈希；有冲突时显示 3-way diff，不强制覆盖 |

### Section 5 代码质量
- **DRY**：四个栈统一实现 `RuleSet` 接口（`findEntrypoints`、`findMiddleware`、`resolveCall`、`classifyLayer`），共用同一个图构建器，不各写一套遍历 → 写入 spec。
- 易错的小模块要单独拆出并配单测：Ant 路径匹配、Spring 占位符解析、Python import 解析、网关路径改写。
- 防过度设计：插件 API 先保持内部（T3）。

### Section 6 测试
```
 新 UX 流程：  分析 / 8 个视图 / 带追踪启动 / Go diff 应用与撤销 / provider 配置 / token 确认 / 导出（E1）/ CLI（E2）
 新数据流：    ingest→graph；graph→LLM→graph；OTLP→store→merge；git→history；atlas.yaml→clone→ingest
 新代码路径：  RuleSet × 框架；脱敏；证据校验；缓存失效；ID 生成；Ant 匹配；占位符解析
 新异步：      可取消、可续跑的分析任务；OTLP 接收；trace 清理
 新外部调用：  3 个 LLM provider；git；javaagent 下载；pip；git clone
 新错误路径：  Section 2 的 17 行
```
补入：①**恶意 README 测试**：断言 payload 中不包含 .env 内容，并且 LLM 输出无法触发任何动作；②**LLM 混沌测试**：随机返回 429、非法 JSON 或空响应时，任务最终仍能完成；③运行时 E2E 用健康检查等待服务就绪，**禁止用固定 sleep**；④**保留集**：3 个没见过的真实仓库，人工抽样评分作为发布门（采纳子代理 #7）。

### Section 7 性能
最慢的三条路径：
1. LLM map 阶段：并发上限默认 4，可配置。
2. 全量解析：放到 worker_threads。
3. span 合并：按 `code.function` 建哈希索引。

AST 解析完就释放，不常驻内存。→ 补入。

### Section 8 可观测性
- 「ProjectAtlas」输出通道，结构化记录：阶段、耗时、文件数、LLM 调用次数、token 数、失败数。
- 总览页增加「诊断」折叠区。
- **默认不上报任何遥测数据。**
- 新增命令「导出诊断包」：打包日志、统计和 schema 版本，不含代码和密钥。属于 S 级，在影响范围内，接受（P2）。

### Section 9 发布
- 用 vsce 和 ovsx 发布；打 tag 后由 CI 触发。
- 先发 pre-release 渠道，验证后再转正式版。
- 增加开关 `atlas.runtime.enabled` 和 `atlas.crossService.enabled`。
- 没有数据库迁移。

### Section 10 长期轨迹
- 可逆性 4/5：唯一的单向门是 AtlasGraph 的 schema。
- 技术债：四套规则的维护成本（T3）、类型精度（T1）。
- 补 `docs/architecture.md` 和 `CONTRIBUTING.md`（说明如何新增一条框架规则），写入 #13。

### Section 11 设计与体验
信息层级：
1. 服务拓扑（单服务项目显示模块图）+ 摘要
2. 功能清单
3. 请求流转、修改记录

| 功能 | 加载中 | 空 | 错误 | 成功 | 部分 |
|------|--------|----|------|------|------|
| 分析 | 分阶段进度，可取消 | 未识别到技术栈 | 显示原因 + 重试 | 地图 | AI 失败时规则结果照常显示，AI 区块标「待补全」 |
| 流转 | 骨架屏 | 无入口 | — | 泳道图 | 显示 AI 边 / 运行时边的图例 |
| Trace | 等待首个 span | 还没带追踪启动过 | 接收器异常 | 瀑布图 | 显示丢弃计数 |

深度设计评审见 Phase 2。

### CEO 必需输出
- **不在范围内（本阶段新增）**：E3 / E7 → TODOS；E6 跳过；Go 工具链之外的 SCIP 导入延后。T2、T3 的结果以闸门裁决为准。
- **已有资产**：见 0B；仓库里没有可复用的代码。
- **梦想状态差距**：v0.1 解决「个人在本地看懂项目」并打好契约地基。离理想状态还差：共享（E1 部分覆盖）、AI 助手（T2）、社区规则（T3）。

**失败模式登记表**
| 代码路径 | 失败模式 | 已处理? | 有测试? | 用户看到 | 有日志? |
|---------|---------|---------|---------|---------|---------|
| LLM 批处理 | 部分批次失败 | 是 | 是（混沌测试） | 可重试 | 是 |
| 提示注入 | 诱导外发 | 是 | 是（恶意 README） | 无 | 是 |
| 证据校验 | 编造的命令 | 是（丢弃） | 是 | 无 | 是 |
| 运行时合并 | span 缺少 code.* 属性 | 是（退化为按 route 匹配） | 是 | 粒度变粗 | 是 |
| 大仓库 | OOM | 是（worker + 释放 AST） | 是（性能测试） | 进度 | 是 |
| 多根工作区 | 同一仓库重复加入 | 是（realpath 去重） | 是 | 无 | 是 |
| 陌生仓库 | 精度明显低于样本 | 部分（T1 + 保留集） | 是（保留集） | 精度下降 | 是 |

**CRITICAL GAP：0**（以上缺口都已补入）。

```
  +====================================================================+
  |            MEGA PLAN REVIEW — COMPLETION SUMMARY                   |
  +====================================================================+
  | Mode selected        | SELECTIVE EXPANSION                         |
  | System Audit         | 新仓库，0 代码；本地 RuoYi 已核实            |
  | Step 0               | 6 个前提：U1 + T1；方案 C；M1 内部里程碑     |
  | Section 1  (Arch)    | 7 个问题（A2 切片、A3 去 SQLite、A6 取消等） |
  | Section 2  (Errors)  | 17 条错误路径，0 GAPS（已补表）              |
  | Section 3  (Security)| 8 项，2 项高影响已缓解                       |
  | Section 4  (Data/UX) | 8 个边界情况，均已补                         |
  | Section 5  (Quality) | 2 个问题                                     |
  | Section 6  (Tests)   | 图已产出，补 4 类测试                        |
  | Section 7  (Perf)    | 3 条慢路径，已补                             |
  | Section 8  (Observ)  | 3 个缺口，已补                               |
  | Section 9  (Deploy)  | 2 项                                         |
  | Section 10 (Future)  | 可逆性 4/5，技术债 2 项                      |
  | Section 11 (Design)  | 状态覆盖表已产出 → Phase 2                   |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (5 items)                            |
  | What already exists  | written                                      |
  | Dream state delta    | written                                      |
  | Error/rescue registry| 17 methods, 0 CRITICAL GAPS                  |
  | Failure modes        | 7 total, 0 CRITICAL GAPS                     |
  | TODOS.md updates     | 3 items (E3, E7, SCIP 导入)                  |
  | Scope proposals      | 8 proposed, 2 accepted, 3 taste, 1 skip      |
  | CEO plan             | written                                      |
  | Outside voice        | ran (claude subagent)                        |
  | Lake Score           | 9/10 选择了完整选项                          |
  | Diagrams produced    | 架构、数据流、梦想状态                       |
  | Stale diagrams found | 0                                            |
  | Unresolved decisions | 0（U1、T1–T4 在闸门裁决）                    |
  +====================================================================+
```

## Phase 2 — 设计评审

### Step 0 设计范围
- **初始评分：4/10**。引擎部分写得很细，但 UI 只在「Webview 视图」里列了 8 个视图名，信息层级、导航、状态、编辑器集成、主题和无障碍都没写。按 10 分的标准，这个 spec 应该包括：每个视图的状态矩阵、导航和深链规则、原生入口（TreeView/CodeLens）、来源编码图例（非颜色）、图的键盘操作，以及只用 VS Code 主题 token。
- **DESIGN.md**：没有。这是 VS Code 扩展，设计系统应该直接使用 **VS Code 原生主题 token（`--vscode-*`）+ Codicons + `@vscode/webview-ui-toolkit` 风格**，不另建品牌视觉。因此不需要 /design-consultation（机械决策，P5）。
- **可复用的现成设计**：VS Code 原生组件（TreeView、CodeLens、Walkthrough、StatusBarItem、QuickPick）。
- **视觉稿**：生成器需要 OpenAI Key，本机没有（`DESIGN_NOT_AVAILABLE`：缺凭证）→ 改用 ASCII 线框图。
- 分类：**OPERATE（App UI）**，适用 App UI 规则：扫读优先、符合原生习惯，不用卡片墙。

### 双声道 — 设计
CODEX SAYS：`[codex-unavailable]`
CLAUDE SUBAGENT（独立评审）：
1. **Critical**：信息层级颠倒。单仓用户一打开就看到只有一个节点的拓扑图 → 默认改为总览（功能 / 启动 / 热点模块），服务数大于 1 时才显示拓扑。
2. **Critical**：缺少状态定义：无 Key、等待确认、部分结果、中途出错、过期缓存，以及各种空状态。
3. **High**：旅程断点：首次配置缺少 walkthrough；费用确认缺少按阶段明细；追踪状态分散在三个地方 → 用一个状态栏项统一。
4. **High**：描述太笼统：导航模型、深链和返回、单例面板、状态持久化、主题 token、原生 TreeView/CodeLens 都没定义。
5. **High**：无障碍：信息只靠颜色或线型区分 → 需要冗余编码、键盘遍历图、表格替代视图、高对比主题。
6. 有歧义的地方：跨服务分支的泳道布局；来源 × 观测的组合矩阵；QPS 的统计窗口；AI 输出的语言；跳转源码时打开的位置；E2E 写的是 6 个视图，实际有 8 个。

```
设计 Litmus 共识表（App UI 适用项）：
═══════════════════════════════════════════════════════════════
  检查项                                  主审   子代理  共识
  ──────────────────────────────────────── ────── ─────── ────────
  1. 第一屏就能看出产品是什么？           否     否      CONFIRMED（改为总览优先）
  2. 有一个强视觉锚点？                   否     否      CONFIRMED（总览三块 / 流转泳道）
  3. 只扫标题就能理解？                   部分   否      CONFIRMED
  4. 每个区块只做一件事？                 是     是      CONFIRMED
  5. 卡片是必要的吗？                     未定   —       采用列表和表格，总览用三个分区而不是卡片墙
  6. 动效服务于层级？                     未定   —       仅用于展开/折叠和跳转高亮，遵循 reduced-motion
  7. 去掉装饰阴影后仍然专业？             是     —       不使用阴影，只用原生分隔线
═══════════════════════════════════════════════════════════════
硬性否决项命中：7（App UI 由卡片堆叠而成）存在风险 → 已用 IA 规范规避。
```

### Pass 1 信息架构：3/10 → 9/10
补入 spec（机械决策，P5）：
```
 活动栏 [Atlas 图标]
 ├─ TreeView「ATLAS」（原生侧边栏）
 │   ├─ 服务（>1 个时显示）
 │   ├─ 模块
 │   ├─ 入口（按服务 / HTTP·MQ·定时·CLI 分组，可过滤）
 │   └─ 追踪状态（接收器端口、span 数）
 └─ 点击任意节点 → 打开或聚焦 Atlas 面板（单例 WebviewPanel，显示在编辑器右侧）

 Atlas 面板（顶部是标签页，顺序按用户提问顺序排列）
 ┌───────────────────────────────────────────────────────────────────────┐
 │ [总览] [拓扑*] [模块] [功能] [启动] [流转] [修改记录] [Trace]   ⓘ图例 ⟳ │  * 服务数 >1 才显示
 ├───────────────────────────────────────────────────────────────────────┤
 │ 总览：①这是什么（主体功能 3–5 条） ②怎么跑（主目标的启动命令，可复制）│
 │       ③重点在哪（近 90 天改动最多的 5 个模块） ④诊断折叠区             │
 └───────────────────────────────────────────────────────────────────────┘
```
- **深链**：所有视图支持 `atlas://view/<id>?node=<nodeId>`。功能 → 模块 → 入口 → 流转之间的跳转压入面包屑，可以「← 返回」。
- **持久化**：用 `getState`/`setState` 保存当前标签页、选中节点和过滤条件；`retainContextWhenHidden=false`（省内存）。重新打开时恢复。
- **编辑器内入口**（品味决策 T5，建议接受；在影响范围内，约 0.5 个 CC 日）：
  - Controller、handler 方法上方显示 CodeLens「⟶ 查看请求流转 · p95 42ms」；
  - 右键菜单「在 Atlas 中定位」。

### Pass 2 交互状态：2/10 → 9/10
| 视图 | 加载中 | 空 | 错误 | 部分 | 过期 |
|------|--------|----|------|------|------|
| 全局 | 分阶段进度（解析 → 规则 → 跨服务 → AI），每阶段完成后立即渲染该阶段结果；可以取消 | 未识别到受支持的技术栈：列出检测到的语言，并给出「查看支持列表」链接 | 按 Section 2 的错误类型给出原因和下一步按钮 | 没有 Key 或用户拒绝外发：确定性地图照常显示，AI 区块显示「未生成 AI 摘要 · 配置模型」 | 文件有改动：顶部黄条「N 个文件已变化 · 增量更新」 |
| 总览 | 三区骨架屏 | — | — | 功能区待 AI 生成时，先用入口和模块名列出「候选功能」 | 同上 |
| 拓扑 | 骨架屏 | 只有一个服务时不显示该标签 | 克隆失败的服务置灰，带「重试」按钮 | 存在未解析的跨服务调用时，显示「N 条候选（AI）」开关 | — |
| 模块 | 骨架屏 | — | — | 部分文件解析失败时，节点上显示 ⚠ 和计数 | — |
| 启动 | — | 没找到启动证据：「未识别到启动方式」，并列出已检查过的文件 | — | 只有部分 target 有证据时，逐个显示 | — |
| 流转 | 选择入口后显示骨架屏 | 没有入口：「未识别到入口」，附支持的框架列表 | — | 链路在第 12 层截断时显示「展开更多」 | — |
| 修改记录 | — | 不是 git 仓库或是浅克隆：说明原因；浅克隆时提示 `git fetch --unshallow` | — | AI 演进摘要未生成时只显示时间线 | — |
| Trace | 「等待首个 span…」+ 实时计数 | 还没有用追踪方式启动过：主按钮「▶ 带追踪启动」 | 接收器端口异常：显示端口和重试按钮 | 有 span 被丢弃时显示计数 | 7 天前的数据显示 lastSeen 时间 |
| 费用确认对话框 | — | — | 预估失败时按上限估算 | 按阶段勾选（文件摘要 / 模块 / 功能 / 启动 / 演进），每项显示 token 数和金额 | — |

### Pass 3 用户旅程：3/10 → 8/10
| 步骤 | 用户操作 | 用户感受 | spec 已覆盖？ |
|------|---------|---------|--------------|
| 1 | 安装扩展 | 好奇 | 补：`contributes.walkthroughs`，三步：选模型 → 测试连接 → 也可以跳过，只用确定性分析 |
| 2 | 首次分析 | 担心要花多少钱 | 补：按阶段显示的费用确认框；Ollama 显示 ¥0 |
| 3 | 等待 | 不耐烦 | 补：边分析边出结果，5 秒内先看到模块和入口 |
| 4 | 看总览 | 「原来是做这个的」 | 补：总览三块 |
| 5 | 查一条请求 | 「它真的懂 Spring」 | 已有泳道图；补图例和冗余编码 |
| 6 | 带追踪启动 | 怕把项目搞坏 | 补：先展示 diff 再确认；状态栏一个统一项「Atlas ● 4318 · 132 spans」 |
| 7 | 第二天再打开 | 希望不用重来 | 已有缓存；补过期提示条 |
时间维度：5 秒内看到项目是什么；5 分钟内能定位一条请求链路；长期靠 CodeLens 日常使用（不再依赖打开面板）。

### Pass 4 避免模板化：5/10 → 8/10
存在风险：总览容易做成「SaaS 卡片墙」，拓扑容易变成彩虹配色的边。约束（补入 spec）：
- 总览用三个**纵向分区**加原生列表，不使用卡片栅格、渐变或 emoji。
- 颜色只用 `--vscode-charts-*`（blue/green/yellow/orange/red/purple），最多 6 个类别。

### Pass 5 设计系统对齐：2/10 → 8/10
- 只能用 `--vscode-*` token：`editor-background`、`foreground`、`focusBorder`、`charts-*`、`contrastBorder`、`textLink-foreground`。**禁止硬编码颜色值**，用 lint 规则检查。
- 图标统一用 Codicons；字体用 `--vscode-font-family`、`--vscode-editor-font-family`（代码名称用等宽字体）。
- 在 Light、Dark、High Contrast、High Contrast Light 四种主题下各截一张图作为验收。

### Pass 6 响应式与无障碍：1/10 → 8/10
- **响应式**：面板宽度小于 600px 时，入口列表收起成下拉框，泳道图改为纵向。不适用移动端。
- **来源编码**（不只靠颜色，补入 spec）：
| 来源 | 线型 | 标记 | 未观测 | 已观测（运行时） |
|------|------|------|--------|-----------------|
| static | 实线 1px | ✓ | 正常 | 加粗为 2.5px，并标出 `p95` |
| framework-rule | 实线 1px | ⚙ | 正常 | 同上 |
| ai-inferred | 虚线 | ✨ + 置信度数字 | 正常 | 加粗并改为实线，保留 ✨ 和「已证实」 |
| runtime-observed（仅运行时） | 点线 2px | ● | — | 显示 `p95` |
- **键盘**：Tab 进入画布；方向键沿边移动到相邻节点；Enter 打开源码；Space 展开或折叠；`/` 聚焦搜索。每个节点有 `aria-label`，例如「SysUserController.list，控制器层，3 条出边」。
- **表格替代**：每张图都有「列表视图」开关，节点数超过 500 时默认使用列表。
- 热力图同时提供表格视图，悬停时显示具体数字。
- 遵循 `prefers-reduced-motion`。

### Pass 7 未决设计问题（自动裁决，记入审计表）
| 问题 | 裁决 | 依据 |
|------|------|------|
| 跨服务和多分支泳道怎么布局 | 每个服务一组泳道带，可折叠；接口有多个实现时显示「分支 ×N」，默认展开第一个，其余折叠；MQ 扇出时 topic 作为汇聚节点 | P5 |
| QPS / p95 的统计窗口 | 最近 15 分钟的滑动窗口；超过 15 分钟没有新数据时变灰，并显示 lastSeen | P5 |
| AI 输出语言 | 跟随 `vscode.env.language`（zh-cn → 中文，其他 → 英文），在 prompt 中固定，也可在设置中覆盖 | P5 |
| 跳转源码打开在哪里 | `ViewColumn.Beside` + `preserveFocus`，并高亮对应行 2 秒 | P5 |
| E2E 写 6 个视图，实际 8 个 | 改为 8 个 | 机械 |
| 导航用标签页还是侧边栏 | 原生 TreeView 加面板顶部标签页 | 品味决策 T5 的一部分 |

### 设计必需输出
- **不在范围内**：自定义品牌视觉、移动端、动画化 trace 回放（记入 TODOS，P3）。
- **已有资产**：VS Code 原生组件和主题 token、Codicons、`@xyflow/react` 内置的键盘支持（需要扩展）。

```
  +====================================================================+
  |         DESIGN PLAN REVIEW — COMPLETION SUMMARY                    |
  +====================================================================+
  | System Audit         | 无 DESIGN.md → 采用 VS Code 原生 token；有 UI  |
  | Step 0               | 4/10；全部 7 个维度                           |
  | Pass 1  (Info Arch)  | 3/10 → 9/10                                  |
  | Pass 2  (States)     | 2/10 → 9/10                                  |
  | Pass 3  (Journey)    | 3/10 → 8/10                                  |
  | Pass 4  (AI Slop)    | 5/10 → 8/10                                  |
  | Pass 5  (Design Sys) | 2/10 → 8/10                                  |
  | Pass 6  (Responsive) | 1/10 → 8/10                                  |
  | Pass 7  (Decisions)  | 6 resolved, 0 deferred                       |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (3 items)                            |
  | What already exists  | written                                      |
  | TODOS.md updates     | 1 item (trace 回放动画)                       |
  | Approved Mockups     | 0 generated（缺 OpenAI Key，改用 ASCII 线框）  |
  | Decisions made       | 6 added to plan + T5 待闸门                   |
  | Decisions deferred   | 0                                            |
  | Overall design score | 4/10 → 8.5/10                                |
  +====================================================================+
```

## Phase 2.5 — DX 评审（模式：DX POLISH）

### Step 0 DX 调研
- **产品类型**：开发者工具，包括 VS Code 扩展、npm 核心包和 CLI（E2）。
- **画像（推断）**：在中国企业做 Java 和 Vue 的后端或全栈工程师。日常处理 RuoYi/Jeecg 这类单体或 Spring Cloud 项目，经常接手别人的代码。用 IntelliJ 写 Java，用 VS Code 看前端和做杂项。对把代码发给境外 LLM 比较敏感。会用 DeepSeek、通义，或本地的 Ollama。
- **共情叙事（第一人称）**：「接手了一个 RuoYi-Cloud 项目，十几个服务。领导让我两天内搞清楚下单流程。装了 ProjectAtlas，点了分析……然后它让我选模型、填 Key。我只想先看看它能干什么，为什么一上来就要 Key？Key 填好了，弹出来『预计 180 万 token』，我吓得点了取消。取消之后它还能用吗？没人告诉我。后来我发现它把 `HttpUtils.sendPost` 封装的调用全漏了，因为我们公司的 HTTP 调用全走这个工具类，而我找不到任何地方能告诉它『这个方法就是 HTTP 调用』。」
- **竞品基准**：CodeViz（装完就出图，需要登录）、AppMap（装完要先录制，大约 5–10 分钟）。目标是 **Champion 档：2 分钟内**看到确定性地图，不需要 Key。
- **魔法时刻**：打开 RuoYi 后 60 秒内，在不配置任何 Key 的情况下，点开 `GET /system/user/list`，看到过滤器 → 拦截器 → 控制器 → Service → Mapper → SQL 的完整泳道图。实现方式：确定性阶段先渲染，状态栏和 CodeLens 提供入口，成本最低（P5）。
- **TTHW 评估**：按当前 spec 估算，不用 AI 约 2–5 分钟，但 spec 没有承诺无 Key 也能出图；用 AI 时约 10–30 分钟以上。**目标：无 Key 时 < 2 分钟。**

### 双声道 — DX
CODEX SAYS：`[codex-unavailable]`

CLAUDE SUBAGENT（独立评审）：
1. **High**：TTHW 没有承诺无 Key 也能出图 → 新增验收标准：零配置、无 Key、60 秒内出确定性地图；同时加 walkthrough。
2. **Critical**：没有命令 ID、设置项和 atlas.yaml schema；命名前缀不统一。
3. **High**：缺少错误契约（问题、原因、修复方法、文档链接）和错误码。
4. **High**：缺少文档信息架构、可直接复制的示例，以及规则贡献指南。
5. **Critical**：没有逃生口，用户无法纠正服务识别结果、增删边、声明自研封装（`HttpUtils.sendPost`、`MqSender`）、排除入口。
6. **Medium**：升级路径没有为 atlas.yaml、设置项、生成的 launch 配置和 diff 标注版本。

```
DX 双声道共识表：
═══════════════════════════════════════════════════════════════
  维度                                主审     子代理   共识
  ──────────────────────────────────── ──────── ─────── ─────────
  1. 5 分钟内上手？                    否(需补) 否      CONFIRMED
  2. API/CLI 命名可猜？                未定义   否      CONFIRMED（补命名表）
  3. 错误信息可操作？                  部分     否      CONFIRMED（补错误契约）
  4. 文档可查且完整？                  否       否      CONFIRMED
  5. 升级路径安全？                    部分     否      CONFIRMED
  6. 开发环境无摩擦？                  部分     部分    CONFIRMED（Ollama 模型、git 前置条件）
═══════════════════════════════════════════════════════════════
```

### 开发者旅程图
| 阶段 | 实际路径 | 摩擦点 | 裁决 |
|------|---------|--------|------|
| 发现 | Marketplace / Open VSX / GitHub / Gitee | 没有中文介绍 | T4 |
| 安装 | 一键安装 | 无 | — |
| 首次运行 | 打开工作区 → ? | 没有入口提示 | 补：检测到受支持的技术栈时，状态栏显示「Atlas：分析」，并弹一次非模态通知 |
| 第一次看到结果 | 确定性地图 | 没承诺无 Key 也能用 | 补验收标准 AC-DX1 |
| 接入 AI | 选 provider、填 Key | 没有流程 | 补 walkthrough + `atlas.testConnection` |
| 实际使用 | 浏览视图、搜索入口 | 自研封装的调用被漏掉 | 补 wrappers 逃生口 |
| 调试 | 结果不对 | 没法纠正，也没法报告 | 补 overrides、「标记此边错误」和诊断包 |
| 升级 | 扩展更新 | 生成的配置和 diff 过期 | 补 atlasVersion 标记 |
| 贡献 | 想支持一个新框架 | 没有指南 | 补 CONTRIBUTING 和规则模板（T3） |

### Pass 1 上手：3/10 → 9/10
理想顺序（补入 spec）：
1. 安装扩展（30 秒）
2. 打开项目，点状态栏「Atlas：分析」（RuoYi 在 30 秒内完成确定性阶段）
3. 自动打开总览，看到「AI 摘要未生成 · 配置模型（可选）」横幅

**新增 AC-DX1**：在没有配置任何 Key 的机器上打开 RuoYi-Vue，**60 秒内**能显示模块、入口、流转、启动和修改记录（不含 AI 摘要），而且这一过程中没有任何对外网络请求。

Ollama 的默认模型写入文档：`qwen2.5-coder:7b`。如果没有拉取，则提示 `ollama pull qwen2.5-coder:7b`。

### Pass 2 命名和配置：1/10 → 9/10
统一前缀 `atlas`（扩展显示名为 ProjectAtlas，目录为 `.atlas/`，忽略文件为 `.atlasignore`）。

| 命令 ID | 标题 |
|---------|------|
| `atlas.analyze` | Atlas：分析工作区 |
| `atlas.analyzeIncremental` | Atlas：增量更新 |
| `atlas.cancel` | Atlas：取消分析 |
| `atlas.openPanel` | Atlas：打开地图 |
| `atlas.revealInAtlas` | 在 Atlas 中定位（编辑器右键菜单） |
| `atlas.showFlowForSymbol` | 查看请求流转（CodeLens） |
| `atlas.configureProvider` | Atlas：配置模型 |
| `atlas.testConnection` | Atlas：测试模型连接 |
| `atlas.launchWithTracing` | Atlas：带追踪启动… |
| `atlas.revertTracingPatch` | Atlas：撤销追踪接入改动 |
| `atlas.exportHtml` / `atlas.exportMarkdown` | Atlas：导出（E1） |
| `atlas.diagnose` | Atlas：导出诊断包 |
| `atlas.clearCache` | Atlas：清除缓存 |

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| `atlas.llm.provider` | `"none"` | `none` / `anthropic` / `openai-compatible` / `ollama` |
| `atlas.llm.model` | provider 自带默认值 | |
| `atlas.llm.baseUrl` | provider 自带默认值 | OpenAI 兼容接口和 Ollama 需要 |
| `atlas.llm.maxInputTokens` | `2000000` | 单次分析上限 |
| `atlas.llm.concurrency` | `4` | |
| `atlas.llm.outputLanguage` | `"auto"` | 跟随 `vscode.env.language` |
| `atlas.analysis.exclude` | `[]` | 叠加在 `.atlasignore` 之上 |
| `atlas.analysis.maxFileSizeKB` | `2048` | |
| `atlas.runtime.enabled` | `true` | |
| `atlas.runtime.receiverPort` | `4318` | 端口被占用时自动换 |
| `atlas.runtime.retentionDays` / `maxSpans` | `7` / `100000` | |
| `atlas.crossService.enabled` | `true` | |
| `atlas.codeLens.enabled` | `true` | |

**`.atlasignore`**：采用 gitignore 语法。被它排除的文件**既不参与解析，也不会发给 LLM**。另外有 `atlas.llm.excludeFromAI`，只控制不发给 AI，但仍参与解析。

**`atlas.yaml`**（JSON Schema 放在 `schemas/atlas.schema.json`，通过 `yamlValidation` 注册）：
```yaml
version: 1
services:                       # 可选；不写时自动识别
  - name: ruoyi-system          # 覆盖自动识别出的服务名
    path: ./ruoyi-modules/ruoyi-system      # 和 git 二选一
    stack: java-spring          # 可选覆盖
    kind: backend
  - name: payment
    git: https://github.com/acme/payment.git
    ref: main                   # 分支、tag 或 commit
wrappers:                       # 自研封装声明（逃生口）
  - symbol: com.ruoyi.common.utils.http.HttpUtils.sendPost
    kind: http
    urlArg: 0                   # 第几个参数是 URL
    methodLiteral: POST
  - symbol: com.acme.mq.MqSender.send
    kind: mq
    broker: rocketmq
    topicArg: 0
edges:
  add:    [{ from: "SysUserController.list", to: "AuditService.log", note: "AOP 动态织入" }]
  remove: [{ from: "OrderService.pay", to: "LegacyPayClient.call" }]
ignoreEntrypoints: ["GET /actuator/**", "**/test/**"]
```
- Webview 中可以在任意边上点「标记为错误」，结果写入 `.atlas/overrides.yaml`（格式与 `edges.remove` 相同）。这个文件可以提交到 git，团队共享。
- **优先级**：atlas.yaml 中的 overrides > `.atlas/overrides.yaml` > 自动识别。
- **wrappers 的实现方式**：调用这些方法的地方会被当成相应框架的调用点，provenance 记为 `framework-rule`，并在 rationale 中注明「来自 atlas.yaml wrappers」。

### Pass 3 错误信息：3/10 → 9/10
**错误契约**：每个面向用户的错误都必须包含 `code`、`problem`、`cause`、`fix`、`docsUrl`，并提供「复制诊断信息」按钮。错误码表放在 `docs/errors.md`：

| 码 | 问题 | 修复 |
|----|------|------|
| ATLAS-E001 | 系统未安装 git | 安装 git 或在设置中指定 git 路径；修改记录视图降级 |
| ATLAS-E010 | 文件解析失败（N 个） | 查看诊断区；如果是生成代码，加入 `.atlasignore` |
| ATLAS-E020 | LLM 认证失败（401/403） | 运行 `atlas.configureProvider` |
| ATLAS-E021 | 连不上 Ollama | 运行 `ollama serve`；检查 baseUrl |
| ATLAS-E022 | 达到 token 上限 | 提高 `atlas.llm.maxInputTokens`，或排除目录 |
| ATLAS-E023 | 被限流 | 自动退避；降低 `atlas.llm.concurrency` |
| ATLAS-E030 | 克隆服务失败 | 检查地址和凭证；只允许 https 和 ssh |
| ATLAS-E040 | 端口无法监听 | 修改 `atlas.runtime.receiverPort` |
| ATLAS-E041 | javaagent 校验失败或无法离线下载 | 重试；离线环境可手动放置到提示的路径 |
| ATLAS-E042 | 未找到 Python venv | 选择解释器（使用 Python 扩展的 API） |
| ATLAS-E043 | Go 补丁冲突 | 重新生成 |
| ATLAS-E050 | 未识别到受支持的技术栈 | 查看支持列表；用 atlas.yaml 的 `stack` 手动指定 |

三条典型错误路径，现在看到的和应该看到的：
1. 填错 Key：现在没有定义 → 应显示「ATLAS-E020：Anthropic 返回 401（Key 无效或已撤销）。[重新配置] [文档]」，并且确定性地图照常可用。
2. Ollama 没启动：现在没有定义 → 应显示「ATLAS-E021：连不上 http://localhost:11434。运行 `ollama serve` 后重试。[重试]」。
3. 自研封装被漏掉：现在用户根本不知道漏了 → 在流转视图的「未解析的外部调用」区列出这些调用，并带上「声明为 wrapper」按钮，点击后生成 atlas.yaml 片段。

### Pass 4 文档：2/10 → 8/10
文档结构（`docs/`，同时提供中英文）：
- Quickstart
- 模型配置（含 Ollama、DeepSeek、通义的示例）
- 带追踪启动（Java、Python、Go 各一页）
- 多仓库与 atlas.yaml
- 逃生口：overrides 和 wrappers
- 隐私（哪些内容会发出、哪些永远不会）
- 错误码
- 规则贡献指南（新增一条规则 + 一个夹具 + 一份 `expected.json` 的完整示例）
- 架构

示例全部基于 RuoYi，可直接复制。

### Pass 5 升级：3/10 → 8/10
- `atlas.yaml` 带 `version`，旧版本会自动迁移，并显示弃用警告。
- 扩展激活时迁移旧的设置键。
- 生成的 launch 配置和 Go diff 都加上 `// atlas:generated v<x.y.z>` 标记；升级后检测到旧版本时，提示「重新生成 / 撤销」。
- 0.x 版本期间，破坏性变更只在 minor 版本发布，CHANGELOG 中写明。

### Pass 6 开发环境：5/10 → 8/10
- 三个平台都由 CI 覆盖（spec 已有）。
- 支持 Remote-SSH、WSL、Dev Containers：扩展作为 workspace 扩展运行，接收器监听在远端的 127.0.0.1。需要在文档里写明端口转发的行为。
- 代理：LLM 请求遵循 VS Code 的 `http.proxy` 设置。javaagent 支持离线手动放置（见 E041）。
- CLI（E2）提供 `--json` 和 `--no-ai`，在 CI 中可以非交互运行。

### Pass 7 社区与生态：4/10 → 7/10
- MIT 许可证，GitHub 为主，同时有 Gitee 镜像（T4）。Issue 模板会要求附上诊断包。
- 「规则贡献」是社区参与的主要入口。v0.1 采用**仓库内贡献**模式：`RuleSet` 接口加文档，加 CONTRIBUTING 指南。运行时动态加载第三方规则插件放到之后（T3 的折中方案）。

### Pass 8 DX 度量：1/10 → 6/10
- 默认不收集遥测，所以无法自动测量 TTHW。替代方案：
  - CI 中跑 TTHW 基准（AC-DX1 的 60 秒标准）；
  - 诊断包中记录各阶段耗时；
  - GitHub Discussions 里设一个反馈帖。
- v0.1 不做可选的遥测（记入 TODOS）。

```
+====================================================================+
|              DX PLAN REVIEW — SCORECARD                             |
+====================================================================+
| Dimension            | Score  | Prior  | Trend  |
|----------------------|--------|--------|--------|
| Getting Started      | 9/10   | 3/10   | ↑      |
| API/CLI/SDK          | 9/10   | 1/10   | ↑      |
| Error Messages       | 9/10   | 3/10   | ↑      |
| Documentation        | 8/10   | 2/10   | ↑      |
| Upgrade Path         | 8/10   | 3/10   | ↑      |
| Dev Environment      | 8/10   | 5/10   | ↑      |
| Community            | 7/10   | 4/10   | ↑      |
| DX Measurement       | 6/10   | 1/10   | ↑      |
+--------------------------------------------------------------------+
| TTHW                 | <2 min (无 Key) | 未承诺 | ↑      |
| Competitive Rank     | Champion（目标）                              |
| Magical Moment       | designed via 无 Key 确定性泳道图 + CodeLens   |
| Product Type         | VS Code 扩展 + npm 核心 + CLI                 |
| Mode                 | POLISH                                       |
| Overall DX           | 8/10   | 3/10   | ↑      |
+====================================================================+
| Zero Friction 覆盖 | Learn by Doing 覆盖 | Fight Uncertainty 覆盖 |
| Opinionated + Escape Hatches 覆盖 | Code in Context 覆盖(CodeLens) |
| Magical Moments 覆盖                                                |
+====================================================================+
```

### DX 实现检查清单
```
[ ] 无 Key 时 TTHW < 2 分钟（AC-DX1，CI 基准）
[ ] 一键安装；检测到技术栈后状态栏出现入口
[ ] 首次运行即可看到确定性地图
[ ] 魔法时刻：无 Key 时能看到 RuoYi 泳道图
[ ] 每个错误都有 code、problem、cause、fix、docsUrl
[ ] 命令和设置项都使用统一的 atlas.* 前缀
[ ] 所有设置项都有合理默认值（provider 默认为 none）
[ ] atlas.yaml 有 JSON Schema 和可复制的示例
[ ] overrides 和 wrappers 逃生口，以及「标记为错误」
[ ] 示例基于真实项目 RuoYi
[ ] 升级时给 atlas.yaml 和生成文件做版本迁移
[ ] core 包提供 TypeScript 类型
[ ] CLI 可在 CI 中非交互运行（--json --no-ai）
[ ] 免费：自带 Key，或用 Ollama 完全免费
[ ] 维护 CHANGELOG
[ ] 社区渠道：GitHub Discussions 和 Gitee
```

**不在范围内（DX）**：可选遥测、交互式在线 playground、运行时加载第三方规则插件（T3 折中方案中延后）。
**已有资产**：VS Code 的 walkthroughs、yamlValidation、SecretStorage、Python 扩展的解释器 API。

## Phase 3 — 工程评审（最后一道闸门，评审的是前面各阶段修改后的最终方案）

### Step 0 范围审视
1. **已有代码**：仓库里没有任何代码；外部可复用的资产见 CEO 0B。
2. **最小改动集**：用户已锁定 D7、D9、D11，autoplan 规则规定工程阶段不缩减范围（P2）。范围问题交给 U1 处理。
3. **复杂度检查**：会触发（新增服务/类远多于 2 个）。按 autoplan 覆盖规则，这里不在中途停下来，改为「不缩减，并把复杂度拆成可以并行的通道」（见并行化策略）。是否缩减的问题已经作为 U1 交给用户。
4. **检索核查（WebSearch）**：
   - [Layer 1] web-tree-sitter 默认在 JS 同目录查找 `tree-sitter.wasm`，打包后路径会变，**必须通过 `locateFile` 显式指定**；grammar 的 `.wasm` 也要由打包器复制到 `dist/`。[来源](https://cdn.jsdelivr.net/npm/web-tree-sitter@0.27.0/README.md)
   - [Layer 2] 第三方分析指出：一个 WASM 实例不能跨 worker 共享 → **每个 worker 各自 `Parser.init()` 并加载各自的 grammar**，worker 池大小 = min(4, CPU-1)。[来源](https://instagit.com/Egonex-AI/Understand-Anything/difference-web-tree-sitter-wasm-native-tree-sitter-parsing/)
   - [Layer 1] pyright 是纯 Node 实现，不需要 Python 环境，但**没有稳定的程序化 API**，只有 CLI 和 LSP 两种用法。[来源](https://github.com/barsi/pyright) → **修正 CEO 0B 中「把 pyright 当库用」的说法**：改为以子进程方式启动 `pyright-langserver --stdio`，通过 LSP 的 `textDocument/definition`、`callHierarchy/outgoingCalls` 取类型和调用信息。仍然是纯 Node，不引入原生依赖。T1 方案 C 照此更新。
5. **TODOS 交叉检查**：没有 TODOS.md，本阶段末尾新建。
6. **完整性**：方案选的是完整版本。
7. **分发**：要发布 .vsix（Marketplace 和 Open VSX）和 npm 包（core、cli）。CI 发布流程在 #13 和 CEO Section 9 中已有。目标平台：win32/darwin/linux 的 x64 和 arm64；因为没有原生依赖，**用一个通用 vsix 即可，不必按平台分别打包**。

### 双声道 — 工程
CODEX SAYS：`[codex-unavailable]`
CLAUDE SUBAGENT（独立评审）：
1. **Critical**：spec 没说核心跑在哪个进程 → 改用 worker 或子进程 + RPC + 取消；ELK 布局放进 webview 的 Web Worker。
2. **Critical**：SQLite 的原生绑定问题 → 改用 WASM 或 node:sqlite。
3. **High**：ID 不稳定，SymbolRef 以行号为锚 → 用哈希派生 ID，行号只作为元数据；SourceRef 增加 rootId。
4. **High**：每个入口各存一份 Flow，会重复存储共享的 Service 子图 → 改为一张全局调用图，Flow 只是其上的投影。
5. **High**：缓存键只有内容哈希 → 还要加入 analyzerVersion、规则集版本、prompt 版本和模型；schemaVersion 要有真正的迁移。
6. **Medium**：llmUsage 应改为数组。
7. **High（规模）**：整图通过 postMessage 传给 webview 太大；对每个文件都做 LLM 摘要成本爆炸；WASM 树不 `delete()` 会撑爆堆；GBK 编码、生成代码、浅克隆导致 AC6 无法成立。
8. **High（测试）**：macOS 和 Windows 的 CI runner 上跑不了 Linux docker；expected.json 维护会腐化（20 条抽样要固定随机种子，改为快照 + 审核过的 diff + 少量手工断言；AC3 按符号断言，不按行号）；还缺：取消、重入、缓存损坏、5 万文件合成生成器、畸形 yml、YAML 锚点、提示注入夹具、gzip 炸弹。
9. **Critical（安全）**：没有考虑 Workspace Trust；clone 需要加固（GIT_ALLOW_PROTOCOL、在 URL 前加 `--`、清理目录名）；OTLP 接收端可能被浏览器页面或 DNS rebinding 访问（要校验 Host、拒绝带 Origin 的请求、加会话 token、限制解压后的大小）；webview 注入；pip 应加 `--require-hashes`；Go 撤销时要连 go.sum 一起快照；METHODS_INCLUDE 会超过 Windows 32K 环境变量上限；源码中的密钥也需要脱敏。
10. **Critical（隐藏复杂度）**：确定接收者类型基本等于写一个类型检查器；Spring 的 DI 和 AOP 细节（@Bean、Lombok、AspectJ 切点、@PreAuthorize 属于方法拦截器）；占位符和网关改写（SpEL、宽松绑定、多文档 on-profile、Nacos shared/extension、Java 正则）；span 匹配（多数 span 没有 code.*、CGLIB 代理类名、MyBatis 动态 SQL）；增量失效必须沿依赖图传播，并且以子节点的**输入哈希**为键。
11. **Medium**：范围问题，建议先做 Spring + Vue（并入 U1）。

```
工程双声道共识表：
═══════════════════════════════════════════════════════════════
  维度                                主审     子代理   共识
  ──────────────────────────────────── ──────── ─────── ─────────
  1. 架构合理？                        补后是   补后是  CONFIRMED（A1–A12）
  2. 测试覆盖充分？                    补后是   缺口多  CONFIRMED（并入补充项）
  3. 性能风险已处理？                  是       是      CONFIRMED（枢纽采样、分页）
  4. 安全威胁已覆盖？                  部分     否      CONFIRMED（OTLP 加固为新增项）
  5. 错误路径已处理？                  是       部分    CONFIRMED
  6. 发布风险可控？                    是       部分    CONFIRMED（运行时 E2E 只在 Linux 跑）
═══════════════════════════════════════════════════════════════
```

**子代理新增、主审采纳的修改（机械决策，全部回写到 spec「评审修订」）**：
| # | 修改 | 原则 |
|---|------|------|
| ENG-A9 | 全局调用图 + Flow 投影（`Flow.stepIds`） | P5 |
| ENG-A10 | 缓存键 = 内容哈希 + analyzerVersion + rulesetVersion + promptVersion + model；上游摘要以子节点**输入哈希**为键（避免 LLM 输出不确定导致连锁失效） | P1 |
| ENG-A11 | `SourceRef`/`SymbolRef` 增加 `rootId`；`llmUsage` 改为数组 | 机械 |
| ENG-A12 | 每次解析后 `tree.delete()`；编码探测（BOM、UTF-8 校验失败时按 GBK 解码，使用纯 JS 的 iconv-lite） | P1 |
| ENG-A13 | **宁缺勿错**：接收者类型无法确定时不生成边，计入「未解析调用」并在 UI 中列出（DX 的「声明为 wrapper」入口也在这里）。精确率指标只针对已生成的边 | P5，回应「等于写类型检查器」的批评 |
| ENG-A14 | Spring 补充：`@Bean` 工厂方法、Lombok `@RequiredArgsConstructor`/`@AllArgsConstructor`（final 字段视为注入）、AspectJ 切点子集（`execution`、`@annotation`、`within`、`bean`），不支持的表达式记为 ai-inferred；`@PreAuthorize` 归为 interceptor 层 | P1 |
| ENG-A15 | 配置补充：多文档 YAML 的 `spring.config.activate.on-profile`、宽松绑定、Nacos `shared-configs`/`extension-configs`（含 namespace 和 group）；SpEL **不求值**，标记为未解析；网关 `RewritePath` 把 Java 正则子集转换为 JS 正则，转换失败时标记 | P1 |
| ENG-A16 | span 匹配优先级：`code.*` → 父子结构 + `http.route` → 规范化 CGLIB 代理类名（去掉 `$$SpringCGLIB$$...` 后缀）→ Mapper 方法 span（javaagent 已包含 Mapper 接口），**不靠 SQL 文本做指纹匹配** | P5 |
| ENG-A17 | OTLP 加固：校验 Host 必须为 `127.0.0.1:<port>` 或 `localhost:<port>`；拒绝带 `Origin` 的请求；每次会话生成随机 token，通过 `OTEL_EXPORTER_OTLP_HEADERS=x-atlas-token=...` 注入；请求体上限 4 MB，解压后上限 32 MB | 安全不可选 |
| ENG-A18 | clone 加固：`GIT_ALLOW_PROTOCOL=https:ssh`、URL 前加 `--`、`--no-recurse-submodules`，clone 目录名使用 `sha1(url)` | 安全 |
| ENG-A19 | 运行器加固：pip 使用扩展内置的带哈希 requirements 并加 `--require-hashes`；Go 撤销时同时快照 `go.mod`/`go.sum`，撤销前校验哈希；Java 方法清单写入 `otel.javaagent.configuration-file` 指向的属性文件（避免超出环境变量长度上限） | 安全 + P1 |
| ENG-A20 | LLM 结构化输出中的所有 id 必须在已知 ID 集合中，否则丢弃；webview 中的 markdown 先经 DOMPurify 清理 | 安全 |
| ENG-A21 | 脱敏范围扩展到源码中的高熵字符串和 `password=`/`secret`/`token` 赋值 | 安全 |
| ENG-T1 | 运行时 E2E 只在 Linux runner 上跑；macOS 和 Windows 只跑单元、集成和 vsix 冒烟测试（修订 AC#12 的表述） | 机械 |
| ENG-T2 | 黄金文件：机器生成快照 + PR 中人工审核 diff + 每个夹具 20 条固定种子抽样的手工断言（按符号断言，不按行号）；AC#3 改为按符号断言 | 机械 |
| ENG-T3 | 补充测试：取消和重入、缓存损坏、5 万文件合成仓库生成器（性能 CI）、畸形 pom/yml、YAML 锚点、gzip 炸弹 | P1 |
| ENG-T4 | AC#6 改为与 `git log --numstat -z -- <path>` 使用相同的语义比较；通过 atlas.yaml 浅克隆的服务不适用 AC#6，修改记录视图显示「浅克隆」 | 机械 |


### Section 1 架构
```
                       ┌──────────────── packages/vscode（扩展宿主，薄层）────────────────┐
  命令 / TreeView ───▶ │ AnalysisController ─(RPC: MessagePort)─▶ Analyzer Worker 池      │
  CodeLens / 状态栏    │ ProviderRegistry(SecretStorage)          (packages/core, N=min(4,CPU-1))
  Webview ◀─切片──────│ GraphStore(只读 .atlas/graph/*.json 分片)                          │
                       │ TraceService ─▶ OtlpReceiver(http, 127.0.0.1) ─▶ SpanStore(JSONL)  │
                       │ TracingLauncher ─▶ PatchManager(diff/撤销/atlas:generated 标记)    │
                       └────────────────────────────────────────────────────────────────────┘
  packages/core:
    ingest/ (walker, ignore, lang-detect, parser-pool[web-tree-sitter])
    symbols/ (Java, Go 符号表；Python → pyright-langserver 子进程适配器)
    detect/ (services, modules, startup)       config/ (占位符、profile、.env、compose、nacos-sql)
    flow/ (RuleSet: spring | vue | go | python；graph-builder；ant-matcher)
    xservice/ (http | gateway | frontend-proxy | mq | rpc；wrappers 来自 atlas.yaml)
    runtime/ (otlp-decode, span-index, merge)    git/ (log -z --numstat)
    llm/ (providers, budget, redact, map-reduce, evidence-check, cache)
    model/ (AtlasGraph, ids, schema, migrate)    overrides/ (atlas.yaml + .atlas/overrides.yaml)
  packages/cli (E2) ─▶ core       packages/webview ─▶ 只依赖 model 类型
```
| # | 问题 | 裁决 | 原则 |
|---|------|------|------|
| ENG-A1 | core 跑在扩展宿主主线程会卡住 VS Code 的所有扩展 | 解析和规则放进 worker 池；LLM 网络调用留在主线程（I/O 不占 CPU），用 AbortSignal 取消 | P5 机械 |
| ENG-A2 | 单个 graph.json 太大 | 按服务和视图分片：`graph/meta.json`、`graph/<serviceId>/{modules,entrypoints,flows}.json`；GraphStore 按需加载 | P5 机械 |
| ENG-A3 | 稳定 ID | `id = base32(sha1(kind + "\0" + serviceName + "\0" + canonicalKey)).slice(0,16)`。canonicalKey 示例：Java 为 `FQCN#method(paramTypes)`，HTTP 为 `METHOD path(规范化)`，MQ 为 `broker:topic`。**不含行号**，所以行号变化不影响 ID | P5 机械 |
| ENG-A4 | 增量失效链 | 文件哈希 → 文件摘要 → 所属模块摘要 → 功能清单。用依赖 DAG 记录「哪些下游用到了哪些上游的哈希」，失效时自下而上重算；规则结果按服务重算（一个服务内全量，速度够快）| P5 机械 |
| ENG-A5 | 多根工作区里同一个仓库被加两次，或者嵌套 | 按 realpath 去重；嵌套时外层排除内层路径 | 机械 |
| ENG-A6 | 扩展宿主有 local、remote（SSH/WSL/容器）和 web 三种 | `extensionKind: ["workspace"]`；**不支持 vscode.dev 网页版**（没有子进程、git 和端口），写入不在范围内 | P3 |
| ENG-A7 | pyright 子进程的生命周期 | 懒启动，分析完成后 60 秒内没有请求就退出；崩溃时把 Python 的类型解析降级为 A 方案（只用 tree-sitter），并在诊断中记录 | P1 |
| ENG-A8 | 分发 | 一个通用 vsix；core 和 cli 发到 npm；CI 中用 `vsce package` 加冒烟测试（在三个平台上安装后跑 RuoYi，满足 AC-DX1） | 机械 |

**生产环境失败场景**（每个集成点一条）：
- LLM：Ollama 7B 模型输出格式经常不合法 → 走 `LlmSchemaError` 重试路径；给 Ollama 单独设置 JSON mode（`format: "json"`）。
- git：Windows 上中文路径被 quotepath 转义 → 用 `-z` 输出加 `-c core.quotepath=off`。
- OTLP：Java agent 默认用 gRPC 4317 → 启动配置里**显式设置 `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`**，否则会一直收不到数据（隐性失败）。
- pyright：大型 Django 项目首次索引要几十秒 → 显示进度，超时（120 秒）后降级。
- 克隆：私有仓库需要凭证 → 使用系统 git 的凭证助手，扩展本身不处理凭证。

### Section 2 代码质量
| # | 问题 | 裁决 |
|---|------|------|
| ENG-Q1 | 四种语言的规则如果各写一套遍历，会大量重复 | `RuleSet` 接口 + 共用 graph-builder（CEO S5 已定）；外加**共用的 `PathPattern` 工具**（Ant 风格、gin `:id`、FastAPI `{id}`、Django `<int:id>`、Vue Router `:id` 都归一到同一个规范化路径表示），后端入口和前端请求的配对靠它完成 |
| ENG-Q2 | 占位符解析会在 Spring、compose、.env 各写一份 | 一个 `config/resolver.ts`，按来源分层，支持 `${a:${b:default}}` 嵌套并检测循环引用 |
| ENG-Q3 | 「证据」类型分散 | 统一用 `SourceRef`，所有 AI 产出都必须带 `evidence: SourceRef[]` 并经过 `evidence-check` 校验 |
| ENG-Q4 | 过度设计风险：规则插件 API | T3 折中：只保留内部接口，不做插件加载器 |
| ENG-Q5 | 设计不足风险：Spring DI 解析 | 明确算法：先按字段或参数的声明类型找实现类；有多个实现时，依次用 `@Primary`、`@Qualifier`/`@Resource(name)`、按字段名匹配 bean 名；仍有歧义就**生成多条分支边**（provenance=framework-rule，rationale 写「多实现」），不要随便选一个；`@ConditionalOn*` 不做求值，在 rationale 中注明 |
| ENG-Q6 | 需要内联 ASCII 图注释的文件 | `flow/graph-builder.ts`（构建流程）、`llm/map-reduce.ts`（失效 DAG）、`runtime/merge.ts`（匹配优先级）、`model/ids.ts` |

### Section 3 测试评审
**测试框架**：vitest（core、cli、webview 单测），@vscode/test-electron（扩展 E2E），Playwright 组件测试（webview 交互和键盘操作）。

```
 代码路径覆盖图（[→E2E] = 端到端，[→EVAL] = LLM 质量评估）
 ingest
   ├─ walker: 符号链接环 / 无权限 / .atlasignore / 超大文件 / 二进制 / 非 UTF-8        [unit ×8]
   └─ parser-pool: locateFile / worker 崩溃后重启 / 语法错误                         [unit ×4]
 detect
   ├─ modules: maven 多模块 / gradle / go.mod / pyproject / package.json workspaces      [unit ×6]
   ├─ services: 名称优先级 5 级 / atlas.yaml 覆盖                                       [unit ×6]
   └─ startup: 每条命令都要有证据；伪造的命令被丢弃                                      [unit ×5] [→EVAL]
 config/resolver: 嵌套占位符 / 默认值 / 循环引用 / profile / nacos sql                  [unit ×10]
 flow
   ├─ spring: mapping 数组 / 类前缀拼接 / Filter 顺序 / 拦截器 include+exclude / @Aspect 切点 / DI 5 级 / Mapper XML / MyBatis-Plus / Feign / @Scheduled / Listener   [unit ×25]
   ├─ vue: 静态路由 / RuoYi 动态路由 / api 函数 / baseURL / dev proxy                    [unit ×8]
   ├─ go: net/http / gin group / echo / chi / Use 链 / 接口多实现分支 / gorm             [unit ×12]
   ├─ python: FastAPI 前缀和 Depends / Flask bp 和 before_request / Django include 和中间件 / 非 HTTP 入口 / pyright 降级   [unit ×18]
   ├─ ant-matcher / PathPattern 规范化                                                  [unit ×15]
   └─ graph-builder: 环 / 深度截断 / 分支                                               [unit ×6]
 xservice: Feign / lb:// / 网关改写 / nginx / dev proxy / 4 种 MQ / gRPC / Dubbo / wrappers / 未解析 → AI 候选   [unit ×30] [→E2E ×7 夹具]
 runtime
   ├─ otlp-decode: protobuf / json / gzip / 过大请求 / 格式错误                         [unit ×6]
   ├─ merge: code.* 匹配 / route 降级 / db.statement / messaging / rpc / 仅运行时边      [unit ×10]
   └─ 接收器只绑定 loopback / 端口冲突                                                  [integration ×2]
 llm
   ├─ providers ×3: 认证错误 / 429 / 超时 / 非法 JSON / 拒答 / 中断                      [unit ×18，用录制回放]
   ├─ budget 预估、上限、确认                                                           [unit ×4]
   ├─ redact: .env / 高熵串 / yml 密钥 / 提示注入 README                                [unit ×8]
   ├─ map-reduce + 失效 DAG                                                             [unit ×6]
   └─ 摘要和功能质量                                                                    [→EVAL：6 个夹具，人工打分基线]
 git: -z numstat / rename / merge commit / 浅克隆 / 中文路径                            [unit ×6]
 overrides: edges add/remove / wrappers / ignoreEntrypoints / 优先级                    [unit ×8]
 tracing-launcher: Java env 注入 / Python venv / Go diff 生成、应用、撤销、冲突 / atlas:generated 标记   [unit ×10] [→E2E ×3]
 vscode: 命令注册 / 单例面板 / Workspace Trust 受限模式 / CodeLens / TreeView           [→E2E ×6]
 webview: 8 个视图的空/错/部分/过期状态 / 键盘遍历 / 列表替代视图 / 4 种主题            [component ×24] [截图 ×4]
 cli: --json / --no-ai / 退出码                                                          [integration ×3]
 保留集：3 个没见过的仓库（建议 Jeecg-boot、pig、一个 FastAPI 开源项目），只人工打分，不进 expected.json   [手动发布门]
```
- **黄金文件陷阱**：expected.json 由人工审核，**不能由工具生成后直接提交**（否则会把工具自身的 bug 固化为「正确答案」）。流程：工具生成候选 → 人工逐条核对 → 带上 `reviewedBy` 和 `commit` 一起提交。CI 中比对的差异要能读懂（按入口列出缺失和多出的边）。→ 补入。
- **2am 周五**：如果上游夹具仓库被删除或 force-push，CI 会挂 → 夹具以 tarball 形式按 sha256 缓存到 GitHub Release（只用于测试，许可证允许的前提下）。→ 补入。
- **回归规则**：每个修复过的规则缺陷都要配一个最小复现夹具，放在 `fixtures/regressions/<issue>`。
- **LLM 评估**：`[→EVAL]` 两项建立人工打分基线（功能清单准确性、启动命令正确性）。改动 prompt 时必须重跑，分数不能低于基线。
- **测试计划文件**已写入 `~/.gstack/projects/project-atlas/`。

### Section 4 性能
| 路径 | 规模 | 预算 | 措施 |
|------|------|------|------|
| 全量解析 5 万文件 | 约 500 万行 | < 90 s（4 核） | worker 池；AST 用完即释放；超过 2 MB 的文件跳过 |
| 符号表内存 | 50 万个符号 | < 600 MB | 字符串驻留（intern）；只存 FQN、位置和 kind |
| pyright 首次索引 | 大型 Django 项目 | < 120 s，否则降级 | 子进程；可以取消 |
| LLM map 阶段 | 5 万文件 | 默认**不对所有文件都做摘要**：只做入口、Service 等「枢纽文件」和每个模块按 PageRank 选出的前 20 个文件，其他文件只做规则分析 | 把 token 成本限制在 O(模块数)，而不是 O(文件数) → **补入** |
| span 合并 | 10 万个 span | < 2 s | 哈希索引 |
| Webview 渲染 | 500 节点 | 交互卡顿 < 200 ms | elkjs 放在 web worker 中布局；超过 500 节点改用列表视图 |

LLM 文件摘要采样是本阶段最重要的性能决策：否则 AC#8「增量 ≤ 5%」可以满足，但首次分析一个 5 万文件的仓库要上千万 token，用户用不起。属于机械决策（P1 + P3）。

### 不在范围内（工程阶段新增）
- vscode.dev 网页版
- 按平台分别打包 vsix
- 对 `@ConditionalOn*` 做求值
- SCIP 索引导入（TODOS）
- 用户机器上安装了 Go 工具链时用 go/types 增强（T1 方案 C 的可选部分，延后到 v0.2，v0.1 只用 tree-sitter 的方法集匹配加多实现分支）

### 已有资产
web-tree-sitter（需要 locateFile）、pyright-langserver（LSP 子进程）、opentelemetry-proto、elkjs、@xyflow/react、vitest、@vscode/test-electron、vsce/ovsx。

### 失败模式登记（工程阶段）
| 代码路径 | 失败 | 有测试？ | 有处理？ | 用户可见？ |
|---------|------|---------|---------|----------|
| OTLP 协议 | agent 默认用 gRPC，导致收不到数据 | 是（E2E） | 是（显式设为 http/protobuf） | 60 秒后提示 |
| parser-pool | 打包后找不到 wasm | 是（vsix 冒烟测试） | 是（locateFile） | ATLAS-E010 |
| pyright | 崩溃或超时 | 是 | 降级 | 诊断信息 |
| DI 多实现 | 随便选错一个实现 | 是 | 生成分支边 | 显示「分支 ×N」 |
| 黄金文件 | 工具 bug 被当成正确答案固化 | 流程保证 | reviewedBy | — |
| 夹具上游消失 | CI 挂掉 | 是 | tarball 缓存 | — |
| LLM 首次分析大仓库 | 成本爆炸 | 是（预算测试） | 枢纽文件采样 + 上限 | 确认框 |
**CRITICAL GAP：0**

### Worktree 并行策略
| 步骤 | 涉及模块 | 依赖 |
|------|---------|------|
| S1 model + ids + schema | core/model | — |
| S2 ingest + parser-pool | core/ingest | S1 |
| S3 config resolver + services/modules/startup | core/config, core/detect | S2 |
| S4 spring + vue 规则 | core/flow/spring, vue | S2 |
| S5 go 规则 | core/flow/go | S2 |
| S6 python 规则 + pyright 适配 | core/flow/python, core/symbols/python | S2 |
| S7 xservice | core/xservice | S3, S4–S6 |
| S8 llm | core/llm | S1 |
| S9 git | core/git | S1 |
| S10 runtime(otlp+merge) | core/runtime | S1（merge 部分依赖 S4–S7） |
| S11 webview | packages/webview | S1（使用 mock 数据） |
| S12 vscode 宿主 + launcher | packages/vscode | S1, S10 |
| S13 cli + export | packages/cli | S1 |
- **通道 A**：S1 → S2 → S4 → S7（关键路径）
- **通道 B**：S8、S9（S1 完成后立即开始）
- **通道 C**：S11（S1 完成后立即开始）
- **通道 D**：S5、S6（S2 完成后与 S4 并行）
- **通道 E**：S10 → S12
- **通道 F**：S3（S2 完成后开始）
- **通道 G**：S13
- **执行顺序**：S1 先单独合并（契约冻结）→ 并行启动 B、C、E 前半、G；S2 合并 → 并行启动 S3、S4、S5、S6；全部合并后做 S7 → S10 merge → 收口。
- **冲突提示**：S4/S5/S6 都会改动 `core/flow/graph-builder.ts` 的注册表 → 注册表改为每个 RuleSet 一个文件、自动发现（`flow/rules/index.ts` 由构建脚本生成），以避免冲突。

```
  +====================================================================+
  |              ENG PLAN REVIEW — COMPLETION SUMMARY                  |
  +====================================================================+
  | Step 0 Scope        | 复杂度触发 → 按 autoplan 规则不缩减；U1 交闸门 |
  | Search check        | 2 条已校正（locateFile、pyright 改为 LSP）     |
  | Architecture        | 8 issues（A1–A8），全部已裁决                 |
  | Code Quality        | 6 issues（Q1–Q6），全部已裁决                 |
  | Tests               | 覆盖图已产出；新增 3 条流程要求（黄金文件审核、夹具缓存、回归夹具）|
  | Performance         | 6 条预算；1 项关键决策（枢纽文件采样）        |
  | NOT in scope        | written (5 items)                            |
  | What already exists | written                                      |
  | Failure modes       | 7 total, 0 CRITICAL GAPS                     |
  | Parallelization     | 7 条通道，关键路径 S1→S2→S4→S7               |
  | Test plan artifact  | written                                      |
  +====================================================================+
```

<!-- AUTONOMOUS DECISION LOG -->
## 决策审计表

| # | 阶段 | 决策 | 分类 | 原则 | 理由 | 被否方案 |
|---|------|------|------|------|------|----------|
| 1 | Intake | 不补跑 /office-hours，以 spec 作为设计来源 | 机械 | P6 | spec 已包含问题陈述和备选方案 | 中途打断用户 |
| 2 | CEO | 模式采用 SELECTIVE EXPANSION | 机械 | autoplan 覆盖规则 | — | — |
| 3 | CEO | P3「四栈精确后再发 v0.1」作为 User Challenge U1 提交闸门 | User Challenge | — | 主评审和子代理都认为范围过大 | 自动裁决 |
| 4 | CEO | 类型解析采用方案 C（tree-sitter + pyright LSP + 规则） | 品味 T1 | P1+P5 | 不需要编译、无原生依赖 | B：SCIP/LSP 索引器 |
| 5 | CEO | 内部里程碑 M1（#1→#2→#8→#9→流转视图） | 机械 | P6 | 尽早验证架构，不改变发布门槛 | — |
| 6 | CEO | 接受 E1 导出 HTML/ATLAS.md | 机械 | P2 | 在影响范围内且 <1 天 | — |
| 7 | CEO | 接受 E2 CLI | 机械 | P2 | CI 跑夹具需要 | — |
| 8 | CEO | E3 问答对话 → TODOS | 机械 | P3 | 超出影响范围 | 加入 v0.1 |
| 9 | CEO | E4 MCP server | 品味 T2 | P2 vs P3 | 两位评审意见不一 | — |
| 10 | CEO | E5 规则插件：仓库内 RuleSet + CONTRIBUTING，不做运行时加载器 | 品味 T3 | P5 | 先把内置规则做扎实 | v0.1 就做加载器 |
| 11 | CEO | E6 AppMap 导入：跳过 | 机械 | P4 | 与 OTel 重复 | — |
| 12 | CEO | E7 GitHub Action → TODOS | 机械 | P3 | 依赖 E1/E2 | — |
| 13 | CEO | E8 中国生态定位（中文 README、Gitee、Jeecg/pig 夹具） | 品味 T4 | P1 | 仅子代理提出 | — |
| 14 | CEO | 补错误恢复登记表（17 条路径） | 机械 | P1 | 原 spec 缺失 | — |
| 15 | CEO | 补 4 项安全措施（注入、clone、Trust、CSP） | 机械 | 安全不可选 | — | — |
| 16 | CEO | 补 8 个交互边界情况 | 机械 | P1 | — | — |
| 17 | CEO | trace 存储由 SQLite 改为 JSONL | 机械 | P5 | 避免原生 ABI 问题 | better-sqlite3 |
| 18 | CEO | 补保留集人工评分（AC-HO） | 机械 | P1 | 防止对夹具过拟合 | — |
| 19 | CEO | 补诊断包命令 | 机械 | P2 | S 级 | — |
| 20 | Design | 改为总览优先，拓扑仅在多服务时显示 | 机械 | P5 | 单仓用户占多数 | 拓扑优先 |
| 21 | Design | 8 个视图的状态矩阵 | 机械 | P1 | — | — |
| 22 | Design | 原生 TreeView + CodeLens + 右键入口 | 品味 T5 | P2 | 约 0.5 个 CC 日 | 只有 Webview |
| 23 | Design | 设计系统 = VS Code token + Codicons | 机械 | P5 | 原生一致 | 自建品牌视觉 |
| 24 | Design | 来源编码不只靠颜色 + 键盘遍历 + 列表替代 | 机械 | P1 | 无障碍 | — |
| 25 | Design | 跨服务泳道按服务分组可折叠，多实现显示「分支 ×N」 | 机械 | P5 | — | — |
| 26 | Design | QPS/p95 使用 15 分钟窗口，超时变灰 | 机械 | P5 | — | — |
| 27 | Design | AI 输出语言跟随 vscode.env.language | 机械 | P5 | — | — |
| 28 | Design | 打开源码时放在侧边且不抢焦点（Beside + preserveFocus） | 机械 | P5 | — | — |
| 29 | Design | 缺少 OpenAI Key，用 ASCII 线框图代替视觉稿 | 机械 | — | 生成器不可用 | — |
| 30 | DX | 新增 AC-DX1：无 Key 60 秒出图 | 机械 | P5 | 达到 Champion 档 TTHW | — |
| 31 | DX | 统一 atlas.* 前缀，补命令和设置表 | 机械 | P5 | 一致优于花巧 | — |
| 32 | DX | atlas.yaml v1 schema + wrappers + overrides | 机械 | P1 | 逃生口被评为 Critical | — |
| 33 | DX | 错误契约 + ATLAS-Exxx | 机械 | P1 | — | — |
| 34 | DX | 文档信息架构 + CONTRIBUTING | 机械 | P1 | — | — |
| 35 | DX | 升级时为生成文件和配置标注版本 | 机械 | P1 | — | — |
| 36 | DX | 可选遥测 → TODOS，默认永久关闭 | 机械 | P3 | 隐私 | — |
| 37 | Eng | 复杂度检查触发后不缩减（交给 U1），改为拆分并行通道 | 机械 | autoplan 覆盖规则 | — | 中途停下 |
| 38 | Eng | worker 池 + locateFile + tree.delete | 机械 | P5 | 检索核实 | 在主线程解析 |
| 39 | Eng | pyright 改用 LSP 子进程 | 机械 | P5 | 没有稳定库 API（检索核实） | 当作库使用 |
| 40 | Eng | 图分片 + 全局调用图投影 | 机械 | P5 | 规模 | 单个 graph.json |
| 41 | Eng | 稳定 ID 去掉行号 + rootId | 机械 | P5 | — | — |
| 42 | Eng | 缓存键包含版本信息，摘要以子节点输入哈希为键 | 机械 | P1 | 避免连锁失效 | 只用内容哈希 |
| 43 | Eng | 宁缺勿错（未解析时不生成边） | 机械 | P5 | 精确率可兑现 | 强行猜一个 |
| 44 | Eng | Spring DI、AOP、Lombok、@Bean 细则 | 机械 | P1 | — | — |
| 45 | Eng | 配置解析细则（on-profile、Nacos shared，SpEL 不求值） | 机械 | P1 | — | — |
| 46 | Eng | span 匹配优先级，不按 SQL 文本匹配 | 机械 | P5 | — | — |
| 47 | Eng | OTLP 加固（Host、Origin、token、大小限制） | 机械 | 安全 | DNS rebinding | 只绑定 loopback |
| 48 | Eng | clone、pip、Go 补丁、Java 配置文件加固 | 机械 | 安全 | — | — |
| 49 | Eng | 显式设置 OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf | 机械 | P1 | 避免静默收不到数据 | — |
| 50 | Eng | LLM 只对枢纽文件做摘要 | 机械 | P1+P3 | 成本 O(模块数) | 对全部文件做摘要 |
| 51 | Eng | 运行时 E2E 只在 Linux 跑 | 机械 | — | macOS/Windows runner 不支持 Linux docker | 三平台都跑 |
| 52 | Eng | 黄金文件采用快照 + 审核 diff + 固定种子抽样；AC#3 按符号断言 | 机械 | P5 | 防止腐化 | 全量手工维护 |
| 53 | Eng | AC#6 语义对齐，浅克隆服务豁免 | 机械 | — | — | — |
| 54 | Eng | 不支持 vscode.dev，打包一个通用 vsix | 机械 | P3 | — | — |
| 55 | Eng | Go go/types 增强、SCIP 导入 → TODOS | 机械 | P3 | — | — |
| 56 | Eng | jq 未安装，跳过任务 JSONL 聚合，在闸门中直接列出任务 | 机械 | — | 工具缺失 | — |
| 57 | 闸门 | U1：用户采纳缩范围，v0.1 = Spring + Vue + RuoYi-Cloud 跨服务 + MCP | 用户裁决 | — | 用户在最终闸门选择 | 原 D7/D9/D11 |
| 58 | 闸门 | T1–T5 全部按推荐 | 用户裁决 | — | — | — |
| 59 | 闸门 | U1 修改后重跑工程 delta → CLEAR | 机械 | — | 闸门必须评审最终方案 | — |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | CLEAR (PLAN via /autoplan) | 8 proposals, 2 accepted + 3 taste（均已裁决）, 3 deferred；1 user challenge 被采纳 |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | Codex 未安装；4 个阶段都用 Claude 子代理替代 |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 (+U1 delta) | CLEAR (PLAN via /autoplan) | 31 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR (PLAN via /autoplan) | score: 4/10 → 8.5/10, 10 decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 1 | CLEAR (PLAN via /autoplan) | score: 3/10 → 8/10, TTHW: 未承诺 → <2 min |

- **CROSS-MODEL:** 仅有同一模型家族的子代理意见。跨阶段的共同主题：范围过大（CEO+Eng → U1 已采纳）；tree-sitter 精度有限（CEO+Eng → T1 + 宁缺勿错）；缺少纠错逃生口（Design+DX → overrides/wrappers）。
- **VERDICT:** CEO + ENG + DESIGN + DX CLEARED — ready to implement (v0.1 scope per 范围裁决 v1.2).

NO UNRESOLVED DECISIONS
