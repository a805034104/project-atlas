# ProjectAtlas

中文 · **[English](README.md)**

[![ci](https://github.com/a805034104/project-atlas/actions/workflows/ci.yml/badge.svg)](https://github.com/a805034104/project-atlas/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/a805034104/project-atlas)](https://github.com/a805034104/project-atlas/releases)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/a805034104/project-atlas/blob/main/LICENSE)

**在 VS Code 里看懂一个 Spring / Vue / 若依项目。** 打开仓库、点「分析」，一分钟内就能顺着任意一个请求，从 Vue 页面一路看下去：网关、过滤器、拦截器、切面、Controller、Service、Mapper，直到 SQL 语句。每一步都能点回源码的文件和行号。

![若依 Cloud 中 GET /system/user/list 的请求流转](https://github.com/a805034104/project-atlas/raw/main/docs/images/flow.zh.png)

<sub>[RuoYi-Cloud](https://gitee.com/y_project/RuoYi-Cloud) 的真实分析结果：`GET /system/user/list` 从前端 `listUser()` 出发，经过网关 `AuthFilter` / `XssFilter` 和路由、`@PreAuthorize`、`SysUserController.list`、`@DataScope` 切面、`SysUserServiceImpl`，直到 Mapper XML 里的 `<select>`。</sub>

## 为什么做这个

接手一个大的 Spring Cloud 项目，光是回答几个简单问题就要读一周代码：这个接口前面跑了哪些过滤器？这个页面调的是哪个服务？谁在写这张表？普通的代码搜索不懂 Spring Security 的过滤器顺序、拦截器的 Ant 路径匹配、AspectJ 切点、网关的 `StripPrefix`、Feign 客户端和 MyBatis XML，ProjectAtlas 懂。

- **规则优先，AI 可选。** 图上每一条实线都由代码和框架语义推导出来。分析器判断不了实际调用哪个方法时（接口有多个实现、参数分不清的重载、动态 topic），宁可不画，把这次调用放进「未解析的调用」。AI 推断的边用虚线并标注出来。
- **运行时印证静态图。** 用 OpenTelemetry javaagent 启动服务，图上会标出哪些步骤真的执行了、执行了几次、p95 耗时多少。
- **默认只在本机。** 分析在你的电脑上完成，没有任何遥测。不配置 key 就不会用 AI；配置之后，每次发送前也会先显示费用估算。

## 功能

| | |
|---|---|
| **请求流转** | 前端调用 → 开发代理 → Spring Cloud Gateway（路由、`StripPrefix`/`RewritePath`、全局过滤器）→ 按 Spring Security 顺序排列的过滤器 → `HandlerInterceptor`（Ant 路径包含/排除）→ `@PreAuthorize` → AspectJ 通知 → Controller → Service（依赖注入支持 `@Primary`、`@Qualifier`、`@Resource`，多个实现画成分支）→ MyBatis Mapper XML / MyBatis-Plus → SQL |
| **跨服务链路** | 前端 → 网关 → 服务、OpenFeign、带 `lb://` 的 RestTemplate / WebClient，以及消息队列：Kafka、RabbitMQ（direct / topic / fanout / 默认交换机、死信延迟队列）、RocketMQ tag、Redis Stream、Spring Cloud Stream |
| **运行时对账** | 固定版本的 OpenTelemetry javaagent 2.31.1（校验 sha256）。步骤、调用边和跨服务链路标注「次数 · p95 · 错误数」；Trace 标签页带瀑布图；只在运行时出现的调用会单独列出，不会被当成猜测画进图里 |
| **启动指南** | 前置依赖（JDK、MySQL、Redis、Nacos…）、构建和启动命令、端口，每一条都标出来源文件和行号 |
| **模块与修改记录** | Maven 模块、Spring Boot 应用（服务名取自 `spring.application.name`，支持以 SQL 导出的 Nacos 配置）、Vue 应用；按模块统计 git 历史 |
| **可选 AI** | 模块摘要和功能清单，支持 Anthropic、任意 OpenAI 兼容接口（DeepSeek、通义千问…）或本地 Ollama。key 存在 VS Code SecretStorage 里；`.env` 和密钥文件从不发送，文件里的密钥会先打码 |
| **CLI 与 MCP** | `project-atlas analyze` / `show` / `trace` 可在终端和 CI 里用；只读的 MCP 服务让 AI 编程助手直接查询经过验证的调用链，不用靠猜 |

![运行时叠加：GET /system/user/list 的每一步都被观测到，并标出耗时](https://github.com/a805034104/project-atlas/raw/main/docs/images/flow-runtime.zh.png)

<sub>若依 Vue 版真实运行一次后的叠加效果：每个步骤和每条边都标出执行次数和 p95 耗时。</sub>

<table><tr>
<td><img src="https://github.com/a805034104/project-atlas/raw/main/docs/images/overview.zh.png" alt="总览"></td>
<td><img src="https://github.com/a805034104/project-atlas/raw/main/docs/images/startup.zh.png" alt="启动指南"></td>
</tr><tr>
<td align="center"><sub>总览：服务、模块、入口、怎么启动</sub></td>
<td align="center"><sub>启动指南，每条都有出处</sub></td>
</tr></table>

## 安装

目前还没有上架 VS Code 插件市场。

1. 从 [Releases](https://github.com/a805034104/project-atlas/releases) 下载 `project-atlas-<版本>.vsix`。
2. 在 VS Code 里：扩展 ▸ `…` ▸「从 VSIX 安装…」（或 `code --install-extension project-atlas-0.2.1.vsix`）。
3. 打开一个 Spring / Vue 项目，执行 **Atlas: Analyze**（状态栏或命令面板），不需要任何 key。

需要 VS Code 1.95 及以上。运行时追踪另外需要你的应用本身能用 JDK 8 及以上启动。

### 从源码构建

```bash
git clone https://github.com/a805034104/project-atlas.git
cd project-atlas
npm ci && npm run build          # Node.js 20+
npx vitest run                   # 可选：跑测试
node packages/cli/dist/bin.js analyze /path/to/your/project --no-ai
```

在 VS Code 里打开 `packages/vscode` 后按 F5，就能在开发宿主里运行插件。

## 使用

**VS Code 里**：执行 *Atlas: Analyze*，然后浏览各个标签页：总览、拓扑、模块、功能、启动、流转、修改记录、Trace。Controller 方法上方的 CodeLens 可以直接打开该接口的流转图。「导出 HTML」会生成一个离线可看的单文件，方便分享。

**CLI**

```bash
project-atlas analyze . --no-ai --markdown ATLAS.md     # 分析并输出 Markdown 版项目地图
project-atlas show "GET /system/user/list"              # 在终端打印一条流转
project-atlas trace -- mvn spring-boot:run              # 带 javaagent 启动，结束后打印观测结果
project-atlas trace --print-config                      # 打印可粘贴到 IDEA 的 VM 参数
```

（从源码运行时，`project-atlas` 即 `node packages/cli/dist/bin.js`。）

**MCP**：`atlas-mcp --dir .atlas` 通过 stdio 向 AI 编程助手提供入口、流转、跨服务链路和运行时聚合数据（从不返回 span 的属性值）。

**运行时追踪**：执行 *Atlas: Copy VM Options for Tracing*，把 VM 参数粘贴到 IDE 的运行配置里，重启服务后发一个请求即可。span 只发到 127.0.0.1 上的接收器；SQL 文本、请求体和 header 一律不存。详见 [docs/runtime-tracing.md](https://github.com/a805034104/project-atlas/blob/main/docs/runtime-tracing.md)。

## 支持范围

| 方面 | 支持 |
|---|---|
| Java | Spring MVC / Boot 2–3：映射注解（常量和 `${}` 会被解析）、过滤器（含 `FilterRegistrationBean` 的 url 匹配）、拦截器、`@PreAuthorize`/`@Secured`、AspectJ（`execution`、`within`、`@annotation`、`bean`…）、依赖注入（含 Lombok 构造器）、MyBatis XML、MyBatis-Plus `BaseMapper`、`@Scheduled` |
| Spring Cloud | Gateway 路由和过滤器、以 SQL 导出的 Nacos 配置（共享/扩展配置、profile）、OpenFeign、RestTemplate / WebClient |
| Vue | Vue 2/3、`src/api` 请求封装、页面、路由表、若依 `sys_menu` 动态路由、Vite / Vue CLI 开发代理 |
| 消息队列 | Kafka、RabbitMQ、RocketMQ、Redis Stream、Spring Cloud Stream；解析不了的目的地会列出来，不会瞎猜 |
| 运行时（Java） | 过滤器、拦截器、切面、Controller、Service、MyBatis Mapper、SQL；HTTP/Feign、Kafka、RabbitMQ、RocketMQ、Redis Stream 链路在运行时印证 |
| 实测项目 | RuoYi-Vue、RuoYi-Cloud（含 Vue 3 前端）、pig、JeecgBoot、mall-swarm |
| 后续计划 | Go + gRPC、Python + Dubbo、导入 SkyWalking / Arthas 的 trace |

## 原理

tree-sitter（WASM）把 Java、JS/TS、Vue 文件解析成逐文件的事实（按内容哈希缓存）。框架规则把这些事实组装成一张由步骤和边构成的图，ID 稳定；每个入口的流转是这张图上的投影。运行时部分是一个 OTLP 接收器加一个对账器，把 span 映射到步骤上，不改动已保存的图。详见 [docs/architecture.md](https://github.com/a805034104/project-atlas/blob/main/docs/architecture.md)。

## 参与贡献

最有用的是带最小复现（或公开仓库链接）的 bug 报告。如何新增一条框架规则见 [CONTRIBUTING.md](https://github.com/a805034104/project-atlas/blob/main/CONTRIBUTING.md)，每条规则都要附带样例项目和测试。安全问题请私下报告，见 [SECURITY.md](https://github.com/a805034104/project-atlas/blob/main/SECURITY.md)。

## 文档

[运行时追踪](https://github.com/a805034104/project-atlas/blob/main/docs/runtime-tracing.md) · [错误码](https://github.com/a805034104/project-atlas/blob/main/docs/errors.md) · [架构](https://github.com/a805034104/project-atlas/blob/main/docs/architecture.md) · [更新日志](https://github.com/a805034104/project-atlas/blob/main/CHANGELOG.md) · [规格](https://github.com/a805034104/project-atlas/blob/main/docs/spec.md) · [v0.2 规格](https://github.com/a805034104/project-atlas/blob/main/docs/spec-v0.2.md)

## 许可证

[MIT](https://github.com/a805034104/project-atlas/blob/main/LICENSE)
