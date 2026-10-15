# S0 Spike 结果：RuoYi-Vue + opentelemetry-javaagent 2.31.1

> 执行日期 2026-10-15（运行时间约 13:00–13:25 EDT / 2026-10-16 01:00–01:25 CST）。对应 `docs/spec-v0.2.md` §3 S0。
> 结论先行：**7 项里 5 项直接成立，③（MyBatis）和 ⑦（中文路径）需要改 spec**，改法见文末「建议修改 spec 的地方」。

## 环境与复现

| 项 | 版本 / 路径 |
|---|---|
| JDK | Temurin 21.0.11+10（PATH 上的系统 JDK）。Spring Boot 2.5.15 用 JDK 21 编译（target 1.8）和运行都没问题，**没有另装 JDK 8/17** |
| Maven | 3.9.16 → `E:\tools\maven`（sha512 已与 archive.apache.org 核对）；`~/.m2/settings.xml` 配了阿里云镜像 |
| MySQL | 8.0.46 winx64 zip → `E:\tools\mysql`，数据目录 `E:\tools\mysql-data`（MD5 `003f527d…76bd` 已与 dev.mysql.com 核对）；`--initialize-insecure` 后 root 密码设为 `password`，绑定 127.0.0.1:3306 |
| Redis | 5.0.14.1，`E:\Redis-x64-5.0.14.1`，127.0.0.1:6379 |
| RuoYi | `fixtures/repos/ruoyi-vue`（`6230a34b`）用 `git archive` 复制到 `E:\tools\ruoyi-vue-build` 后构建，fixture 本身未改动；导入 `ry_20260417.sql` + `quartz.sql`；`sys.account.captchaEnabled=false` |
| agent | `~/.project-atlas/agents/opentelemetry-javaagent-2.31.1.jar`（exporter UA：`OTel-OTLP-Exporter-Java/1.65.0`） |

脚本（都在 `scripts/spike/`）：`start-deps.sh` / `stop-deps.sh`（MySQL+Redis）、`run-ruoyi.sh`（起接收器 → 起应用 → 轮询健康 → 发请求 → 轮询 raw 目录 → 停进程）、`otlp-capture.mjs`、`gen-methods-include.mjs`、`decode.mjs`、`tree.mjs`。

请求集：`GET /captchaImage` → `POST /login` → `GET /system/user/list`、`/system/role/list`、`/monitor/server`、`/system/user/1`、`POST /system/user/export`（带 `@Log`，用来触发 LogAspect 和异步写操作日志）。

| Run | 内容 | 输出 |
|---|---|---|
| A | `java -javaagent … -jar`，方法清单（已过滤） | **黄金夹具** `fixtures/runtime/ruoyi-vue-2.31.1/`（raw/*.pb 11 个、decoded.json 124 span） |
| Araw | 同 A，但方法清单不过滤 getter/实体类 | `scripts/spike/runs/Araw` |
| B | A + `controller-telemetry.enabled=true` | `runs/B` |
| C | `mvn spring-boot:run` + `-Dspring-boot.run.agents` | `runs/C` |
| C2 | `mvn spring-boot:run` + `JAVA_TOOL_OPTIONS`（对照组） | `runs/C2` |
| D1 | agent 放在 `E:\tools\测试 目录\` | `runs/D1` |
| E | A + `mybatis.enabled=true` + `--server.servlet.context-path=/ctx`（配置文件里还写了 semconv opt-in，**没生效**，见 ⑤） | `runs/E` |
| E2 | A + `-Dotel.semconv-stability.opt-in=database/dup,code/dup`（用系统属性传） | `runs/E2` |

## 方法清单（V4）

`gen-methods-include.mjs` 对 `fixtures/repos/ruoyi-vue` 跑 `analyzeWorkspace`，取 layer ∈ filter/interceptor/aspect/controller/service/repository 的 FlowStep：

- 不过滤：105 个类、661 个方法，`otel.instrumentation.methods.include` 值长 **13 678** 字符。
- 按 V4 去掉 getter/setter 和 domain/entity/vo/annotation 类后：69 个类、431 个方法，长 **9 677** 字符（Run A 用的这一版）。
- 两种长度 agent 都照单全收：没有警告，所有列出的类都产生了 span。配置文件写成一行 `Class[m1,m2];Class2[…]`，没有问题。
- **静态图里的噪音**：有 245 个 step 实际是实体类 getter/setter（`SysUser#getUserId`、`TableDataInfo#setRows`……）、注解（`Excel#width`）或 `AjaxResult#put`，却被标成了 `service`。`GET /system/user/list` 的流转里有 4 个 `TableDataInfo#set*` step。用不过滤的清单时，每个请求的 span 从 11 个涨到 112 个，全程从 124 个涨到 748 个（Run Araw）。

## ① 各层方法 span

Run A 中 `GET /system/user/list` 的 trace（11 个 span）：

```
- GET /system/user/list [SERVER] <tomcat-7.0> http.route=/system/user/list
  - XssFilter.doFilter [INTERNAL] <methods> code.namespace=com.ruoyi.common.filter.XssFilter code.function=doFilter
    - JwtAuthenticationTokenFilter.doFilterInternal <methods>
      - GET [CLIENT] <lettuce-5.1> db.statement=GET login_tokens:<uuid>
      - RepeatableFilter.doFilter <methods>
        - RepeatSubmitInterceptor.preHandle <methods>
        - SysUserController.list <methods>
          - DataScopeAspect.doBefore <methods>
          - SysUserServiceImpl.selectUserList <methods>
            - SELECT ry-vue [CLIENT] <jdbc> db.statement=SELECT count(?) FROM sys_user u LEFT JOIN sys_dept d …
            - SELECT ry-vue [CLIENT] <jdbc> db.statement=select u.user_id, u.dept_id, …
```

把这次观测和静态流转（14 个 step）逐一比对：

| 层 | 结果 |
|---|---|
| filter | ✅ `XssFilter.doFilter`、`JwtAuthenticationTokenFilter.doFilterInternal`、`RepeatableFilter.doFilter`（`/`、`/captchaImage`、`/login` 不经过 XssFilter，这符合它的 urlPatterns） |
| interceptor | ✅ `RepeatSubmitInterceptor.preHandle` |
| aspect | ✅ `DataScopeAspect.doBefore`；`LogAspect.doBefore` / `doAfterReturning` 出现在 `/system/user/export` 中 |
| controller | ✅ `SysUserController.list` 等。**例外**：静态图漏掉的 handler 没有方法 span，包括 `SysUserController#getInfo`（`@GetMapping(value = {"/", "/{userId}"})`）、`ServerController#getInfo`（`@GetMapping()`）和 `CaptchaController#getCode`。这是 core 静态分析的问题 |
| service | ✅ `SysUserServiceImpl.selectUserList` 等。非 Impl 的 `@Service`（`TokenService`、`SysLoginService`、`SysPasswordService`）也有 span |
| repository | ❌ **只靠方法清单不行**：清单里写了 `SysUserMapper[...]` 等 20 个 Mapper 接口，但没产生任何 span。Mapper 是 JDK 动态代理，methods 插桩只匹配具体类。打开 `otel.instrumentation.mybatis.enabled=true` 之后就有了，见 ③ |
| sql | 以 JDBC CLIENT span 的形式出现，见 ③ |

另外两点：
- 静态流转里有一个 step `layer=interceptor, symbol=SysUserController#list(SysUser)`，看起来是 core 的问题（interceptor 层挂了 controller 符号）。
- 切面 span 的父节点是「最近的被插桩帧」，不是切点方法：`DataScopeAspect.doBefore` 和 `SysUserServiceImpl.selectUserList` 是兄弟，都挂在 controller 下；`LogAspect.doBefore` 和 `SysUserController.export` 也是兄弟，都挂在 `RepeatableFilter.doFilter` 下。

## ② CGLIB

- 4 个 Run 里出现过的 `code.namespace` 共 17–38 个，**没有一个**带 `$$EnhancerBySpringCGLIB$$`、`$$SpringCGLIB$$` 或 `$Proxy`。`SysUserServiceImpl`（有 `@Transactional`，是 CGLIB 代理）的 span 显示的是原类名 `com.ruoyi.system.service.impl.SysUserServiceImpl`。
- 方法清单模式下，**同一方法不会出现代理和目标两层 span**：methods 插桩按类名精确匹配，CGLIB 子类不在清单里。
- 父子 span 同名的情况有两种，都不是 CGLIB 造成的：
  1. **重载**：`TokenService.createToken` 里套着 `TokenService.createToken`。前者是 `public createToken(LoginUser)`，后者是 `private createToken(Map)`，按方法名插桩会把所有重载都插上，而 span 里没有参数签名。
  2. **Run B 打开 controller-telemetry 后**：`SysUserController.list <spring-webmvc-3.1>` 里套着 `SysUserController.list <methods>`，外层 298 ms，内层 154 ms。外层包住了代理调用（`@PreAuthorize` 校验等），内层只算目标方法。

## ③ MyBatis / JDBC

- **agent 自带的 MyBatis 插桩（`io.opentelemetry.mybatis-3.2`）在 2.31.1 里默认关闭**（模块覆盖了 `defaultEnabled`）。在配置文件里加 `otel.instrumentation.mybatis.enabled=true` 就能生效（Run E）：

```
- SysUserServiceImpl.selectUserList <methods>
  - SysUserMapper.selectUserList [INTERNAL] <mybatis-3.2> code.namespace=com.ruoyi.system.mapper.SysUserMapper code.function=selectUserList
    - SELECT ry-vue [CLIENT] <jdbc> db.statement=SELECT count(?) FROM sys_user u LEFT JOIN sys_dept d …
    - SELECT ry-vue [CLIENT] <jdbc> db.statement=select u.user_id, …
```

  mapper span 只带 `code.namespace`（Mapper 接口的 FQN）和 `code.function`，不带 `db.*`。scope 是 `io.opentelemetry.mybatis-3.2@2.31.1-alpha`。全程 15 个 mapper span，每个 `/system/user/list` 请求 1 个。PageHelper 的 `count(?)` 和正式查询都挂在同一个 mapper span 下，所以 V4 担心的「count 无法归属」在开启 MyBatis 插桩后不存在了。
- **JDBC span**（scope `io.opentelemetry.jdbc`）默认（旧代）带这些属性：`db.system=mysql`、`db.name=ry-vue`、`db.user`、`db.connection_string`、`server.address/port`、`db.operation`（如 `SELECT`）、`db.statement`（已脱敏，字面量变成 `?`）。`db.sql.table` **只在单表语句里有**，例如 `SELECT ry-vue.sys_post` 带 `db.sql.table=sys_post`；JOIN 语句里没有，span 名退化成 `SELECT ry-vue`。任何模式下都**没有** `db.collection.name`。
- 稳定代（Run E2）新增 `db.query.text`、`db.query.summary`、`db.namespace`、`db.system.name`，没有 `db.operation.name` 和 `db.collection.name`。`db.query.summary` 会列出 JOIN 涉及的所有表，例如 `SELECT sys_user sys_dept`，span 名也变成它。要注意：`db.query.text` 里**保留了 SQL 原文中的字面量**，例如 `SELECT count(0)`，而旧代的 `db.statement` 是 `count(?)`。
- **JDBC span 的父节点**：没开 MyBatis 插桩时是最近的被插桩方法，也就是 service impl（`SysUserServiceImpl.selectUserList`），或者 `LogAspect.doAfterReturning` 这类；开了以后是 mapper span。
- 异步情况：`@Log` 写操作日志用的是 `AsyncManager` 线程池。`INSERT ry-vue.sys_oper_log` 跑在 `thread.name=schedule-pool-1` 上，父节点是 `LogAspect.doAfterReturning`（线程 `http-nio-8080-exec-19`），开始时间比父 span 结束晚 15 ms。上下文跨线程传过来了，可以靠线程名不同、开始时间晚于父 span 结束来判定异步。
- Redis（lettuce-5.1）span 的 `db.statement` 会带完整 key，例如 `GET login_tokens:eb18a57f-…`，这是登录会话 ID。

## ④ http.route

- RuoYi-Vue 默认 `server.servlet.context-path: /`，也就是没有前缀，route 形如 `/system/user/list`。
- 路径变量保留模板写法：`url.path=/system/user/1` 对应 `http.route=/system/user/{userId}`，SERVER span 名为 `GET /system/user/{userId}`。
- 设了 context-path 后（Run E，`/ctx`），**route 会带上前缀**：`http.route=/ctx/system/user/list`、`/ctx/system/user/{userId}`，`url.path` 也带。所以对账前要先去掉 context-path，或者在比对静态 path 时加上它。
- SERVER span 默认带这些属性：`http.request.method`、`http.route`、`http.response.status_code`、`url.path`、`url.scheme`、`server.address/port`、`client.address`、`user_agent.original`、`network.peer.address/port`、`network.protocol.version`、`thread.*`。默认不带 `url.query`。

## ⑤ semconv 代际

- **默认是旧代**：方法 span 用 `code.namespace` + `code.function`，DB 用 `db.statement` / `db.operation` / `db.sql.table` / `db.name` / `db.system`。没有 `code.function.name`，也没有 `db.query.text`。
- `otel.semconv-stability.opt-in=database/dup,code/dup` **写在配置文件里不生效**（Run E：同一个文件里的 `mybatis.enabled` 生效了，opt-in 却没有）。**只有作为 `-D` 系统属性（或环境变量）传入时才生效**（Run E2）。生效后两代属性同时出现：`code.function.name=com.ruoyi.system.service.impl.SysUserServiceImpl.selectUserList`（完整 FQN.method），以及 `db.query.text` / `db.query.summary` / `db.namespace` / `db.system.name`。lettuce 的 span 名也会从 `GET` 变成 `GET localhost:6379`。

## ⑥ Run C：`mvn spring-boot:run`

有效命令（工作目录 `E:\tools\ruoyi-vue-build\ruoyi-admin`；ruoyi-admin 依赖兄弟模块，事先要在根目录跑一次 `mvn -q -DskipTests install`）：

```
E:\tools\maven\bin\mvn.cmd -B -q spring-boot:run ^
  "-Dspring-boot.run.agents=C:\Users\admin\.project-atlas\agents\opentelemetry-javaagent-2.31.1.jar" ^
  "-Dspring-boot.run.jvmArguments=-Dotel.javaagent.configuration-file=E:\project-atlas\scripts\spike\otel-ruoyi.properties"
```

- 结果：stdout 里 agent 横幅（`opentelemetry-javaagent - version: 2.31.1`）**只出现 1 次**，124 个 span 全部来自同一个 `process.pid`。fork 出来的 JVM 命令行是 `java.exe -javaagent:…\opentelemetry-javaagent-2.31.1.jar -XX:TieredStopAtLevel=1 -Dotel.javaagent.configuration-file=… com.ruoyi.RuoYiApplication`，**Maven 自身的 JVM 没有被插桩** ✅。
- 对照组 C2（`JAVA_TOOL_OPTIONS`）：stdout 里出现 2 次 `Picked up JAVA_TOOL_OPTIONS` 和 2 次 agent 横幅，Maven JVM 也被插桩了，启动多花约 7 s。这次 Maven 是离线的 `-q` 运行，没有发出 span；可一旦它要下载依赖，就会产生 HTTP CLIENT span。而且**两个 JVM 读的是同一个配置文件，`service.name` 都是 `ruoyi-admin`**，所以 spec V1 说的「按 `service.name` 过滤」区分不了，得用 `process.pid` 或 `process.command_line`（里面有 `plexus-classworlds`）来区分。
- 在 Git Bash 里设了 `MSYS_NO_PATHCONV=1` 后，`mvn` 的 sh 启动脚本会失败（`ClassNotFoundException: org.codehaus.plexus.classworlds.launcher.Launcher`），改用 `mvn.cmd` 就正常了。

## ⑦ Run D：路径含空格或中文（JDK 21，系统 ANSI 代码页 936/GBK）

| 方式 | `E:\tools\space dir\` | `E:\tools\测试目录\` / `E:\tools\测试 目录\` | `E:\tools\한글 dir\`（字符不在 GBK 内） |
|---|---|---|---|
| argv `-javaagent:<path>`（ProcessBuilder 风格，单个参数） | ✅ | ⚠️ 能加载，span 全部正常（D1 跑完整 RuoYi，124 span），但 **`VersionLogger` 打出 `version: null`，resource 里缺少 `telemetry.distro.name/version`** | ❌ JVM 启动失败：`Error opening zip file or JAR manifest missing : E:\tools\?? dir\…` / `agent library failed Agent_OnLoad: instrument` |
| `JAVA_TOOL_OPTIONS` 整段加双引号 `"-javaagent:<path>"` | ✅ | ⚠️ 同上（version null） | 未测，预计和 argv 一样失败 |
| `JAVA_TOOL_OPTIONS` 不加引号 | ❌ `Unrecognized option: dir\…` | 不含空格时 ⚠️；含空格时 ❌ | — |
| `.bat`（命令行里加引号） | — | 文件编码和当前控制台代码页一致时 ⚠️，不一致时 ❌：本会话控制台是 65001，GBK 编码的 .bat 会把路径读成 `????` 而失败，UTF-8 编码的才行 | — |

结论：在 JDK 21 上，只要正确传参，空格不是问题；**非 ASCII 字符本身就是问题**。在中文系统上路径还能用，但 agent 的元数据会丢；系统代码页覆盖不到的字符（例如英文版 Windows 上的中文路径）会直接让 JVM 起不来。JDK 8 不支持引号这一点本次没有验证（没装 JDK 8）。

## 其他观测

- **controller-telemetry（Run B）**：每个请求多出 1 个 `io.opentelemetry.spring-webmvc-3.1` 的 INTERNAL span，名字是 `Controller.method`，带 `code.namespace` 和 `code.function`。全程 124 → 132 个，每个 `/system/user/list` 请求 11 → 12 个。它的好处是**能覆盖静态图漏掉的 handler**（`ServerController.getInfo`、`SysUserController.getInfo`、`CaptchaController.getCode` 都有 span），代价是 controller 在清单里时会出现父子同名的重复。
- **每个 `/system/user/list` 请求的 span 数**：A 是 11 个（tomcat 1、methods 7、lettuce 1、jdbc 2）；B 是 12 个；E 是 12 个（多了 mybatis 1 个）；Araw 是 112 个。
- **从请求到导出**：`otel.bsp.schedule.delay=500` 时，`/system/user/list` 发出后第一个 OTLP 请求到达接收器用了 89–577 ms（各 Run：A 328/577、B 342、C 288、D1 282、E 480、E2 338、Araw 89）。离 AC#19 的 10 s 余量很大。启动到健康检查通过约 14–21 s。
- **OTLP 请求**：`content-type: application/x-protobuf`，**默认不压缩**（没有 `Content-Encoding`），同时带 `accept-encoding: gzip, identity`。`authorization` header 按配置文件里的 `otel.exporter.otlp.headers` 原样发送（已核对等于 `Bearer s0-test-token`）。接收器回空 body + 200，exporter 接受，没有重试。
- **agent 警告**：所有 Run 里都没有 otel 的 WARN 或 ERROR。只有 JVM 打了一条 `Sharing is only supported for boot loader classes because bootstrap classpath has been appended`（agent 的正常副作用）。第一次跑 Run E 时接收器没起来，agent 大约每 9 s 打一条 `ERROR … HttpExporter - Failed to export spans … ConnectException: Failed to connect to /127.0.0.1:43180`，应用没受影响。
- **resource 属性**：带完整的 `process.command_line`（含所有 `-D` 参数）、`process.executable.path`、`host.name`、`os.*`、`process.pid`、`telemetry.*`。
- **夹具安全检查**：在所有 raw/*.pb 里 grep `Bearer`、`s0-test-token`、`eyJhbGci`（JWT 前缀），都没有命中。`requests.jsonl` 里的 authorization 已经打码，`requests-sent.txt` 里登录返回的 token 也已打码。不过 .pb 里仍然有本地测试会话的 Redis key（`login_tokens:<uuid>`）、主机名和本机路径，这些是本地测试数据，不算凭据。

## 建议修改 spec 的地方

1. **V4 Mapper 层**：改成「配置文件固定写 `otel.instrumentation.mybatis.enabled=true`」（2.31.1 默认关闭，从配置文件打开有效），Mapper 接口**不进**方法清单（写了也无效，白占长度）。JDBC 归属顺序改为 mybatis span → 父 service 方法；不需要再比对「`db.operation` + 表名 vs Mapper XML」，只在用户关掉 mybatis 插桩时作为兜底。
2. **V4 清单生成**：core 静态图把实体类、注解、`AjaxResult`、`TableDataInfo` 的 getter/setter 标成了 `service` step，生成清单时必须过滤（本次规则是：类名含 `.domain.`、`.entity.`、`.vo.`、`.annotation.`、`.page.`，或方法名是 `get`/`set`/`is` 开头），否则 span 量会放大 10 倍。更好的做法是在 core 里修正 step 分类。另外请 core 修复漏掉的 handler：`@GetMapping()`、`@GetMapping(value = {"/", "/{userId}"})`、`CaptchaController`，以及 interceptor 层挂 controller 符号的那个 step。
3. **V4 / R2 controller**：建议打开 `otel.instrumentation.common.experimental.controller-telemetry.enabled=true`，它能捕获静态图漏掉的 handler，正好服务于「仅运行时」差异。R2 要加一条规则：父子 span 的 `code.namespace` + `code.function` 相同时合并成一个 step，耗时取内层（methods）的。这条规则也能处理重载（`TokenService.createToken`）造成的嵌套。
4. **V1 / V3 semconv**：`otel.semconv-stability.opt-in` **只能用 `-D` 或环境变量传，写在配置文件里无效**。建议默认不 opt-in，只依赖旧代属性（`code.namespace`/`code.function`、`db.statement`/`db.sql.table`），同时保留解析新代 `code.function.name`（FQN.method，需要按最后一个 `.` 切开）和 `db.query.summary` 的能力。V5 白名单里的 `db.collection.name` 在 JDBC 上不会出现，表名应该改从 `db.sql.table` 或 `db.query.summary` 取。
5. **V3 路径**：「复制到纯 ASCII 短路径」要**对所有 Java 版本**生效，只要路径含非 ASCII 字符就复制，不能只针对 Java 8。原因是 JDK 21 在系统代码页覆盖不到的字符上会直接启动失败，覆盖得到时也会丢失 agent 版本元数据。空格在 argv 和加引号的 `JAVA_TOOL_OPTIONS` 里都没问题，但 `JAVA_TOOL_OPTIONS` 必须加引号。另外，不要靠 resource 里的 `telemetry.distro.version` 判断 agent 版本。
6. **V1 `JAVA_TOOL_OPTIONS` 路径**（`mvn test` / Gradle）：构建工具的 JVM 会用同一个配置文件，`service.name` 一样，「按 `service.name` 过滤」不成立。应该改成按 resource 的 `process.command_line` 判断（含 `org.codehaus.plexus.classworlds` 或 `GradleDaemon`/`GradleWorkerMain` 的丢弃），或者用 `process.pid` 加上第一次出现应用包名 span 的 JVM 来判定。
7. **V5 隐私**：白名单要**同时覆盖 resource 属性**。`process.command_line` 会带上全部 `-D` 参数，可能有 `-Dspring.datasource.password=…`；另外 `host.name` 和本机路径也在 resource 里。建议 resource 只保留 `service.name`、`process.pid`、`telemetry.sdk.*`。Redis 的 `db.statement` 里有会话 key，这和「不存 SQL 文本」一样，都必须丢弃；`client.address`、`network.peer.*`、`user_agent.original` 也不要落盘。
8. **V7 切面和异步**：切面 advice 的 span 挂在「最近的被插桩帧」下面，可能是 controller，也可能是 filter，和静态图里 aspect → 目标方法的关系不一样。R2 应该把 aspect span 按 step 直接匹配，**不要用它的父子关系去生成 runtime-observed 边**。异步判定条件可以写成：子 span 的 `thread.name` 和父 span 不同，并且子 span 开始时间晚于父 span 结束。
9. **V4 / R2 context-path**：`http.route` 带 context-path（`/ctx/system/user/{userId}`），对账时要从应用配置（`server.servlet.context-path`）读出前缀去掉，或者从 route 和 `url.path` 的公共前缀推断。
