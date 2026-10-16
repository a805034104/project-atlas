# Error and diagnostic codes / 错误与诊断码

Every user-facing error shows **problem → cause → fix** and links here. Diagnostics (`I`, `W`) appear in the Overview "Diagnostics" section and in `Atlas: Export Diagnostics`.

每个面向用户的错误都会给出 **问题 → 原因 → 修复方法**，并链接到本页。诊断信息（`I`、`W`）显示在总览页的「诊断」区，也会写入「Atlas: 导出诊断包」。

| Code | Severity | Problem / 问题 | Fix / 修复 |
|---|---|---|---|
| <a id="atlas-e000"></a>ATLAS-E000 | error | Unexpected analysis failure / 分析意外失败 | Run `Atlas: Export Diagnostics` and attach the file to an issue / 导出诊断包并附在 issue 中 |
| <a id="atlas-e001"></a>ATLAS-E001 | warning | `git` is not installed or not on PATH; history view degrades / 未安装 git，修改记录视图降级 | Install git / 安装 git |
| <a id="atlas-e010"></a>ATLAS-E010 | warning | Some files could not be parsed / 部分文件解析失败 | Check the diagnostics list; add generated code to `.atlasignore` / 查看诊断列表；生成代码加入 `.atlasignore` |
| <a id="atlas-e020"></a>ATLAS-E020 | error | AI provider rejected the key (401/403) or no key stored; a 403 `forbidden / Request not allowed` means the request came from an unsupported region / Key 无效或未配置；403 `Request not allowed` 表示出口地区不受支持 | `Atlas: Configure AI Model` / 运行「配置模型」；地区受限时配置代理（VS Code `http.proxy`，CLI 设 `HTTPS_PROXY`） |
| <a id="atlas-e021"></a>ATLAS-E021 | error | AI provider unreachable (e.g. Ollama not running) / 连不上模型服务 | `ollama serve`, check `atlas.llm.baseUrl` / 启动 Ollama 并检查 baseUrl |
| <a id="atlas-e022"></a>ATLAS-E022 | warning | Token budget exceeded / 超过 token 上限 | Raise `atlas.llm.maxInputTokens` or exclude directories / 提高上限或排除目录 |
| <a id="atlas-e023"></a>ATLAS-E023 | info | Rate limited (429); Atlas backs off automatically / 被限流，自动退避 | Lower `atlas.llm.concurrency` / 降低并发 |
| <a id="atlas-e024"></a>ATLAS-E024 | warning | Network / timeout / 5xx after retries / 网络错误或超时 | Retry; cached results are reused / 重试，已完成部分会复用缓存 |
| <a id="atlas-e025"></a>ATLAS-E025 | warning | Model returned invalid JSON twice / 模型两次返回非法 JSON | Use a stronger model; the item is skipped / 换更强的模型；该项跳过 |
| <a id="atlas-e026"></a>ATLAS-E026 | warning | Model returned an empty answer or refused / 模型返回空内容或拒答 | Retry or switch model / 重试或换模型 |
| <a id="atlas-e030"></a>ATLAS-E030 | error | Cloning a service from `atlas.yaml` failed / 克隆服务失败 | Check URL and credentials; only `https://` and `git@` are allowed / 检查地址与凭证 |
| <a id="atlas-e050"></a>ATLAS-E050 | info | No supported stack detected / 未识别到受支持的技术栈 | See supported frameworks; set `stack` in `atlas.yaml` / 查看支持列表或在 atlas.yaml 指定 |
| <a id="atlas-i001"></a>ATLAS-I001 | info | Folder is not a git repository / 不是 git 仓库 | — |
| <a id="atlas-i002"></a>ATLAS-I002 | info | Shallow clone: history incomplete / 浅克隆，历史不完整 | `git fetch --unshallow` |
| <a id="atlas-i003"></a>ATLAS-I003 | info | Symbolic link skipped / 跳过符号链接 | — |
| <a id="atlas-i004"></a>ATLAS-I004 | info | A `git` service in atlas.yaml was not cloned (CLI never clones) / atlas.yaml 中的远程服务未克隆 | Clone it and add as `path`, or analyze in VS Code / 手动克隆并改用 `path`，或在 VS Code 中分析 |
| <a id="atlas-e060"></a>ATLAS-E060 | error | CLI usage error / 命令行用法错误 | `project-atlas --help` |
| <a id="atlas-e061"></a>ATLAS-E061 | error | CLI path not found / 路径不存在 | Check the path argument / 检查路径参数 |
| <a id="atlas-e062"></a>ATLAS-E062 | error | No or corrupt `.atlas` store (CLI `show`, MCP) / 没有或损坏的 .atlas 数据 | `project-atlas analyze` or `Atlas: Analyze Workspace` |
| <a id="atlas-e063"></a>ATLAS-E063 | error | Entrypoint not found or ambiguous / 入口不存在或不唯一 | Use the id or the exact `METHOD /path` label |
| <a id="atlas-e064"></a>ATLAS-E064 | error | Cannot write output / 无法写入输出 | Check permissions / 检查权限 |
| <a id="atlas-e065"></a>ATLAS-E065 | error | CLI analysis failed / 命令行分析失败 | Re-run with `--json` and attach output to an issue |
| <a id="atlas-e070"></a>ATLAS-E070 | error | Downloading the OpenTelemetry javaagent 2.31.1 failed from every source (Maven Central, Aliyun mirror) / 所有来源都下载失败 | Download it manually (the message shows `curl` / `Invoke-WebRequest` commands and the sha256) and set `atlas.runtime.javaagentPath` or `ATLAS_JAVAAGENT_PATH` / 手动下载后设置路径 |
| <a id="atlas-e071"></a>ATLAS-E071 | error | The javaagent file does not match the pinned sha256 (often a proxy login page saved as the jar) / 文件 sha256 不符（常见原因：代理把登录页存成了 jar） | Delete it and retry, or download the exact release yourself / 删除后重试，或自行下载对应版本 |
| <a id="atlas-e072"></a>ATLAS-E072 | error | The command already loads another javaagent (SkyWalking, Arthas…) / 命令里已经有另一个 javaagent | Remove it for this run, or confirm loading both (`--allow-agent-conflict` in the CLI) / 本次去掉，或确认叠加 |
| <a id="atlas-e073"></a>ATLAS-E073 | error | Tracing is unavailable: Restricted Mode, or `atlas.runtime.enabled` is off / 受限模式或设置关闭了追踪 | Trust the workspace / enable the setting / 信任工作区或打开设置 |
| <a id="atlas-e074"></a>ATLAS-E074 | error | The trace receiver could not start, or another process (CLI / window) already receives for this workspace / 接收器无法启动，或已被另一个进程占用 | Stop the other process (its traces stay as history) or pick another `atlas.runtime.port` / 停止另一个进程，或换端口 |
| <a id="atlas-e082"></a>ATLAS-E082 | error | Web app: the folder cannot be imported (missing, a file, unreadable, relative, or a network/UNC path) / 网页版：无法导入该文件夹（不存在、是文件、无权限、相对路径或网络路径） | Paste an absolute local folder path, e.g. `D:\code\RuoYi-Vue`; copy network projects to a local folder first / 粘贴本机文件夹的绝对路径；网络共享上的项目先复制到本地 |
| <a id="atlas-i010"></a>ATLAS-I010 | info | Preferred receiver port was taken; the next free one is used / 首选端口被占用，已顺延 | — (the status bar shows the actual port) |
| <a id="atlas-w030"></a>ATLAS-W030 | warning | Requests to the receiver were rejected (foreign Host, browser Origin, wrong token) / 接收器拒绝了请求 | Usually a stale app from an old session: restart it with fresh VM options; details in `Atlas: Export Diagnostics` / 多为旧会话里启动的应用，重新复制 VM 参数后重启 |
| <a id="atlas-w031"></a>ATLAS-W031 | warning | A payload or file is not a valid OTLP trace export / 不是有效的 OTLP 数据 | Use `http/protobuf` (default) or OTLP/JSON; `trace import` takes ExportTraceServiceRequest files / 使用 http/protobuf 或 OTLP/JSON |
| <a id="atlas-w033"></a>ATLAS-W033 | warning | No spans within 60 s of starting / 启动 60 秒内没有收到 span | Check the service log shows the OpenTelemetry agent banner, the VM options are applied, and 127.0.0.1 is not proxied (`http.nonProxyHosts`) / 检查 agent 启动日志、VM 参数是否生效、127.0.0.1 是否被代理 |
| <a id="atlas-w035"></a>ATLAS-W035 | warning | Span keys that match no step, or match several overloads (never guessed) / span 匹配不到步骤，或匹配到多个重载 | Listed in the Trace tab "Static vs observed" section; re-analyze if the code changed / 见 Trace 标签页「静态 vs 实测」；代码改过就重新分析 |
| <a id="atlas-w001"></a>ATLAS-W001 | warning | git output exceeded 200 MB and was truncated / git 输出超过上限被截断 | Reduce modules or history window |
| <a id="atlas-w002"></a>ATLAS-W002 | warning | Directory not readable / 目录无法读取 | Check permissions / 检查权限 |
| <a id="atlas-w003"></a>ATLAS-W003 | warning | File larger than `atlas.analysis.maxFileSizeKB` skipped / 文件过大被跳过 | Raise the limit if needed / 需要时调大上限 |
| <a id="atlas-w010"></a>ATLAS-W010 | warning | Unsupported AspectJ pointcut; the advice is not drawn / 不支持的切点表达式 | Supported: `execution`, `within`, `@annotation`, `@within`, `@target`, `bean`, `||`, `&&`, `!`; add the edge via `atlas.yaml` |
| <a id="atlas-w020"></a>ATLAS-W020 | warning | Invalid `atlas.yaml` entry (ignored) / atlas.yaml 条目无效 | Fix the entry; the schema is validated in the editor |
| <a id="atlas-w021"></a>ATLAS-W021 | warning | `atlas.yaml` edge refers to unknown steps / 边引用的步骤不存在 | Use names shown in the flow view (e.g. `SysUserController.list`) |
| <a id="atlas-w034"></a>ATLAS-W034 | warning | MQ destination (topic / queue / stream key / binding) could not be resolved; no link drawn / 消息队列目的地无法解析，未连线 | Use a literal, a constant or a `${}` placeholder present in config, or declare an `mq` wrapper in `atlas.yaml` |
| <a id="atlas-ai01"></a>ATLAS-AI01 | warning | Some AI requests failed; map is partial / 部分 AI 请求失败 | Re-run analysis; successful results are cached |
| <a id="atlas-ai02"></a>ATLAS-AI02 | info | Evidence check dropped AI items without repository evidence / 证据校验丢弃了无出处的 AI 结果 | — (by design: no fabricated commands or features) |
| <a id="atlas-ai03"></a>ATLAS-AI03 | info | Files excluded from AI (secrets list) / 因敏感被排除的文件 | — |

Reserved for v0.2 runtime tracing / 预留给 v0.2 运行时追踪: ATLAS-E040 (receiver port), E041 (javaagent integrity), E042 (Python venv), E043 (Go patch conflict).
