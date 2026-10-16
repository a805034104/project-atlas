<!-- /autoplan restore point: /c/Users/admin/.gstack/projects/project-atlas/feat-v0.3-web-autoplan-restore-20261016-014702.md -->
# ProjectAtlas v0.3 计划：独立网页版（单文件程序）+ 金字塔流转图

> 状态：**已批准**（/autoplan 2026-10-16，exe 为主、只保留金字塔，按用户原选择）。上位文档 `docs/spec.md`、`docs/spec-v0.2.md`；本文与它们冲突时以本文为准。

## 1. 目标

用户不装 VS Code 插件也能用：

1. 从 GitHub Release 下载一个文件（`project-atlas-win-x64.exe` / `-macos-arm64` / `-macos-x64` / `-linux-x64`），双击。
2. 程序在本机起一个服务，**自动打开浏览器**到首页。
3. 首页「导入项目」：选本地目录（或粘贴路径、选最近打开过的、粘贴 git 地址克隆），点「分析」。
4. 分析完直接看到总览、拓扑、模块、功能、启动、流转、修改记录、Trace，与插件里看到的一致。
5. 流转图改成**自上而下的金字塔**：入口在最上面，一层一层往下展开到 SQL，每层居中，下游越多越宽。

用户决定（2026-10-16）：
- 流转图样式：自上而下分层（金字塔），不是现在的阶梯。
- 分发：下载即用的单文件程序，不要求装 Node.js。
- 不再以插件为主推形态。插件代码保留（CI 仍构建、测试），README 主推网页版。

## 2. 非目标

- 不做云端 / 多人共享服务：服务只监听 127.0.0.1，只给本机这一个用户用。
- 不做代码签名（没有证书）：Windows SmartScreen、macOS Gatekeeper 的首次提示在 README 写清楚怎么放行。
- 不改分析引擎的规则；Go / Python 支持仍按原计划在后续版本。

## 3. 架构

```
project-atlas(.exe)  ── Node SEA 单文件：esbuild 打包的服务端 + 内嵌资源（webview.js/css、tree-sitter wasm、解析 worker）
   │ 首次运行把资源解到 ~/.project-atlas/app/<version>/（wasm 和 worker 需要真实文件路径）
   ▼
本地 HTTP 服务 127.0.0.1:<随机端口>
   ├─ GET  /            首页 + 现有 webview 界面（同一个 React 包，新增 web 传输层）
   ├─ POST /api/msg     webview → 服务（WebviewToHost 消息，原样复用协议）
   ├─ GET  /api/events  服务 → webview（SSE，推送 HostToWebview 消息）
   ├─ POST /api/projects  导入：本地路径 / git 地址；GET 最近项目；GET /api/fs/dirs 目录浏览（只列目录名）
   └─ OTLP 接收器（复用 v0.2 RuntimeSession，独立端口，token 校验不变）
   ▼
浏览器自动打开 http://127.0.0.1:<port>/#token=<一次性 token>
```

- **零新依赖**：服务端用 Node 自带 `http`；服务端推送用 SSE，不引入 ws 库。
- **协议复用**：webview 与宿主之间的 `WebviewToHost` / `HostToWebview` 消息不变；web 版只是换一个传输层（`postMessage` → `fetch` + SSE）。宿主逻辑从 `packages/vscode/src/controller.ts`、`runtime.ts` 里抽出与 VS Code API 无关的部分，放进 `packages/core/src/host/`，插件和网页版共用。
- **单实例**：`~/.project-atlas/web.json` 记录 pid、端口、token；再次双击时如果已有实例在跑，直接打开浏览器到已有实例，不起第二个服务。
- **退出**：控制台窗口显示「关闭此窗口即可退出」；另外所有页面断开 30 分钟后自动退出。

### 3.1 网页版特有的交互

| 插件里的做法 | 网页版 |
|---|---|
| 点步骤打开编辑器到对应行 | 右侧源码面板显示文件片段（服务只读导入项目内的文件）；另给「在 VS Code / IDEA 中打开」链接（`vscode://file/…`、`idea://open?file=…&line=…`） |
| SecretStorage 存 AI key | 存 `~/.project-atlas/credentials.json`，权限 0600（Windows 为当前用户私有 ACL）；页面上只显示是否已配置，不回显 key；也支持环境变量 |
| 「带追踪启动」在集成终端运行 | 首版只提供「复制 VM 参数」和 CLI 命令；服务端代为启动用户命令放到后续版本（安全面更大） |
| 受限模式（Workspace Trust） | 导入时提示「只分析你信任的代码」；分析本身不执行项目代码，这一点不变 |
| 导出 HTML / Markdown | 页面上直接下载 |

### 3.2 金字塔流转图

- 布局：ELK layered，`elk.direction: DOWN`，节点按调用顺序排序，同层居中；同类内联方法、链路（过滤器→拦截器→Controller）是一条竖直主干，Service 及以下按调用展开。
- 每个节点保留层级色条和层级标签（过滤器 / 拦截器 / 切面 / Controller / Service / Mapper / SQL）；跨服务时用服务分组框把同一服务的节点框起来，框标题是服务名。
- 运行时叠加、单条 trace 模式、AI 虚线、未解析调用、递归回边：编码规则与 v0.2 一致，只是方向变成自上而下。
- 节点数很多时（> 80）默认折叠到 Service 层，点击展开；缩放、平移、「适合窗口」保留。
- 插件里也换成金字塔布局（同一个 React 组件），阶梯视图不再保留，避免两套维护。

## 4. 安全

本地服务能读任意本地目录，是新的攻击面：

- 只监听 127.0.0.1；随机端口。
- 每次启动生成 token，放在打开浏览器的 URL fragment 里；页面换成 `HttpOnly; SameSite=Strict` cookie；所有 `/api/*` 校验 cookie，常量时间比较。
- 校验 `Host` 必须是 `127.0.0.1:<port>` / `localhost:<port>`（防 DNS rebinding）；拒绝非同源 `Origin`；`/api/*` 只接受 `application/json`（挡住简单表单 CSRF）。
- 文件读取只允许已导入项目根目录内（realpath 后判断），目录浏览只返回目录名。
- 克隆 git 地址沿用 v0.1 的 clone.ts 校验（拒绝带凭据的 URL、只允许 https/ssh）。
- 严格 CSP（nonce 脚本、`worker-src blob:`），与插件 webview 一致。

## 5. 里程碑

| # | 内容 | 门 |
|---|---|---|
| W1 | 宿主逻辑抽到 `core/host`（插件改用它，行为不变，插件 E2E 仍过） | 现有测试全过 |
| W2 | `packages/web`：HTTP 服务、SSE、token/Host/Origin 校验、项目导入 API、源码片段 API、单实例 | 安全单元测试；`node packages/web/dist/main.js` 能打开并分析 RuoYi-Vue |
| W3 | webview：web 传输层、首页（导入项目、最近项目、分析进度）、源码面板 | Playwright/无头 Chrome E2E：打开 → 导入 → 看到流转 |
| W4 | 金字塔布局替换阶梯（插件和网页共用） | 8 状态 × 4 主题截图重拍；RuoYi `GET /system/user/list` 截图人工确认 |
| W5 | 单文件程序：esbuild + Node SEA，资源内嵌与解包；CI 在三个系统上构建并上传 Release | 三个系统各下载一次、双击、导入 RuoYi-Vue、看到流转（Windows 本机实测，其他两个在 CI 里无头验证） |
| W6 | README / 文档改为网页版优先；版本 0.3.0 | /review、/qa |

## 6. 验收

- **AC-W1**：Windows 上双击 exe，10 秒内浏览器打开首页（不含首次解包），不需要预装 Node/Java。
- **AC-W2**：导入 RuoYi-Vue 本地目录，分析完成后流转页能看到 `GET /system/user/list` 的金字塔图，节点从上到下依次为过滤器、拦截器、Controller、切面、Service、Mapper、SQL。
- **AC-W3**：用另一个网页（不同源）向 `/api/*` 发请求一律被拒；`Host: evil.example` 被拒；没有 token 的请求被拒；读取项目外文件被拒。
- **AC-W4**：第二次双击不起新进程，直接打开已有实例。
- **AC-W5**：网页版运行时追踪：复制 VM 参数启动 RuoYi，请求一次后流转图出现 observed（复用 v0.2 的 AC#19）。
- **AC-W6**：插件仍可构建，插件 E2E 仍通过（共用宿主逻辑没有改坏它）。

## 7. 风险

| 风险 | 处理 |
|---|---|
| Node SEA 下 worker_threads 和 wasm 需要真实文件 | 首次运行解包到 `~/.project-atlas/app/<version>/`，校验 sha256 后使用 |
| 单文件体积（Node 本体约 60–90 MB） | 可接受；Release 上标注体积 |
| macOS 未签名二进制被 Gatekeeper 拦 | README 写明「右键 → 打开」或 `xattr -d com.apple.quarantine`；以后有证书再签名 |
| 杀毒软件误报 | Release 附 sha256；源码与 CI 构建日志公开 |
| 金字塔在宽调用（一个 Service 调十几个 Mapper）时太宽 | 超过阈值折叠，缩放与适合窗口 |

---

## /autoplan 评审记录（2026-10-16）

> Codex 不可用，各阶段为「主评审 + Claude 子代理」[subagent-only]。

### Phase 1 · CEO

**前提评估（0A）**
| # | 前提 | 评估 |
|---|---|---|
| P1 | 用户不想装 VS Code 插件 | 合理：若依 / Spring 开发者主力是 IDEA，浏览器版不挑编辑器。用户决定，保留 |
| P2 | 用户不一定装 Node，所以要单文件 exe | 用户决定。子代理指出：未签名、87 MB、开端口、读任意目录的 exe 在公司电脑上容易被 EDR / SmartScreen 拦。→ 作为用户挑战项交到闸门 |
| P3 | 金字塔比阶梯好读 | 用户决定。风险：Spring 链路深而窄，竖排后在 16:9 屏上是细长条；Service 扇出多时某一行很宽 → 设计阶段给出具体规则 |
| P4 | 插件代码保留、共用宿主逻辑 | 合理，但宿主抽取工作量被低估：controller.ts + runtime.ts 约 47 处 `vscode.*` 调用 → 先定义 `HostEnv` 接口 |
| P5 | 子代理称「v0.1/v0.2 从未发布」 | **错误**：2026-10-16 已公开仓库并发布 Release v0.2.1，此条作废 |

**已有代码可复用（0B）**
| 子问题 | 现有代码 |
|---|---|
| 分析、图、视图数据 | `core/analyze.ts`、`GraphView`、`store/` |
| 界面 | `packages/webview` 整个 React 包（协议 `core/protocol.ts` 不变） |
| 离线 shim 思路 | `vscode/src/static-export.ts` 的 `acquireVsCodeApi` 垫片 |
| 打包（esbuild、worker、wasm） | `vscode/build.mjs` |
| 运行时接收器 | `core/runtime/session.ts`、`receiver.ts` |
| git 克隆校验 | `core/workspace/clone.ts` |
| 截图 / 主题矩阵 | `scripts/theme-shots.mjs`、webview dev harness |

**梦想状态（0C）**
```
现在：VS Code 插件（IDEA 用户用不上）+ CLI + MCP
本计划：双击 exe → 浏览器 → 导入项目 → 金字塔流转 + 运行时叠加；插件共用同一宿主逻辑
12 个月：团队级——CI 每次提交生成可分享的地图、PR 上显示「本次改动影响的流转」、AI 助手经 MCP 查到精确调用链
```
差距：本计划解决「单机怎么用」，不解决「团队怎么用 / 留存」。PR 影响面评论放进 TODOS（不在本次范围）。

**实现方案对比（0C-bis）**
| 方案 | 工作量 | 风险 | 说明 |
|---|---|---|---|
| A. 单文件 exe（Node SEA）为主 | 中 | 中高（签名、杀软、macOS 需重签） | 用户选择 |
| B. `npx project-atlas` 为主，exe 为辅 | 低 | 低 | 依赖用户装 Node |
| C. Electron 桌面程序 | 高 | 中（150 MB+） | 体验像原生，但多一套壳；否决（P5 显式优先） |
→ 按用户选择走 A；本地服务本身就是 Node 程序，**顺带**让 CLI 支持 `project-atlas serve`（几乎零成本，同一入口），作为装了 Node 的用户和 CI 截图测试的入口。npm 发布不在本次范围（需要用户注册账号）。

**SEA 可行性（已实测）**：Node 22.23 + postject 在 Windows 打出 87 MB exe，`node:sea` 资源解出 worker 脚本后 `worker_threads` 正常运行。注意：
- SEA 入口必须是单个 CJS 文件（esbuild 打包，沿用 build.mjs 的 `import.meta.url` 垫片）。
- `pool.ts` 在拿不到 `workerPath` 时**静默退回单线程**——网页版必须显式传 `workerPath`，并加测试断言打包产物里解析池大小 > 0。
- macOS arm64 注入后必须 `codesign --sign -` 重签，否则被系统杀掉；macOS x64 runner 正在退役 → 只出 `macos-arm64`。
- Windows 注入后原签名失效（实测 postject 警告），首次运行有 SmartScreen 提示。

**自动决定**：模式 SELECTIVE EXPANSION；加 `serve` 子命令（在影响范围内、<1 天）；加 W0 SEA 冒烟（三平台各跑一次多 worker 解析）；`HostEnv` 接口先行；修正 AC-W2 节点顺序（与 §3.2 矛盾）；git 克隆加固（`core.hooksPath` 置空、不递归子模块、`protocol.file.allow=never`）；token 交换写清楚（fragment → POST 换 cookie → `history.replaceState` 清掉 fragment，页面 `Referrer-Policy: no-referrer`）。

**用户挑战（交闸门，不自动决定）**
- UC1 分发主渠道：你选「exe」。子代理建议「npx 为主、exe 为辅，exe 等有签名证书再主推」，理由是公司电脑会拦未签名 exe。默认按你的选择。
- UC2 阶梯视图：你说换成金字塔。子代理建议 v0.3 两种布局都保留（默认金字塔，可切换），看过 3 条真实链路的截图再决定删不删。默认按你的选择（只保留金字塔）。

**错误与恢复登记**
| 失败点 | 用户看到 | 恢复 |
|---|---|---|
| 端口被占 | 无 | 换随机端口重试 3 次 |
| 解包资源 sha256 不符 / 无写权限 | 控制台报错码 + 说明 | 删除重解；退回临时目录 |
| 浏览器没自动打开 | 控制台打印地址 | 用户手动打开 |
| 导入路径不存在 / 不是目录 / 无权限 | 首页表单内联错误 | 重新选择 |
| 克隆失败（网络、私有仓库） | 错误卡片（ATLAS-E030 等现有码） | 改用本地路径 |
| 分析中关闭页面 | 无 | 服务继续分析，重新打开页面看到进度 |
| 第二个实例 | 无 | 打开已有实例 |
| 已有实例的 web.json 过期（进程已死） | 无 | 检测 pid 不存在则接管 |

**失败模式登记**
| 模式 | 严重度 | 处理 |
|---|---|---|
| 打包后静默单线程解析 | 高 | 显式 workerPath + 测试 |
| 别的网页借本机服务读文件（DNS rebinding / CSRF） | 严重 | Host/Origin/cookie/JSON 四道校验 + AC-W3 |
| 杀软误报导致用户以为是病毒 | 高 | Release 附 sha256、构建日志公开；README 说明 |
| 金字塔过宽 | 中 | 设计阶段规则 |
| 共用宿主逻辑改坏插件 | 中 | AC-W6：插件 E2E 必须通过 |

**不在本次范围**：npm 发布；代码签名证书；服务端代为启动被追踪的命令；PR「影响流转」评论（→ TODOS）；Electron；macOS x64 构建。

**CEO 完成摘要**：前提 5 条（1 条子代理判断有误已作废，2 条交闸门）；新增 W0 冒烟、`HostEnv`、`serve` 子命令、安全细节 4 项；风险最高的是分发信任问题和打包后性能退化。

CEO 双声道共识表（Codex 不可用）：
```
  维度                     主评审   子代理   共识
  1 前提成立?              大体是   部分否   N/A（单模型）
  2 问题选对?              是       需重构   DISAGREE → 闸门 UC1
  3 范围合适?              是       W5 过早  DISAGREE → 闸门 UC1
  4 备选方案充分?          补齐     不足     已补 0C-bis
  5 竞争风险?              中       高       记录（MCP 定位放后续）
  6 6 个月走向?            需留存   需留存   CONFIRMED（→ TODOS）
```

### Phase 2 · 设计（全部自动采纳，补进 §3.2–3.4）

**3.2 金字塔规则（补充）**
- 节点 200×44：第一行 `Class.method`（13px 等宽，**中间省略**，不截尾）；第二行层级标签（11px 大写、层级色底，如 `SERVICE`）+ 运行时徽标。行距 56，同行间距 24（ELK `nodeNodeBetweenLayers=56`）。
- 行按调用深度排，层级含义靠两样保住：每个节点的层级标签，以及左侧 72px 粘性栏，逐行列出该行出现的层级（如「切面 · Service」）。
- 主干：过滤器 → 拦截器 → Controller 在同一竖列。**切面不单独占一行**，作为挂在被增强方法右侧 24px 的附属药丸（虚线连接）。这也解决了 AC-W2 的顺序矛盾。
- 服务分组框：1px 虚线、12px 内边距、8% 中性色底；标题「ruoyi-system · 6 步」可折叠；ELK 复合节点（`hierarchyHandling: INCLUDE_CHILDREN`）避免框重叠。
- 扇出按父节点控制：子节点 > 6 时显示前 5 个（按调用顺序）+「还有 9 个」节点，点击原地展开；全图 > 80 节点再折叠到 Service 层作为第二道保险。
- 边标签放在中点，用不透明药丸（11px）；一行边数 > 4 时标签改为悬停 / 聚焦显示。p95 耗时放进节点第二行，边上只标次数。
- 运行时：观测到的边 2px 实线，仅静态的边 1px、40% 透明，AI 推断虚线。单条 trace 模式：路径外 25% 透明，路径 2px 描边，横幅「Trace 3f2a… · 226 ms · Esc 退出」。
- 递归回边：从右侧绕行的虚线折线，目标节点标 ↺，不穿过其他节点。
- 缩放：载入时适合窗口，缩放限制在 0.6–1.5；再小就锚定顶部，保证入口可读。右下角 − / % / + / 适合窗口，快捷键 `0` `+` `-`；> 40 节点显示小地图。
- 流转页没有选中入口时自动选第一个，不显示空画布。

**3.3 首页状态**
- 首次：居中卡片（最宽 560px），标题「导入项目」，主输入框「粘贴文件夹路径或 git 地址」（44px 高）+「浏览…」，一行信任提示「只分析你信任的代码；分析不会运行项目代码」。
- 最近项目（非空时显示在输入框上方）：名称、路径（中间省略）、技术栈标签、「分析于 2026-10-15 14:30」、过期标记；最新在前，最多 8 个；操作：打开 / 重新分析 / 移除。
- 分析中：分阶段进度和计数（扫描文件 1,240 → 解析 812/1,240 → 构建流转 → 完成）、已用时间、取消按钮，不用光转圈。
- 错误：输入框下方内联，写清原因和怎么办，保留用户输入。
- 过期：文件在分析后有改动时，顶栏琥珀色提示「分析后有改动 · 重新分析」。
- 路径框是主控件（Windows 用户习惯从资源管理器粘贴，接受带引号和结尾斜杠）；「浏览…」弹出目录树（盘符 / ~ 快捷入口、面包屑、只列目录，含 `pom.xml` / `package.json` / `.git` 的目录加项目标记）。
- 分析完落在总览：顶部一条（项目名 · 技术栈 · 服务 / 模块 / 入口数），下面三张卡片「从这里开始」（扇出最大的 3 个入口，点开即金字塔）、「怎么启动」、「热点模块」；候选功能列表放到卡片下面。

**源码面板**：右侧抽屉 480px（可拖到 320px–60%），标题 path:line + 「在 VS Code 中打开」「在 IDEA 中打开」+ 关闭；显示目标行上下各 20 行，目标行高亮并滚到 1/3 处，有行号；错误态「文件在项目外」「分析后文件有改动，行号可能偏移」。

**3.4 配色与无障碍**
- 网页版自己定义 CSS 令牌（`--bg --surface --fg --muted --border --accent` + 8 个层级色），跟随 `prefers-color-scheme`，另有 浅色 / 深色 / 跟随系统 切换。深色 bg `#1e1f22` fg `#e6e6e6`；浅色 bg `#ffffff` fg `#1f2328`。层级色对两种背景对比度 ≥ 3:1，文字标签 ≥ 4.5:1。
- 插件里把同一组令牌映射到 `--vscode-*`，一个组件两边通用。W4 截图门改为「浅/深 × 网页/插件 + 插件高对比度 2 种」。
- 不只靠颜色：层级标签有文字、观测边实线、静态边淡线。
- 键盘：方向键在节点间移动（上下 = 深度，左右 = 同行），Enter 打开源码面板，空格展开 / 折叠；2px 焦点环；节点 `aria-label`「Service SysUserServiceImpl.selectUserList，第 4 层，3 次调用，p95 1.06 ms」；遵守 `prefers-reduced-motion`。

设计评分（主评审）：信息层级 6→8、状态覆盖 3→9、布局规格 4→8、可访问性 5→8、主题 3→8、一致性 7→8、交互细节 5→8。

### Phase 2.5 · 开发者体验（DX）

用户是 Java / 若依开发者（IDEA 为主），本产品对他们来说是「下载就用的工具」，DX 就是从下载到看到第一张图的路径。

**首次使用旅程**
```
Release 页 → 选对系统的文件（README 表格：Windows / macOS Apple 芯片 / Linux）→ 下载 87 MB
→ 双击 → [Windows SmartScreen「更多信息 → 仍要运行」/ macOS 右键打开] → 控制台「ProjectAtlas 正在运行：http://127.0.0.1:xxxx（关闭此窗口退出）」
→ 浏览器自动打开首页 → 粘贴项目路径 → 分析（RuoYi-Vue 约 10–20 秒）→ 总览 →「从这里开始」→ 金字塔
```
**首次出图时间（TTHW）目标**：从双击到看到 RuoYi-Vue 的第一张金字塔 ≤ 60 秒（不含下载）。当前（插件）需先装 VS Code 插件，IDEA 用户实际不可达。

**评分（0–10）**：上手 4→8；错误信息 7→8（沿用错误码体系，新增 ATLAS-E080 起的网页版错误码：端口、解包、导入路径、克隆）；文档 6→8（README 首屏换成下载表 + 30 秒动图）；可发现性 5→7（首页最近项目 + 「从这里开始」卡片）；升级路径 3→6（首页右上角显示版本，检查 GitHub 最新 Release 时只发一次请求、可关闭，默认关）；平台差异 4→7（三平台说明）；离线 7→8（完全离线可用，AI 与升级检查除外）；可脚本化 7→8（`project-atlas serve --no-open --port`）。

**DX 实施清单（自动采纳）**
- README 首屏：三平台下载表（文件名、大小、sha256）+ 放行说明（SmartScreen、Gatekeeper）。
- 控制台输出固定三行：地址、数据目录、「关闭此窗口退出」；出错时打印错误码和文档链接。
- `serve` 支持 `--no-open`、`--port`、`--host 127.0.0.1`（只允许回环地址）。
- 新错误码 ATLAS-E080–E085 写进 docs/errors.md。
- 首页页脚：版本号、数据目录路径、「打开日志目录」。

DX 共识（子代理未单独跑，主评审）：N/A。

### Phase 3 · 工程（最终评审，全部自动采纳）

**架构**
```
浏览器标签 (/#/p/<id>) ──POST /api/p/:id/msg──▶ web/server.ts ─security.ts─▶ core/host/dispatch.ts ─▶ ProjectSession
        ▲                                                                                 (AnalysisController + RuntimeHost)
        └──────── GET /api/p/:id/events (SSE) ◀── web/sse.ts EventHub ◀── Emitter ────────────
插件 panel.ts ──postMessage──▶ core/host/dispatch.ts（同一份）；VsCodeEnv 实现 HostEnv
```
- `core/src/host/`：`emitter.ts`（替代 vscode.EventEmitter）、`analysis-controller.ts`（AtlasController 去掉 vscode 调用）、`runtime-host.ts`（RuntimeManager 去掉状态栏）、`dispatch.ts`（panel.ts 的消息分发 + 命令白名单）、`source.ts`（`resolveInRoot` + `readSnippet`）、`overrides.ts`、`cost.ts`、`errors.ts`。
- `HostEnv`：locale、settings、providerConfig、trusted、assets{wasmDir, workerPath}、atlasDir、log、progress、**prompt**（替代 QuickPick / 模态确认）、notify、clipboard、openSource（返回「已打开」或源码片段）、memento、watch?。
- `packages/web/src/`：main、instance（单实例）、server、security、auth、sse、projects、fs-api、static、credentials、web-env、assets（SEA 解包 + sha256）、open-browser（不经 shell 启动浏览器）。
- 传输切换：`<body data-atlas-host="web" data-project=…>` 时 `getVsCodeApi()` 走 `createWebApi()`。请求类消息（requestView / requestFlow / requestTrace / readSource）POST 后在响应体里拿结果，推送类走 SSE；两者都用 `window.dispatchEvent(new MessageEvent("message"))` 注入，`bridge.ts` 不改。getState/setState 用 localStorage（按项目分 key，try/catch）。
- 协议新增：`readSource` / `sourceSnippet` / `prompt` / `promptAnswer` / `clipboard`（`HOST_TYPE_RECORD` 在编译期强制补全）。

**难点与做法**
- SSE：连上后先推快照（init、runtimeState、analysisState），重连重推（幂等）；analysisState 每连接最多 10 次/秒、只保留最新；15 秒心跳，`retry: 2000`。
- **[严重 B] 浏览器每站点约 6 个连接**：每个 SSE 占一个，开 6 个以上标签页 POST 会卡住 → 标签页隐藏时关闭 EventSource，可见时重连并拿快照。
- **[严重 A] 启用 AI 时分析会卡死**：插件里有费用确认、克隆确认、选择服务三处阻塞弹窗 → `HostEnv.prompt` 经 SSE 推 `prompt`，等 `promptAnswer`；没有页面在线或 10 分钟超时视为拒绝。
- 分析结果存放：默认仍在仓库内 `.atlas`（与插件 / CLI 一致）；导入时探测可写性，不可写或 git 地址导入则放 `~/.project-atlas/projects/<sha1(realpath)>/`。`RuntimeSession.start` / `runtimeOwner` 增加 `atlasDir` 选项。项目登记表 `~/.project-atlas/projects.json` 原子写（tmp + rename），含信任标记、存储位置、分析时间。
- 多项目：`ProjectRegistry` 最多常驻 3 个会话（LRU 卸载空闲的）；全局互斥，同一时间只跑一个分析。
- 取消：`atlas.cancel` 触发 AbortController；关页面不取消；空闲退出在分析中或 30 分钟内有 span 时跳过。
- 单实例：`~/.project-atlas/web.lock` 用 `open(…,"wx")` 抢锁；输的一方轮询 `web.json` 最多 3 秒；存活用 `GET /healthz` 返回实例 nonce 判断（不只信 pid）。`.atlas/receiver.json` 也改成 `wx` 原子创建（现在先查后写，和插件并存时有竞争）。
- 剪贴板：宿主返回 `{type:"clipboard"}`；`navigator.clipboard` 失败时弹出带「复制」按钮的对话框。
- 信任：插件靠 `workspace.isTrusted` 控制 AI 和 git 历史；网页版用导入时的「我信任这份代码」勾选，默认不勾。

**安全（补进 §4）**
1. SameSite 不区分端口（任何 `127.0.0.1:*` 页面都算同站）→ 非 GET 请求精确校验 `Origin`；`Sec-Fetch-Site` 只接受 `same-origin` / `none`；GET 无副作用；cookie 名按端口 `atlas_<port>`。
2. URL 里的 token 会留在浏览器参数和历史里 → fragment 里放**一次性 60 秒码** `#code=`，`POST /api/session` 换 cookie 后 `history.replaceState` 清掉；第二次双击时用 `web.json` 里的密钥 `POST /api/launch-code` 申请新码。
3. **[严重 C] 导入 `~` 或盘符根目录会让源码 API 读到 `~/.ssh`、`credentials.json`** → `resolveInRoot` 两侧都 realpath + `path.relative` 判断；永远拒绝 `atlasHome()`；导入家目录或根目录时警告。
4. 插件现有 `openSource` 没做 realpath（符号链接逃逸），还会误拒名为 `..foo` 的文件 → 在共享函数里一起修。
5. 响应头：`frame-ancestors 'none'`、`Cross-Origin-Opener-Policy: same-origin`、`nosniff`、`Cache-Control: no-store`、`Referrer-Policy: no-referrer`、CSP `connect-src 'self'`。
6. 拒绝 UNC 和 `\\?\` 路径（可能泄露 NTLM 哈希）。
7. git 克隆再加 `-c core.symlinks=false`；拒绝以 `-` 开头的 ssh 主机。
8. Windows 上 0600 不起作用 → 删掉「Windows 私有 ACL」的说法，依赖用户目录本身的 ACL。
9. 永远打开 `127.0.0.1`，不用 `localhost`。
10. `receiver.ts` 里的 token 比较和 Host 校验移到 `core/src/util/secure.ts` 复用。

**金字塔实现**：`Swimlane.tsx` 替换为 `Pyramid.tsx` + `pyramid-model.ts`；ELK：layered、DOWN、INCLUDE_CHILDREN、`nodeNodeBetweenLayers 56`、`nodeNode 24`、`considerModelOrder NODES_AND_EDGES`、`BRANDES_KOEPF` + `BALANCED`、ORTHOGONAL；服务框为复合节点；切面附属药丸在节点盒内绘制；扇出折叠在送 ELK 之前做；递归回边不进 ELK，自绘；`elkLayout` 要返回边的路径点；加生成号丢弃过期结果；`layeredFallback` 加自上而下版本。性能约 200 节点预计 100–400 ms（未实测）→ 加 < 1 秒的预算测试。

**测试计划**
| 代码路径 | 测试 |
|---|---|
| 宿主分发、分析控制器、prompt | `core/test/host/*.test.ts`（假 HostEnv） |
| 源码读取（符号链接、`..foo`、atlasHome、大小上限） | `core/test/host/source.test.ts` |
| Host / Origin / Sec-Fetch-Site / cookie / content-type / 一次性码 | `web/test/security.test.ts` = AC-W3 |
| SSE 快照、合并、重连 | `web/test/sse.test.ts` |
| 单实例（并发启动、过期 pid、pid 复用） | `web/test/instance.test.ts` |
| 导入（带引号路径、只读回退） | `web/test/projects.test.ts` |
| receiver 锁 | `core/test/runtime/lock.test.ts` |
| web 传输层 | `webview/test/transport.test.ts` |
| 金字塔模型与真实 ELK 布局（y 顺序、框不重叠、< 1 秒） | `webview/test/{pyramid,elk-pyramid}.test.ts` |
| 端到端：打开 → 导入 RuoYi-Vue → 金字塔 | `scripts/web-e2e.mjs`（无头 Chrome + CDP，零依赖），CI 上 ubuntu + windows |
| 打包产物解析池 > 0 | `scripts/sea-smoke.mjs` 跑 `--self-test` |
| 插件未被改坏 | 现有插件 E2E（AC-W6） |

**实施顺序**：T0 SEA 冒烟(M) → T1 core/host + HostEnv(L) → T2 插件改用(M) → T3 协议新增(S) → T4 RuntimeSession atlasDir + 原子锁(S) → T5 服务/安全/认证/静态(M) → T6 SSE(M) → T7 项目/目录/存储(M) → T8 单实例/启动码/空闲退出(M) → T9 `serve`(S) → T10 webview 传输(M) → T11 首页/进度/源码抽屉/prompt 对话框(L) → T12 CDP E2E + CI(M) → T13 金字塔(L，可并行) → T14 令牌与截图矩阵(M) → T15 SEA 发布流水线(L) → T16 文档(S)。

**工程共识**（Codex 不可用）：架构可行 CONFIRMED（主评审 SEA 实测 + 子代理读码）；3 个严重缺口（A prompt 卡死、B 连接上限、C 家目录泄露）已写入计划。

---

## 跨阶段主题

- **分发信任**（CEO、DX）：未签名 exe 在公司电脑上的放行问题，两个阶段独立提出 → 闸门 UC1。
- **共用宿主不能改坏插件**（CEO、工程）：`HostEnv` 先行 + AC-W6。
- **金字塔过宽 / 过高**（CEO、设计、工程）：按父节点折叠 + 缩放锚定顶部 + 布局预算测试。

<!-- AUTONOMOUS DECISION LOG -->
## 决定记录

| # | 阶段 | 决定 | 类型 | 原则 | 理由 |
|---|---|---|---|---|---|
| 1 | CEO | 模式 SELECTIVE EXPANSION | 机械 | — | autoplan 规定 |
| 2 | CEO | 作废「v0.1/v0.2 未发布」 | 机械 | — | 事实错误，Release v0.2.1 已发布 |
| 3 | CEO | 加 `project-atlas serve` 子命令 | 机械 | P2 | 同一入口，<1 天 |
| 4 | CEO | 加 W0 SEA 三平台冒烟 | 机械 | P1 | 风险前置 |
| 5 | CEO | HostEnv 接口先行 | 机械 | P5 | 47 处 vscode 调用 |
| 6 | CEO | 只出 macos-arm64 | 机械 | P3 | x64 runner 退役 |
| 7 | CEO | npm 发布、签名、PR 影响评论不在范围 | 机械 | P3 | 需要用户账号 / 证书；另立项 |
| 8 | CEO | 分发主渠道 | 用户挑战 UC1 | — | 交闸门 |
| 9 | CEO | 是否保留阶梯视图 | 用户挑战 UC2 | — | 交闸门 |
| 10 | 设计 | 节点 200×44、中间省略、层级标签 + 左侧层级栏 | 机械 | P1 | 保住层级含义 |
| 11 | 设计 | 切面做附属药丸，不单独占行 | 机械 | P5 | 解决 AC-W2 矛盾 |
| 12 | 设计 | 按父节点折叠扇出（>6 → 5 + N） | 机械 | P1 | 全局阈值抓不到真实情况 |
| 13 | 设计 | 首页状态与文案、源码抽屉规格 | 机械 | P1 | 原计划缺失 |
| 14 | 设计 | 网页版自有配色令牌，插件映射 vscode 变量 | 机械 | P4 | 一个组件两边用 |
| 15 | DX | TTHW ≤ 60 秒；错误码 E080–E085；三平台下载表 | 机械 | P1 | — |
| 16 | 工程 | prompt 经 SSE 往返 | 机械 | P1 | 严重 A |
| 17 | 工程 | 隐藏标签页关闭 SSE | 机械 | P3 | 严重 B |
| 18 | 工程 | resolveInRoot realpath + 拒绝 atlasHome | 机械 | P1 | 严重 C，插件同时受益 |
| 19 | 工程 | 一次性码换 cookie、Origin 精确校验、Sec-Fetch-Site | 机械 | P1 | SameSite 不区分端口 |
| 20 | 工程 | .atlas 默认在仓库内，不可写时回退 | 机械 | P3 | 与插件 / CLI 一致 |
| 21 | 工程 | E2E 用无头 Chrome + CDP，不加 Playwright | 机械 | P4 | 零新依赖 |
| 22 | 工程 | receiver.json 原子创建 | 机械 | P1 | 现有竞争 |
