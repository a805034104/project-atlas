/**
 * Realistic RuoYi-Cloud-flavoured mock data for `npm run dev` and tests.
 * Services: ruoyi-gateway / ruoyi-system / ruoyi-auth / ruoyi-ui.
 * Showcase flow: GET /system/user/list
 *   ruoyi-ui listUser → gateway AuthFilter → JwtAuthenticationTokenFilter
 *   (→ Feign RemoteTokenService → ruoyi-auth TokenController.verify)
 *   → RepeatSubmitInterceptor → @PreAuthorize → SysUserController.list
 *   → (@DataScope aspect) → ISysUserService ×2 implementations
 *   → SysUserMapper.selectUserList → SysUserMapper.xml <select>
 *   plus one ai-inferred external HTTP call and one recursive call.
 */

import type {
  RuntimeState,
  RuntimeStats,
  TraceData,
  TraceDetailData,
  TraceSpanView,
  AnalysisState,
  CallEdge,
  CommitRecord,
  Entrypoint,
  Feature,
  FlowDetailData,
  FlowLayer,
  FlowListData,
  FlowStep,
  HistoryData,
  Module,
  ModuleHistory,
  ModulesData,
  OverviewData,
  Service,
  ServiceLink,
  SourceRef,
  StartupData,
  StartupGuide,
  TopologyData,
  FeaturesData,
} from "@project-atlas/core";

const ROOT = "r-ruoyi-cloud";

function src(file: string, line?: number): SourceRef {
  return line !== undefined ? { rootId: ROOT, file, line } : { rootId: ROOT, file };
}

export const services: Service[] = [
  { id: "svc-gateway", name: "ruoyi-gateway", rootId: ROOT, path: "ruoyi-gateway", stack: "java-spring", kind: "gateway", evidence: src("ruoyi-gateway/pom.xml", 1) },
  { id: "svc-system", name: "ruoyi-system", rootId: ROOT, path: "ruoyi-modules/ruoyi-system", stack: "java-spring", kind: "backend", evidence: src("ruoyi-modules/ruoyi-system/pom.xml", 1) },
  { id: "svc-auth", name: "ruoyi-auth", rootId: ROOT, path: "ruoyi-auth", stack: "java-spring", kind: "backend", evidence: src("ruoyi-auth/pom.xml", 1) },
  { id: "svc-ui", name: "ruoyi-ui", rootId: ROOT, path: "ruoyi-ui", stack: "vue", kind: "frontend", evidence: src("ruoyi-ui/package.json", 1) },
];

export const serviceRefs = services.map((s) => ({ id: s.id, name: s.name }));

export const modules: Module[] = [
  { id: "mod-system", serviceId: "svc-system", name: "ruoyi-system", path: "ruoyi-modules/ruoyi-system", kind: "build-module", summary: "System management: users, roles, menus, departments, dictionaries and parameters.\n\nOwns the sys_* tables and exposes the admin REST API behind the gateway.", dependsOn: ["mod-common-core", "mod-common-security", "mod-common-datascope"], fileCount: 214, loc: 18_420 },
  { id: "mod-auth", serviceId: "svc-auth", name: "ruoyi-auth", path: "ruoyi-auth", kind: "build-module", summary: "Login, logout, token refresh and registration; issues JWTs stored in Redis.", dependsOn: ["mod-common-core", "mod-common-security"], fileCount: 18, loc: 1_260 },
  { id: "mod-gateway", serviceId: "svc-gateway", name: "ruoyi-gateway", path: "ruoyi-gateway", kind: "build-module", dependsOn: ["mod-common-core"], fileCount: 31, loc: 2_140 },
  { id: "mod-ui", serviceId: "svc-ui", name: "ruoyi-ui", path: "ruoyi-ui", kind: "frontend-app", summary: "Vue 2 + Element UI admin console.", dependsOn: [], fileCount: 402, loc: 36_900 },
  { id: "mod-common-core", serviceId: "svc-system", name: "ruoyi-common-core", path: "ruoyi-common/ruoyi-common-core", kind: "build-module", dependsOn: [], fileCount: 96, loc: 7_310 },
  { id: "mod-common-security", serviceId: "svc-system", name: "ruoyi-common-security", path: "ruoyi-common/ruoyi-common-security", kind: "build-module", dependsOn: ["mod-common-core"], fileCount: 22, loc: 1_480 },
  { id: "mod-common-datascope", serviceId: "svc-system", name: "ruoyi-common-datascope", path: "ruoyi-common/ruoyi-common-datascope", kind: "build-module", dependsOn: ["mod-common-security"], fileCount: 3, loc: 210 },
];

export const commits90d: Record<string, number> = {
  "mod-system": 38,
  "mod-ui": 24,
  "mod-auth": 9,
  "mod-common-security": 7,
  "mod-gateway": 4,
  "mod-common-core": 2,
  "mod-common-datascope": 0,
};

// ---------- entrypoints ----------

const SYS = "com.ruoyi.system.controller";

function httpEp(serviceId: string, method: string, path: string, cls: string, fn: string, file: string, line: number): Entrypoint {
  const pkg = serviceId === "svc-auth" ? "com.ruoyi.auth.controller" : SYS;
  return {
    id: `ep:${method} ${path}`,
    serviceId,
    kind: "http",
    method,
    path,
    handler: { rootId: ROOT, file, line, name: `${cls}.${fn}`, fqn: `${pkg}.${cls}#${fn}` },
  };
}

const sysFile = (cls: string) => `ruoyi-modules/ruoyi-system/src/main/java/com/ruoyi/system/controller/${cls}.java`;

const crud: [string, string][] = [
  ["user", "SysUserController"],
  ["role", "SysRoleController"],
  ["menu", "SysMenuController"],
  ["dept", "SysDeptController"],
  ["post", "SysPostController"],
  ["dict/type", "SysDictTypeController"],
  ["dict/data", "SysDictDataController"],
  ["config", "SysConfigController"],
  ["notice", "SysNoticeController"],
  ["operlog", "SysOperlogController"],
  ["logininfor", "SysLogininforController"],
];

export const entrypoints: Entrypoint[] = [];
for (const [res, cls] of crud) {
  let line = 40;
  const add = (method: string, path: string, fn: string) => {
    entrypoints.push(httpEp("svc-system", method, `/system/${res}${path}`, cls, fn, sysFile(cls), line));
    line += 14;
  };
  add("GET", "/list", "list");
  add("GET", "/{}", "getInfo");
  add("POST", "", "add");
  add("PUT", "", "edit");
  add("DELETE", "/{}", "remove");
  add("POST", "/export", "export");
}
entrypoints.push(httpEp("svc-system", "PUT", "/system/user/resetPwd", "SysUserController", "resetPwd", sysFile("SysUserController"), 220));
entrypoints.push(httpEp("svc-system", "PUT", "/system/user/changeStatus", "SysUserController", "changeStatus", sysFile("SysUserController"), 236));
const authFile = "ruoyi-auth/src/main/java/com/ruoyi/auth/controller/TokenController.java";
entrypoints.push(httpEp("svc-auth", "POST", "/auth/login", "TokenController", "login", authFile, 36));
entrypoints.push(httpEp("svc-auth", "DELETE", "/auth/logout", "TokenController", "logout", authFile, 48));
entrypoints.push(httpEp("svc-auth", "POST", "/auth/refresh", "TokenController", "refresh", authFile, 62));
entrypoints.push(httpEp("svc-auth", "POST", "/auth/register", "TokenController", "register", authFile, 74));
for (const [route, view] of [
  ["/system/user", "views/system/user/index.vue"],
  ["/system/role", "views/system/role/index.vue"],
  ["/system/menu", "views/system/menu/index.vue"],
  ["/login", "views/login.vue"],
] as const) {
  entrypoints.push({
    id: `ep:route ${route}`,
    serviceId: "svc-ui",
    kind: "frontend-route",
    path: route,
    handler: { rootId: ROOT, file: `ruoyi-ui/src/${view}`, line: 1, name: view.split("/").slice(-2).join("/"), fqn: `ruoyi-ui/src/${view}` },
  });
}

export const USER_LIST_EP = "ep:GET /system/user/list";
export const USER_ADD_EP = "ep:POST /system/user";

// ---------- showcase flow ----------

function step(id: string, serviceId: string, layer: FlowLayer, name: string, fqn: string, file: string, line: number): FlowStep {
  return { id, serviceId, layer, symbol: { rootId: ROOT, file, line, name, fqn } };
}

const J = "ruoyi-modules/ruoyi-system/src/main/java/com/ruoyi/system";
const SEC = "ruoyi-common/ruoyi-common-security/src/main/java/com/ruoyi/common/security";

export const userListSteps: FlowStep[] = [
  step("s-ui", "svc-ui", "frontend", "user.js listUser", "ruoyi-ui/src/api/system/user.js#listUser", "ruoyi-ui/src/api/system/user.js", 5),
  step("s-gw", "svc-gateway", "filter", "AuthFilter.filter", "com.ruoyi.gateway.filter.AuthFilter#filter(ServerWebExchange,GatewayFilterChain)", "ruoyi-gateway/src/main/java/com/ruoyi/gateway/filter/AuthFilter.java", 47),
  step("s-jwt", "svc-system", "filter", "JwtAuthenticationTokenFilter.doFilterInternal", "com.ruoyi.framework.security.filter.JwtAuthenticationTokenFilter#doFilterInternal(HttpServletRequest,HttpServletResponse,FilterChain)", `${SEC}/filter/JwtAuthenticationTokenFilter.java`, 33),
  step("s-remote", "svc-system", "external-http", "RemoteTokenService.verify", "com.ruoyi.system.api.RemoteTokenService#verify(String)", "ruoyi-api/ruoyi-api-system/src/main/java/com/ruoyi/system/api/RemoteTokenService.java", 21),
  step("s-auth-ctrl", "svc-auth", "controller", "TokenController.verify", "com.ruoyi.auth.controller.TokenController#verify(String)", authFile, 88),
  step("s-auth-svc", "svc-auth", "service", "SysLoginService.verify", "com.ruoyi.auth.service.SysLoginService#verify(String)", "ruoyi-auth/src/main/java/com/ruoyi/auth/service/SysLoginService.java", 112),
  step("s-repeat", "svc-system", "interceptor", "RepeatSubmitInterceptor.preHandle", "com.ruoyi.common.security.interceptor.RepeatSubmitInterceptor#preHandle(HttpServletRequest,HttpServletResponse,Object)", `${SEC}/interceptor/RepeatSubmitInterceptor.java`, 26),
  step("s-preauth", "svc-system", "interceptor", "@PreAuthorize ss.hasPermi", "com.ruoyi.common.security.service.PermissionService#hasPermi(String)", `${SEC}/service/PermissionService.java`, 41),
  step("s-ctrl", "svc-system", "controller", "SysUserController.list", "com.ruoyi.system.controller.SysUserController#list(SysUser)", `${J}/controller/SysUserController.java`, 66),
  step("s-aspect", "svc-system", "aspect", "DataScopeAspect.doBefore", "com.ruoyi.common.datascope.aspect.DataScopeAspect#doBefore(JoinPoint,DataScope)", "ruoyi-common/ruoyi-common-datascope/src/main/java/com/ruoyi/common/datascope/aspect/DataScopeAspect.java", 64),
  step("s-svc", "svc-system", "service", "SysUserServiceImpl.selectUserList", "com.ruoyi.system.service.impl.SysUserServiceImpl#selectUserList(SysUser)", `${J}/service/impl/SysUserServiceImpl.java`, 79),
  step("s-svc2", "svc-system", "service", "SysUserCachedServiceImpl.selectUserList", "com.ruoyi.system.service.impl.SysUserCachedServiceImpl#selectUserList(SysUser)", `${J}/service/impl/SysUserCachedServiceImpl.java`, 52),
  step("s-mapper", "svc-system", "repository", "SysUserMapper.selectUserList", "com.ruoyi.system.mapper.SysUserMapper#selectUserList(SysUser)", `${J}/mapper/SysUserMapper.java`, 25),
  step("s-sql", "svc-system", "sql", "select#selectUserList", "mapper/system/SysUserMapper.xml#selectUserList", "ruoyi-modules/ruoyi-system/src/main/resources/mapper/system/SysUserMapper.xml", 58),
  step("s-ext", "svc-system", "external-http", "UserSyncClient.push", "com.ruoyi.system.client.UserSyncClient#push(List)", `${J}/client/UserSyncClient.java`, 30),
  step("s-dept", "svc-system", "service", "SysDeptServiceImpl.recursionFn", "com.ruoyi.system.service.impl.SysDeptServiceImpl#recursionFn(List,SysDept)", `${J}/service/impl/SysDeptServiceImpl.java`, 301),
];

function edge(id: string, from: string, to: string, order: number, provenance: CallEdge["provenance"], confidence = 1, rationale?: string): CallEdge {
  return { id, from, to, order, provenance, confidence, ...(rationale !== undefined ? { rationale } : {}) };
}

export const userListEdges: CallEdge[] = [
  edge("e-ui-gw", "s-ui", "s-gw", 0, "framework-rule", 1, "vue.config.js devServer.proxy /dev-api → ruoyi-gateway; route Path=/system/** → lb://ruoyi-system"),
  edge("e-gw-jwt", "s-gw", "s-jwt", 0, "framework-rule"),
  edge("e-jwt-remote", "s-jwt", "s-remote", 0, "static"),
  edge("e-remote-auth", "s-remote", "s-auth-ctrl", 0, "framework-rule", 1, "@FeignClient(contextId=\"remoteTokenService\", value=ServiceNameConstants.AUTH_SERVICE)"),
  edge("e-auth-svc", "s-auth-ctrl", "s-auth-svc", 0, "static"),
  edge("e-jwt-repeat", "s-jwt", "s-repeat", 1, "framework-rule"),
  edge("e-repeat-pre", "s-repeat", "s-preauth", 0, "framework-rule"),
  edge("e-pre-ctrl", "s-preauth", "s-ctrl", 0, "framework-rule", 1, "@PreAuthorize(\"@ss.hasPermi('system:user:list')\")"),
  edge("e-ctrl-aspect", "s-ctrl", "s-aspect", 0, "framework-rule", 1, "@DataScope(deptAlias = \"d\", userAlias = \"u\") on ISysUserService.selectUserList"),
  edge("e-ctrl-svc", "s-ctrl", "s-svc", 1, "static", 1, "ISysUserService has 2 implementations; no @Primary / @Qualifier — branch 1 of 2"),
  edge("e-ctrl-svc2", "s-ctrl", "s-svc2", 1, "static", 1, "ISysUserService has 2 implementations; no @Primary / @Qualifier — branch 2 of 2"),
  edge("e-svc-mapper", "s-svc", "s-mapper", 0, "static"),
  edge("e-mapper-sql", "s-mapper", "s-sql", 0, "framework-rule", 1, "MyBatis namespace com.ruoyi.system.mapper.SysUserMapper, <select id=\"selectUserList\">"),
  edge("e-svc-ext", "s-svc", "s-ext", 1, "ai-inferred", 0.72, "HttpUtils.sendPost(syncUrl, body): syncUrl comes from sys.user.sync-url; matched to UserSyncClient by URL template"),
  edge("e-svc-dept", "s-svc", "s-dept", 2, "static"),
  edge("e-dept-dept", "s-dept", "s-dept", 0, "static"),
  edge("e-svc2-mapper", "s-svc2", "s-mapper", 0, "static"),
];

export function userListDetail(): FlowDetailData {
  const ep = entrypoints.find((e) => e.id === USER_LIST_EP) as Entrypoint;
  return {
    entrypoint: ep,
    flow: { entrypointId: ep.id, stepIds: userListSteps.map((s) => s.id), edgeIds: userListEdges.map((e) => e.id), truncated: false },
    steps: userListSteps,
    edges: userListEdges,
    services: serviceRefs,
    unresolvedCalls: [
      { fromStepId: "s-svc", expression: "restTemplate.exchange(url, HttpMethod.POST, entity, String.class)", reason: "unresolved-config", at: src(`${J}/service/impl/SysUserServiceImpl.java`, 96) },
      { fromStepId: "s-jwt", expression: "SpringUtils.getBean(handlerName).handle(request)", reason: "dynamic-dispatch", at: src(`${SEC}/filter/JwtAuthenticationTokenFilter.java`, 51) },
    ],
  };
}

/** Generic controller → service → mapper → SQL chain for every other entrypoint. */
export function genericDetail(ep: Entrypoint, depth = 12): FlowDetailData {
  const base = ep.handler.name.split(".")[0] ?? "Sys";
  const entity = base.replace(/Controller$/, "");
  const fn = ep.handler.name.split(".")[1] ?? "handle";
  const svcId = ep.serviceId;
  const steps: FlowStep[] = [
    step(`${ep.id}:ctrl`, svcId, "controller", ep.handler.name, ep.handler.fqn, ep.handler.file, ep.handler.line ?? 1),
    step(`${ep.id}:svc`, svcId, "service", `${entity}ServiceImpl.${fn}`, `com.ruoyi.system.service.impl.${entity}ServiceImpl#${fn}`, `${J}/service/impl/${entity}ServiceImpl.java`, 40),
    step(`${ep.id}:mapper`, svcId, "repository", `${entity}Mapper.${fn}`, `com.ruoyi.system.mapper.${entity}Mapper#${fn}`, `${J}/mapper/${entity}Mapper.java`, 20),
    step(`${ep.id}:sql`, svcId, "sql", `sql#${fn}`, `mapper/system/${entity}Mapper.xml#${fn}`, `ruoyi-modules/ruoyi-system/src/main/resources/mapper/system/${entity}Mapper.xml`, 30),
  ];
  const edges: CallEdge[] = [
    edge(`${ep.id}:e1`, steps[0]!.id, steps[1]!.id, 0, "static"),
    edge(`${ep.id}:e2`, steps[1]!.id, steps[2]!.id, 0, "static"),
    edge(`${ep.id}:e3`, steps[2]!.id, steps[3]!.id, 0, "framework-rule"),
  ];
  return {
    entrypoint: ep,
    flow: { entrypointId: ep.id, stepIds: steps.map((s) => s.id), edgeIds: edges.map((e) => e.id), truncated: ep.id === USER_ADD_EP && depth <= 12 },
    steps,
    edges,
    services: serviceRefs,
    unresolvedCalls: [],
  };
}

/** Runtime overlay on a flow (aggregated mode): every step and static edge observed, plus one runtime-observed edge. */
function withObserved(detail: FlowDetailData): FlowDetailData {
  const stats = (count: number, p95Ms: number, errorCount = 0): RuntimeStats => ({ count, p50Ms: Math.round(p95Ms * 0.6 * 10) / 10, p95Ms, errorCount, lastSeen: new Date(T0).toISOString(), sampleTraceIds: [TRACE_A] });
  const steps = detail.steps.map((s, i) => (s.layer === "external-http" ? s : { ...s, observed: stats(40, Math.max(1, 38 - i * 3)) }));
  const edges = detail.edges.map((e, i) => (e.chain || e.provenance === "ai-inferred" ? e : { ...e, observed: stats(40, Math.max(1, 30 - i * 2), i === 3 ? 3 : 0) }));
  const [a, b] = steps.filter((s) => s.layer === "service");
  const runtime = a && b ? [{ id: "e-runtime", from: a.id, to: b.id, order: 1000, provenance: "runtime-observed" as const, confidence: 1, rationale: "observed at runtime", observed: stats(4, 2.1) }] : [];
  return { ...detail, entrypoint: { ...detail.entrypoint, observed: stats(40, 38.4) }, steps, edges: [...edges, ...runtime] };
}

export function flowDetail(entrypointId: string, depth?: number, observed = false): FlowDetailData | undefined {
  if (entrypointId === USER_LIST_EP) return observed ? withObserved(userListDetail()) : userListDetail();
  const ep = entrypoints.find((e) => e.id === entrypointId);
  return ep ? genericDetail(ep, depth) : undefined;
}

// ---------- links ----------

export const links: ServiceLink[] = [
  { id: "l-ui-gw", fromServiceId: "svc-ui", toServiceId: "svc-gateway", kind: "frontend-proxy", channel: "/dev-api/** → :8080", fromStepId: "s-ui", provenance: "framework-rule", confidence: 1, evidence: [src("ruoyi-ui/vue.config.js", 35)] },
  { id: "l-gw-sys", fromServiceId: "svc-gateway", toServiceId: "svc-system", kind: "gateway-route", channel: "Path=/system/**", fromStepId: "s-gw", provenance: "framework-rule", confidence: 1, evidence: [src("ruoyi-gateway/src/main/resources/bootstrap.yml", 28)] },
  { id: "l-gw-auth", fromServiceId: "svc-gateway", toServiceId: "svc-auth", kind: "gateway-route", channel: "Path=/auth/**", fromStepId: "s-gw", provenance: "framework-rule", confidence: 1, evidence: [src("ruoyi-gateway/src/main/resources/bootstrap.yml", 22)] },
  { id: "l-sys-auth", fromServiceId: "svc-system", toServiceId: "svc-auth", kind: "http", channel: "POST /token/verify", fromStepId: "s-remote", toEntrypointId: "ep:POST /auth/refresh", provenance: "static", confidence: 1, evidence: [src("ruoyi-api/ruoyi-api-system/src/main/java/com/ruoyi/system/api/RemoteTokenService.java", 21)] },
  { id: "l-auth-sys", fromServiceId: "svc-auth", toServiceId: "svc-system", kind: "http", channel: "GET /user/info/{}", fromStepId: "s-auth-svc", provenance: "ai-inferred", confidence: 0.81, evidence: [src("ruoyi-auth/src/main/java/com/ruoyi/auth/service/SysLoginService.java", 60)] },
];

// ---------- startup ----------

export const startupGuides: StartupGuide[] = [
  {
    target: "ruoyi-system (Spring Boot)",
    serviceId: "svc-system",
    prerequisites: [
      { name: "JDK", version: "17", evidence: src("pom.xml", 32) },
      { name: "MySQL", version: "8.0", evidence: src("sql/ry_20240629.sql", 1) },
      { name: "Redis", evidence: src("ruoyi-modules/ruoyi-system/src/main/resources/bootstrap.yml", 18) },
      { name: "Nacos", version: "2.x", evidence: src("ruoyi-modules/ruoyi-system/src/main/resources/bootstrap.yml", 12) },
    ],
    steps: [
      { command: "mvn -pl ruoyi-modules/ruoyi-system -am clean package -DskipTests", cwd: "", evidence: src("pom.xml", 1) },
      { command: "java -jar ruoyi-modules/ruoyi-system/target/ruoyi-modules-system.jar", cwd: "", evidence: src("ruoyi-modules/ruoyi-system/pom.xml", 80) },
    ],
    ports: [{ port: 9201, evidence: src("ruoyi-modules/ruoyi-system/src/main/resources/bootstrap.yml", 3) }],
    configFiles: [src("ruoyi-modules/ruoyi-system/src/main/resources/bootstrap.yml"), src("sql/ry_config_20240902.sql")],
  },
  {
    target: "ruoyi-gateway",
    serviceId: "svc-gateway",
    prerequisites: [{ name: "JDK", version: "17", evidence: src("pom.xml", 32) }],
    steps: [{ command: "mvn -pl ruoyi-gateway -am spring-boot:run", cwd: "", evidence: src("ruoyi-gateway/pom.xml", 1) }],
    ports: [{ port: 8080, evidence: src("ruoyi-gateway/src/main/resources/bootstrap.yml", 3) }],
    configFiles: [src("ruoyi-gateway/src/main/resources/bootstrap.yml")],
  },
  {
    target: "ruoyi-ui (Vue CLI)",
    serviceId: "svc-ui",
    prerequisites: [{ name: "Node.js", version: ">=14", evidence: src("ruoyi-ui/package.json", 70) }],
    steps: [
      { command: "npm install --registry=https://registry.npmmirror.com", cwd: "ruoyi-ui", evidence: src("ruoyi-ui/README.md", 12) },
      { command: "npm run dev", cwd: "ruoyi-ui", evidence: src("ruoyi-ui/package.json", 7) },
    ],
    ports: [{ port: 80, evidence: src("ruoyi-ui/vue.config.js", 12) }],
    configFiles: [src("ruoyi-ui/vue.config.js"), src("ruoyi-ui/.env.development")],
  },
];

// ---------- features ----------

export const features: Feature[] = [
  { id: "f-user", title: "User & permission management", description: "Users, roles, menus and data-scope permissions for the admin console.", tier: "core", moduleIds: ["mod-system", "mod-common-datascope"], entrypointIds: [USER_LIST_EP, USER_ADD_EP, "ep:GET /system/role/list"] },
  { id: "f-auth", title: "Login & token lifecycle", description: "Password login, JWT issuance, refresh and logout via ruoyi-auth.", tier: "core", moduleIds: ["mod-auth", "mod-common-security"], entrypointIds: ["ep:POST /auth/login", "ep:POST /auth/refresh", "ep:DELETE /auth/logout"] },
  { id: "f-org", title: "Organisation structure", description: "Department tree and posts.", tier: "core", moduleIds: ["mod-system"], entrypointIds: ["ep:GET /system/dept/list", "ep:GET /system/post/list"] },
  { id: "f-dict", title: "Dictionaries & parameters", description: "Dictionary types/data and system parameters cached in Redis.", tier: "secondary", moduleIds: ["mod-system"], entrypointIds: ["ep:GET /system/dict/type/list", "ep:GET /system/config/list"] },
  { id: "f-audit", title: "Audit logs", description: "Operation and login logs with export.", tier: "secondary", moduleIds: ["mod-system"], entrypointIds: ["ep:GET /system/operlog/list", "ep:GET /system/logininfor/list"] },
];

// ---------- history ----------

/** Deterministic PRNG so the mock (and tests) are stable. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const AUTHORS = ["RuoYi", "若依", "lishuai", "chenzx", "wangyu"];
const MESSAGES: Record<string, string[]> = {
  "mod-system": ["优化用户导入校验", "fix: data scope for dept filter", "新增用户密码策略配置", "升级 mybatis 版本", "修复角色分配菜单回显问题"],
  "mod-ui": ["升级 element-ui 到 2.15.14", "表格列显隐支持持久化", "fix: 路由缓存失效", "新增个人中心头像裁剪"],
  "mod-auth": ["登录失败次数锁定", "refresh token 支持滑动过期", "fix: logout 未清理 redis"],
  "mod-common-security": ["PreAuthorize 支持 hasAnyPermi", "fix: 内部请求鉴权绕过"],
  "mod-gateway": ["网关验证码过滤器", "XSS 过滤白名单"],
  "mod-common-core": ["StringUtils 新增 isMatch"],
};

const LATEST = Date.parse("2026-10-12T09:30:00Z");
const WEEK = 7 * 86_400_000;

export const historyModuleIds = ["mod-system", "mod-ui", "mod-auth", "mod-common-security", "mod-gateway", "mod-common-core"];

export function buildHistory(): ModuleHistory[] {
  const rand = rng(42);
  return historyModuleIds.map((moduleId, mi) => {
    const total = commits90d[moduleId] ?? 0;
    const msgs = MESSAGES[moduleId] ?? ["chore: update"];
    const commits: CommitRecord[] = Array.from({ length: total }, (_, i) => {
      const t = LATEST - Math.floor(rand() * 12 * WEEK);
      const msg = msgs[i % msgs.length] ?? "chore";
      return {
        sha: (((mi + 1) * 0x9e3779b1 + i * 0x85ebca6b) >>> 0).toString(16).padStart(8, "0") + "c0ffee" + String(i).padStart(4, "0"),
        authorTime: new Date(t).toISOString(),
        author: AUTHORS[Math.floor(rand() * AUTHORS.length)] ?? "RuoYi",
        message: msg,
        added: Math.floor(rand() * 120) + 1,
        deleted: Math.floor(rand() * 60),
        files: Array.from({ length: Math.floor(rand() * 4) + 1 }, (_, k) => `${moduleId}/file${k}.java`),
      };
    });
    const h: ModuleHistory = { moduleId, commits };
    if (moduleId === "mod-system") {
      h.aiSummary =
        "过去 12 周的改动集中在用户与权限：先补齐数据权限（@DataScope）对部门过滤的缺陷，随后引入密码策略配置。\n\n导入导出与角色菜单回显是反复修改的热点，建议补充回归测试。";
    }
    return h;
  });
}

// ---------- view payloads ----------

export function overviewData(withAi: boolean): OverviewData {
  const hot = [...modules]
    .map((m) => ({ module: m, commits90d: commits90d[m.id] ?? 0 }))
    .sort((a, b) => b.commits90d - a.commits90d);
  return {
    projectName: "RuoYi-Cloud",
    stacks: ["java-spring", "vue"],
    serviceCount: services.length,
    moduleCount: modules.length,
    entrypointCount: entrypoints.length,
    coreFeatures: withAi ? features.filter((f) => f.tier === "core") : [],
    candidateFeatures: [
      { title: "SysUser (user management)", moduleIds: ["mod-system"], entrypointIds: [USER_LIST_EP] },
      { title: "SysRole (roles)", moduleIds: ["mod-system"], entrypointIds: ["ep:GET /system/role/list"] },
      { title: "Token (login / logout)", moduleIds: ["mod-auth"], entrypointIds: ["ep:POST /auth/login"] },
    ],
    primaryStartup: startupGuides[0] as StartupGuide,
    hotModules: hot,
    diagnostics: [
      { code: "ATLAS-E010", severity: "warning", message: "2 files failed to parse (generated code?)", at: src("ruoyi-ui/src/assets/icons/svg/index.js", 1) },
      { code: "ATLAS-I002", severity: "info", message: "Nacos shared-configs resolved from bootstrap.yml" },
    ],
    llmUsage: withAi ? [{ provider: "anthropic", model: "claude-haiku", phase: "module-summaries", inputTokens: 182_400, outputTokens: 9_820 }] : [],
  };
}

export const topologyData = (): TopologyData => ({ services, links, unresolvedCount: 2 });
export const modulesData = (): ModulesData => ({ services, modules, commits90d });
export const featuresData = (withAi: boolean): FeaturesData => ({
  features: withAi ? features : [],
  modules: modules.map((m) => ({ id: m.id, name: m.name })),
  entrypoints,
});
export const startupData = (): StartupData => ({ guides: startupGuides, inspectedFiles: [] });
export const flowListData = (): FlowListData => ({ services: serviceRefs, entrypoints });
export const historyData = (): HistoryData => ({
  modules: modules.map((m) => ({ id: m.id, name: m.name, serviceId: m.serviceId })),
  history: buildHistory(),
});

export function doneState(overrides: Partial<AnalysisState> = {}): AnalysisState {
  return {
    status: "done",
    completedPhases: ["parse", "rules", "cross-service", "history", "ai"],
    staleFiles: 0,
    ai: "done",
    ...overrides,
  };
}

// ── v0.2 runtime (Trace tab) ─────────────────────────────────────────────────
const TRACE_A = "4f2a9c0e7b1d4a3c9e8f00112233aabb";
const TRACE_B = "9a8b7c6d5e4f30211201ffeeddccbbaa";
const T0 = Date.parse("2026-10-15T14:02:11Z");

export function runtimeState(status: RuntimeState["status"] = "receiving"): RuntimeState {
  return { status, port: 43180, spans: status === "off" ? 0 : 132, duplicates: 0, rejected: status === "receiving" ? 3 : 0, since: T0 - 60_000, trusted: true };
}

/**
 * Trace tab scenarios (state matrix rows): receiving (default), off (never started), waiting,
 * downloading, error (receiver failed), history (app exited, statistics kept), restricted.
 */
export type RuntimeScenario = "receiving" | "off" | "waiting" | "downloading" | "error" | "history" | "restricted";

function scenarioRuntime(scenario: RuntimeScenario): RuntimeState {
  switch (scenario) {
    case "off":
    case "history":
      return { ...runtimeState("off"), spans: scenario === "history" ? 132 : 0 };
    case "waiting":
      return { ...runtimeState("waiting"), spans: 0 };
    case "downloading":
      return { ...runtimeState("downloading"), spans: 0, agent: { received: 10_485_760, total: 25_107_554, source: "repo1.maven.org" } };
    case "error":
      return {
        ...runtimeState("error"),
        spans: 0,
        error: {
          code: "ATLAS-E073",
          problem: "The trace receiver stopped: port 43180 is now used by another process.",
          cause: "listen EADDRINUSE 127.0.0.1:43180",
          fix: "Restart the traced application so it picks up the new receiver port.",
          docsUrl: "https://github.com/a805034104/project-atlas/blob/main/docs/errors.md#atlas-e073",
        },
      };
    case "restricted":
      return { ...runtimeState("off"), trusted: false };
    default:
      return runtimeState("receiving");
  }
}

export function traceData(withTraces = true, scenario: RuntimeScenario = withTraces ? "receiving" : "off"): TraceData {
  withTraces &&= scenario === "receiving" || scenario === "history";
  return {
    runtime: scenarioRuntime(scenario),
    services: serviceRefs.filter((s) => s.id !== "svc-ui"),
    suggestedRequest: { method: "GET", url: "http://localhost:8080/captchaImage" },
    traces: withTraces
      ? [
          { traceId: TRACE_A, start: T0, durationMs: 38.4, error: false, spans: 14, services: ["ruoyi-gateway", "ruoyi-system", "ruoyi-auth"], rootName: "GET /system/user/list", entrypointId: USER_LIST_EP, coverage: { observed: 9, instrumentable: 10 } },
          { traceId: TRACE_B, start: T0 - 13_000, durationMs: 12.1, error: true, spans: 3, services: ["ruoyi-system"], rootName: "GET /captchaImage" },
        ]
      : [],
    diff: withTraces
      ? {
          observedEntrypoints: 2,
          totalEntrypoints: entrypoints.length,
          runtimeOnly: [
            { from: "SysConfigServiceImpl.selectCaptchaEnabled", to: "SysConfigServiceImpl.selectConfigByKey", count: 4, async: false, drawn: true },
            { from: "SysLoginService.login", to: "SysUserServiceImpl.selectUserByUserName", count: 1, async: false, drawn: false },
          ],
          unmatched: [],
          links: { observed: 2, total: links.length },
          runtimeLinks: [{ fromService: "ruoyi-system", toService: "ruoyi-job", kind: "mq", channel: "kafka:audit", count: 3 }],
        }
      : { observedEntrypoints: 0, totalEntrypoints: entrypoints.length, runtimeOnly: [], unmatched: [], links: { observed: 0, total: links.length }, runtimeLinks: [] },
  };
}

export function traceDetail(traceId: string): TraceDetailData | undefined {
  if (traceId !== TRACE_A) return undefined;
  const span = (id: string, parent: string | undefined, name: string, layer: string | undefined, stepId: string | undefined, offsetMs: number, durationMs: number, extra: Partial<TraceSpanView> = {}): TraceSpanView => ({
    spanId: id.padEnd(16, "0"),
    ...(parent ? { parentSpanId: parent.padEnd(16, "0") } : {}),
    name,
    ...(layer ? { layer } : {}),
    ...(stepId ? { stepId } : {}),
    service: "ruoyi-system",
    offsetMs,
    durationMs,
    error: false,
    async: false,
    ...extra,
  });
  return {
    traceId,
    start: T0,
    entrypointId: USER_LIST_EP,
    spans: [
      span("1", undefined, "GET /system/user/list", "entrypoint", undefined, 0, 38.4),
      span("2", "1", "JwtAuthenticationTokenFilter.doFilterInternal", "filter", "s-jwt", 0.4, 37.6),
      span("3", "2", "RepeatSubmitInterceptor.preHandle", "interceptor", "s-repeat", 1.1, 0.05),
      span("4", "2", "SysUserController.list", "controller", "s-ctrl", 1.3, 30.2),
      span("5", "4", "DataScopeAspect.doBefore", "aspect", "s-aspect", 1.4, 0.06),
      span("6", "4", "SysUserServiceImpl.selectUserList", "service", "s-svc", 1.6, 21.0),
      span("7", "6", "SysUserMapper.selectUserList", "repository", "s-mapper", 1.7, 12.4),
      span("8", "7", "SELECT sys_user", "sql", "s-sql", 1.9, 11.8),
      span("9", "2", "HikariPool.getConnection", undefined, undefined, 1.8, 0.4),
      span("a", "4", "INSERT sys_oper_log", "sql", undefined, 33.0, 2.1, { async: true }),
    ],
  };
}
