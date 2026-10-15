# ProjectAtlas

中文 · **[English](README.md)**

在 VS Code 里打开一个 Spring / Vue / 若依项目，一分钟内看到它的项目地图：

- **模块与服务**：Maven 模块、Spring Boot 应用（服务名取自 `spring.application.name`，包括以 SQL 导出的 Nacos 配置）、Vue 应用。
- **请求流转（关键部分精确）**：`GET /system/user/list` → 开发代理 → Spring Cloud Gateway 路由（`StripPrefix`）→ `JwtAuthenticationTokenFilter` → `RepeatSubmitInterceptor` → `@PreAuthorize` → `SysUserController.list` → `@DataScope` 切面 → `SysUserServiceImpl.selectUserList` → `SysUserMapper` → `<select id="selectUserList">`。
- **跨服务链路**：前端 → 代理 → 网关 → 服务、Feign、RestTemplate。
- **启动方式**：前置依赖、命令、端口，每一条都标出来源文件和行号。
- **修改记录**：按模块统计 git 历史，可选 AI 演进摘要。
- **可选 AI**：自带 Key，支持 Anthropic、任意 OpenAI 兼容接口（DeepSeek、通义等）或本地 Ollama，用于生成模块摘要和功能清单。发送任何内容之前，都会先按阶段列出 token 数和费用预估，等你确认。

规则优先：流转图中的每条实线都来自代码和框架语义，AI 推断的边用虚线并加标记。判断不出调用了哪个方法时，宁可不画，而是把它列在「未解析调用」里。公司内部封装的 HTTP 工具类可以在 `atlas.yaml` 中声明。

## 快速开始

1. 在 VS Code Marketplace 或 Open VSX 安装 **ProjectAtlas**。
2. 打开项目，点击状态栏的 **Atlas: 分析**，不需要任何 Key。
3. 可选：运行 **Atlas: 配置模型**。

命令行：`npx project-atlas analyze . --no-ai --markdown ATLAS.md` · 供编码助手使用的 MCP：`atlas-mcp --dir .atlas`。

## v0.1 支持范围

| 领域 | 支持 |
|---|---|
| Java | Spring MVC / Boot：`@RestController`、各类 Mapping 注解（常量和 `${}` 会被解析）、Servlet 过滤器（Spring Security 顺序、`FilterRegistrationBean` 的 URL 模式）、`HandlerInterceptor`（Ant 规则的 include / exclude）、`@PreAuthorize` / `@Secured`、AspectJ（`execution`、`within`、`@annotation`、`bean` 等）、依赖注入（`@Primary`、`@Qualifier`、`@Resource`、Lombok 构造器，多个实现以分支显示）、MyBatis Mapper XML、MyBatis-Plus `BaseMapper`、`@Scheduled` |
| Spring Cloud | 网关路由（`Path`、`StripPrefix`、`RewritePath`、`PrefixPath`、全局过滤器）、以 SQL 导出的 Nacos 配置（shared / extension 配置、profile）、OpenFeign、使用 `lb://` 或服务名的 RestTemplate / WebClient |
| Vue | Vue 2/3、`src/api` 中的请求函数（`request({url, method})`、`axios.get`）、页面、路由表、若依 `sys_menu` 动态路由、Vite / Vue CLI 开发代理 |
| 后续版本 | v0.2 本地运行时追踪 + 消息队列（Redis Stream、Kafka、RabbitMQ、RocketMQ）· v0.3 Go · v0.4 Python + Dubbo / gRPC |

## 隐私

分析全部在本地运行。即使配置了 AI，也只有在你确认后，才会发送「枢纽文件」（Controller、Service、每个模块最重要的文件）的内容去生成摘要。`.env*`、密钥文件、keystore 永远不会发送，文件内的密码和 token 会被打码。代码一律作为不可信数据包裹，模型也没有任何工具调用能力。不收集遥测数据。

## 文档

[错误码](docs/errors.md) · [架构](docs/architecture.md) · [贡献框架规则](CONTRIBUTING.md) · [规格说明](docs/spec.md)

MIT 许可证。
