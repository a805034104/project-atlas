# Error and diagnostic codes / 错误与诊断码

Every user-facing error shows **problem → cause → fix** and links here. Diagnostics (`I`, `W`) appear in the Overview "Diagnostics" section and in `Atlas: Export Diagnostics`.

每个面向用户的错误都会给出 **问题 → 原因 → 修复方法**，并链接到本页。诊断信息（`I`、`W`）显示在总览页的「诊断」区，也会写入「Atlas: 导出诊断包」。

| Code | Severity | Problem / 问题 | Fix / 修复 |
|---|---|---|---|
| <a id="atlas-e000"></a>ATLAS-E000 | error | Unexpected analysis failure / 分析意外失败 | Run `Atlas: Export Diagnostics` and attach the file to an issue / 导出诊断包并附在 issue 中 |
| <a id="atlas-e001"></a>ATLAS-E001 | warning | `git` is not installed or not on PATH; history view degrades / 未安装 git，修改记录视图降级 | Install git / 安装 git |
| <a id="atlas-e010"></a>ATLAS-E010 | warning | Some files could not be parsed / 部分文件解析失败 | Check the diagnostics list; add generated code to `.atlasignore` / 查看诊断列表；生成代码加入 `.atlasignore` |
| <a id="atlas-e020"></a>ATLAS-E020 | error | AI provider rejected the key (401/403) or no key stored / Key 无效或未配置 | `Atlas: Configure AI Model` / 运行「配置模型」 |
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
| <a id="atlas-w001"></a>ATLAS-W001 | warning | git output exceeded 200 MB and was truncated / git 输出超过上限被截断 | Reduce modules or history window |
| <a id="atlas-w002"></a>ATLAS-W002 | warning | Directory not readable / 目录无法读取 | Check permissions / 检查权限 |
| <a id="atlas-w003"></a>ATLAS-W003 | warning | File larger than `atlas.analysis.maxFileSizeKB` skipped / 文件过大被跳过 | Raise the limit if needed / 需要时调大上限 |
| <a id="atlas-w010"></a>ATLAS-W010 | warning | Unsupported AspectJ pointcut; the advice is not drawn / 不支持的切点表达式 | Supported: `execution`, `within`, `@annotation`, `@within`, `@target`, `bean`, `||`, `&&`, `!`; add the edge via `atlas.yaml` |
| <a id="atlas-w020"></a>ATLAS-W020 | warning | Invalid `atlas.yaml` entry (ignored) / atlas.yaml 条目无效 | Fix the entry; the schema is validated in the editor |
| <a id="atlas-w021"></a>ATLAS-W021 | warning | `atlas.yaml` edge refers to unknown steps / 边引用的步骤不存在 | Use names shown in the flow view (e.g. `SysUserController.list`) |
| <a id="atlas-ai01"></a>ATLAS-AI01 | warning | Some AI requests failed; map is partial / 部分 AI 请求失败 | Re-run analysis; successful results are cached |
| <a id="atlas-ai02"></a>ATLAS-AI02 | info | Evidence check dropped AI items without repository evidence / 证据校验丢弃了无出处的 AI 结果 | — (by design: no fabricated commands or features) |
| <a id="atlas-ai03"></a>ATLAS-AI03 | info | Files excluded from AI (secrets list) / 因敏感被排除的文件 | — |

Reserved for v0.2 runtime tracing / 预留给 v0.2 运行时追踪: ATLAS-E040 (receiver port), E041 (javaagent integrity), E042 (Python venv), E043 (Go patch conflict).
