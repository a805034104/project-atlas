import { describe, expect, it } from "vitest";
import { analyzeWorkspace } from "../../src/analyze.js";
import { parseYamlConfig } from "../../src/config/sources.js";
import { ConfigView } from "../../src/config/view.js";
import { GraphBuilder } from "../../src/graph/builder.js";
import type { Entrypoint } from "../../src/model/types.js";
import { applyEdgeOverrides, isIgnoredEntrypoint } from "../../src/overrides/apply.js";
import { applyRoute, EntrypointIndex, matchEntrypoint, parseGatewayRoutes } from "../../src/rules/xservice.js";
import { GraphView } from "../../src/store/graph-store.js";
import type { JavaService } from "../../src/workspace/detect.js";
import { FIXTURES, haveFixtures } from "../helpers/fixtures.js";
import { analyzeTree, calleesOf, nacosDump, pom, springApp, writeTree } from "../helpers/synthetic.js";

describe("GraphBuilder flow projection", () => {
  it("is cycle-safe, ordered by edge.order and truncates exactly at depth", () => {
    const g = new GraphBuilder();
    const s = (n: string) => g.step("s", "s", "service", n, { rootId: "r", file: "f", line: 1, name: n, fqn: n });
    const [a, b, c, d] = ["a", "b", "c", "d"].map(s) as [string, string, string, string];
    g.edge(a, b, { provenance: "static" });
    g.edge(b, a, { provenance: "static" });
    expect(g.projectFlow("e1", [], [], a)).toMatchObject({ stepIds: [a, b], truncated: false });
    g.edge(b, c, { provenance: "static", order: 2 });
    g.edge(b, d, { provenance: "static", order: 1 });
    expect(g.projectFlow("e2", [], [], a, 3)).toMatchObject({ stepIds: [a, b, d, c], truncated: false });
    expect(g.projectFlow("e3", [], [], a, 2)).toMatchObject({ stepIds: [a, b, d, c], truncated: true });
    expect(g.projectFlow("e4", [], [], a, 1)).toMatchObject({ stepIds: [a, b], truncated: true });
  });

  it("stays linear on diamond-shaped call graphs", () => {
    const g = new GraphBuilder();
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) ids.push(g.step("s", "s", "service", `n${i}`, { rootId: "r", file: "f", line: 1, name: `n${i}`, fqn: `n${i}` }));
    // each layer of two nodes fully connected to the next: 2^20 paths, 40 nodes
    for (let i = 0; i + 2 < ids.length; i += 2) {
      for (const from of [ids[i], ids[i + 1]]) for (const to of [ids[i + 2], ids[i + 3]]) if (from && to) g.edge(from, to, { provenance: "static" });
    }
    const started = Date.now();
    const flow = g.projectFlow("diamond", [], [], ids[0] as string, 40);
    expect(Date.now() - started).toBeLessThan(500);
    expect(flow.stepIds.length).toBe(39); // ids[1] is only a sibling of the start
  });
});

describe("overrides", () => {
  it("removes/adds edges by symbol name or fqn and reports unmatched refs", () => {
    const g = new GraphBuilder();
    const sym = (n: string) => ({ rootId: "r", file: "f", line: 1, name: n, fqn: `com.x.${n}` });
    const a = g.step("s", "s", "service", "a", sym("A.run"));
    const b = g.step("s", "s", "service", "b", sym("B.go"));
    g.edge(a, b, { provenance: "static" });
    const d = applyEdgeOverrides(g, { remove: [{ from: "A.run", to: "com.x.B.go" }, { from: "nope", to: "B.go" }], add: [{ from: "B.go", to: "A.run", note: "manual" }] });
    expect(g.outgoing(a)).toEqual([]);
    expect(g.outgoing(b).map((e) => [e.to, e.rationale])).toEqual([[a, "atlas.yaml: manual"]]);
    expect(d.map((x) => x.code)).toEqual(["ATLAS-W021"]);
  });

  it("ignoreEntrypoints honours method, ROUTE and bare patterns", () => {
    const ep = (kind: Entrypoint["kind"], method: string | undefined, p: string) =>
      ({ id: p, serviceId: "s", kind, ...(method ? { method } : {}), path: p, handler: { rootId: "r", file: "X.java", line: 1, name: "h", fqn: "h" } }) as Entrypoint;
    expect(isIgnoredEntrypoint(ep("http", "GET", "/actuator/health"), ["GET /actuator/**"])).toBe(true);
    expect(isIgnoredEntrypoint(ep("http", "POST", "/actuator/health"), ["GET /actuator/**"])).toBe(false);
    expect(isIgnoredEntrypoint(ep("frontend-route", undefined, "/a/test/b"), ["**/test/**"])).toBe(true);
    expect(isIgnoredEntrypoint(ep("frontend-route", undefined, "/x"), ["ROUTE /x"])).toBe(true);
  });

  it("an edges.remove entry disappears from every projected flow", async () => {
    const dir = await writeTree(
      springApp({
        "Svc.java": "@Service public class Svc { public void run() {} }",
        "Ctl.java": '@RestController public class Ctl { @Autowired private Svc svc; @GetMapping("/x") public void x() { svc.run(); } }',
      }),
    );
    const overrides = { version: 1, services: [], wrappers: [], edges: { add: [], remove: [{ from: "Ctl.x", to: "Svc.run" }] }, ignoreEntrypoints: ["GET /hidden"] };
    const { graph } = await analyzeWorkspace({ roots: [{ path: dir }], history: false, overrides });
    const edgeIds = new Set(graph.edges.map((e) => e.id));
    expect(graph.flows.every((f) => f.edgeIds.every((id) => edgeIds.has(id)))).toBe(true);
    expect(calleesOf(graph, "GET", "/x")).toEqual([]);
  });
});

describe("cross-service matching and gateway routes", () => {
  it.each([(e: Entrypoint[]) => e, (e: Entrypoint[]) => new EntrypointIndex(e)])("prefers literal segments and exact methods", (wrap) => {
    const e = (id: string, method: string, p: string, serviceId = "s") => ({ id, serviceId, kind: "http", method, path: p, handler: {} }) as Entrypoint;
    const all = wrap([e("var", "GET", "/user/{}"), e("lit", "GET", "/user/profile"), e("any", "ANY", "/user/profile"), e("other", "GET", "/user/profile", "t")]);
    expect(matchEntrypoint(all, "s", "GET", "/user/profile")?.id).toBe("lit");
    expect(matchEntrypoint(all, "s", "GET", "/user/42")?.id).toBe("var");
    expect(matchEntrypoint(all, "s", "GET", "/user/{}")?.id).toBe("var");
    expect(matchEntrypoint(all, "s", "POST", "/user/profile")?.id).toBe("any");
    expect(matchEntrypoint(all, "s", "GET", "/user/profile/x")).toBeUndefined();
  });

  const gateway = (yaml: string) =>
    ({ service: { rootId: "r", name: "gw", id: "gw", kind: "gateway" }, config: new ConfigView([{ name: "application.yml", documents: parseYamlConfig(yaml, "r", "application.yml") }]) }) as unknown as JavaService;

  it("parses default-filters, RewritePath with a quantifier comma, and PrefixPath", () => {
    const yaml = [
      "spring:",
      "  cloud:",
      "    gateway:",
      "      default-filters:",
      "        - StripPrefix=1",
      "      routes:",
      "        - id: b",
      "          uri: lb://b",
      "          predicates:",
      "            - Path=/api/b/**",
      "          filters:",
      "            - RewritePath=/b/(?<v>v[0-9]{1,2})/(?<rest>.*), /$\\{rest}",
      "        - id: c",
      "          uri: lb://c",
      "          predicates:",
      "            - Path=/c/**,/legacy-c/**",
      "          filters:",
      "            - PrefixPath=/svc",
    ].join("\n");
    const [b, c] = parseGatewayRoutes(gateway(yaml));
    expect(b?.stripPrefix).toBe(1);
    expect(b?.rewrite).toBeDefined();
    expect(applyRoute(b as NonNullable<typeof b>, "/api/b/v1/user/list")).toBe("/user/list");
    expect(c?.paths).toEqual(["/c/**", "/legacy-c/**"]);
    expect(applyRoute(c as NonNullable<typeof c>, "/c/user/list")).toBe("/svc/user/list");
  });

  it("infers a code-side prefix strip and marks it ai-inferred (dashed, 0.6)", async () => {
    const dir = await writeTree({
      "gw/pom.xml": pom("gw", ["spring-cloud-starter-gateway"]),
      "gw/src/main/java/g/GwApp.java": "package g;\n@SpringBootApplication public class GwApp {}",
      "gw/src/main/resources/application.yml":
        "server:\n  port: 8080\nspring:\n  application:\n    name: gw\n  cloud:\n    gateway:\n      routes:\n        - id: unknown\n          uri: lb://not-in-workspace\n          predicates:\n            - Path=/sys/**\n        - id: sys\n          uri: lb://sys\n          predicates:\n            - Path=/sys/**\n",
      "sys/pom.xml": pom("sys"),
      "sys/src/main/java/s/SysApp.java": "package s;\n@SpringBootApplication public class SysApp {}",
      "sys/src/main/java/s/U.java": 'package s;\n@RestController @RequestMapping("/user") public class U { @GetMapping("/list") public Object list() { return null; } }',
      "sys/src/main/resources/application.yml": "server:\n  port: 9201\nspring:\n  application:\n    name: sys\n",
      "ui/package.json": JSON.stringify({ name: "ui", dependencies: { vue: "3" } }),
      "ui/vite.config.js": "export default { server: { proxy: { '/dev-api': { target: 'http://localhost:8080', rewrite: (p) => p.replace(/^\\/dev-api/, '') } } } }",
      "ui/.env.development": "VITE_APP_BASE_API=/dev-api\n",
      "ui/src/utils/request.js": "import axios from 'axios'\nconst service = axios.create({ baseURL: import.meta.env.VITE_APP_BASE_API })\nexport default service",
      "ui/src/api/user.js": "import request from '@/utils/request'\nexport function listUser() { return request({ url: '/sys/user/list', method: 'get' }) }",
    });
    const { graph } = await analyzeWorkspace({ roots: [{ path: dir }], history: false });
    const link = graph.serviceLinks.find((l) => l.kind === "gateway-route");
    expect(link?.toEntrypointId).toBeDefined();
    expect(link).toMatchObject({ provenance: "ai-inferred", confidence: 0.6 });
    expect(link?.rationale).toContain("strips the first segment");
  });
});

describe("Spring DI and framework inheritance", () => {
  const svc = {
    "Svc.java": "public interface Svc { void run(); }",
    "A.java": '@Service("a") public class A implements Svc { public void run() {} }',
    "B.java": '@Service("b") public class B implements Svc { public void run() {} }',
  };
  const ctl = (field: string, name: string) => `@RestController public class Ctl { ${field} @GetMapping("/x") public void x() { ${name}.run(); } }`;

  it.each([
    ['@Qualifier("b") @Autowired private Svc svc;', "svc", true, ["B.run"]],
    ['@Resource(name = "b") private Svc svc;', "svc", true, ["B.run"]],
    ["@Autowired private Svc svc;", "svc", true, ["P.run"]],
    ["@Autowired private Svc b;", "b", false, ["B.run"]],
  ])("picks the right bean for %s", async (field, name, withPrimary, expected) => {
    const graph = await analyzeTree(
      springApp({ ...svc, ...(withPrimary ? { "P.java": "@Primary @Service public class P implements Svc { public void run() {} }" } : {}), "Ctl.java": ctl(field, name) }),
    );
    expect(calleesOf(graph, "GET", "/x").map((c) => c.name)).toEqual(expected);
  });

  it("fans out with a branch per implementation when ambiguous", async () => {
    const graph = await analyzeTree(springApp({ ...svc, "Ctl.java": ctl("@Autowired private Svc svc;", "svc") }));
    const callees = calleesOf(graph, "GET", "/x");
    expect(callees.map((c) => c.name).sort()).toEqual(["A.run", "B.run"]);
    expect(callees.every((c) => c.rationale?.startsWith("2 implementations of Svc"))).toBe(true);
  });

  it("shows MyBatis-Plus inherited methods and external-interface implementors", async () => {
    const graph = await analyzeTree(
      springApp({
        "UserMapper.java": "import com.baomidou.mybatisplus.core.mapper.BaseMapper;\n@Mapper public interface UserMapper extends BaseMapper<User> {}",
        "IUserService.java": "import com.baomidou.mybatisplus.extension.service.IService;\npublic interface IUserService extends IService<User> {}",
        "UserServiceImpl.java": "import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;\n@Service public class UserServiceImpl extends ServiceImpl<UserMapper, User> implements IUserService {}",
        "Handler.java": "import ext.IChat;\n@Component public class Handler implements IChat { public void chat(String s) {} }",
        "Ctl.java":
          'import ext.IChat;\n@RestController public class Ctl { @Autowired UserMapper m; @Autowired IUserService s; @Autowired IChat c; @GetMapping("/x") public void x() { m.selectById(1); s.save(null); c.chat(""); } }',
      }),
    );
    const callees = calleesOf(graph, "GET", "/x");
    expect(callees).toContainEqual({ name: "UserMapper.selectById (BaseMapper)", rationale: "inherited from BaseMapper" });
    expect(callees.some((c) => c.name === "UserServiceImpl.save (ServiceImpl)" && c.rationale === "inherited from ServiceImpl")).toBe(true);
    expect(callees.some((c) => c.name === "Handler.chat" && c.rationale === "implements external interface IChat")).toBe(true);
  });

  it("orders security filters by anchor and honours interceptor excludes", async () => {
    const graph = await analyzeTree(
      springApp({
        "FA.java": "@Component public class FA extends OncePerRequestFilter { protected void doFilterInternal(Object a, Object b, Object c) {} }",
        "FB.java": "@Component public class FB extends OncePerRequestFilter { protected void doFilterInternal(Object a, Object b, Object c) {} }",
        "Sec.java": "@Configuration public class Sec { @Autowired FA fa; @Autowired FB fb; @Bean SecurityFilterChain c(HttpSecurity h) { h.addFilter(fa); h.addFilterBefore(fb, FA.class); return null; } }",
        "I.java": "@Component public class I implements HandlerInterceptor { public boolean preHandle(Object a, Object b, Object c) { return true; } }",
        "Mvc.java": '@Configuration public class Mvc implements WebMvcConfigurer { @Autowired I i; public void addInterceptors(InterceptorRegistry r) { r.addInterceptor(i).addPathPatterns("/api/**").excludePathPatterns("/api/login"); } }',
        "Ctl.java": '@RestController @RequestMapping("/api") public class Ctl { @GetMapping("/login") public void login() {} @GetMapping("/me") public void me() {} }',
      }),
    );
    const view = new GraphView(graph);
    const chain = (p: string) => {
      const ep = graph.entrypoints.find((e) => e.path === p);
      return (view.flowDetail(ep?.id ?? "")?.steps ?? []).map((s) => `${s.layer}:${s.symbol.name.split(".")[0]}`);
    };
    expect(chain("/api/me").filter((s) => s.startsWith("filter:"))).toEqual(["filter:FB", "filter:FA"]);
    expect(chain("/api/me")).toContain("interceptor:I");
    expect(chain("/api/login")).not.toContain("interceptor:I");
  });
});

describe("detection paths used by pig / vben-style projects", () => {
  it("loads Nacos dataIds from spring.config.import (later import wins) without server-addr", async () => {
    const dir = await writeTree({
      ...springApp({}, {
        "src/main/resources/application.yml": "spring:\n  application:\n    name: app\n  config:\n    import:\n      - optional:nacos:a.yml\n      - optional:nacos:b.yml\n",
      }),
      "db/nacos.sql": nacosDump({ "a.yml": "server:\n  port: 1111\n", "b.yml": "server:\n  port: 2222\n" }),
    });
    const { project } = await analyzeWorkspace({ roots: [{ path: dir }], history: false });
    expect(project.java[0]?.port).toBe(2222);
  });

  it("substitutes Maven @tokens@ in service names", async () => {
    const graph = await analyzeTree(springApp({}, { "src/main/resources/application.yml": "spring:\n  application:\n    name: '@artifactId@'\n" }));
    expect(graph.services.map((s) => s.name)).toEqual(["app"]);
  });

  it("reads vben VITE_PROXY and resolves defHttp enum URLs and nested sys_menu routes", async () => {
    const dir = await writeTree({
      "package.json": JSON.stringify({ name: "ui", dependencies: { vue: "3" } }),
      ".env.development": 'VITE_PROXY=[["/jeecgboot","http://localhost:8080/jeecg-boot"]]\nVITE_GLOB_API_URL=/jeecgboot\n',
      "src/utils/http/axios/index.ts": "export const defHttp = createAxios();",
      "src/api/user.api.ts": "import { defHttp } from '/@/utils/http/axios';\nenum Api { list = '/sys/user/list' }\nexport const list = (params) => defHttp.get({ url: Api.list, params });",
      "src/views/system/user/index.vue": "<script setup>\nimport { list } from '/@/api/user.api'\nlist()\n</script>",
      "db/menu.sql":
        "INSERT INTO sys_menu (menu_id, menu_name, parent_id, path, component, menu_type) VALUES (1,'系统',0,'system',NULL,'M'),(100,'用户',1,'user','system/user/index','C'),(9,'loop',9,'x','system/user/index','C');",
    });
    const { project, graph } = await analyzeWorkspace({ roots: [{ path: dir }], history: false });
    const ui = project.frontends[0];
    expect(ui?.proxies).toMatchObject([{ prefix: "/jeecgboot", target: "http://localhost:8080/jeecg-boot", stripPrefix: true }]);
    expect(ui?.baseApi).toBe("/jeecgboot");
    // No backend in this workspace: the call stays unresolved but keeps its resolved browser path.
    expect(graph.unresolvedCalls.some((u) => u.expression.startsWith("GET /jeecgboot/sys/user/list"))).toBe(true);
    expect(graph.entrypoints.filter((e) => e.kind === "frontend-route").map((e) => e.path)).toContain("/system/user");
  });
});

describe.skipIf(!haveFixtures(FIXTURES.ruoyiCloud, FIXTURES.ruoyiCloudVue3))("expand more (deepen)", () => {
  it("keeps the stored chain order on a multi-hop gateway flow", async () => {
    const { graph } = await analyzeWorkspace({ roots: [{ path: FIXTURES.ruoyiCloud }, { path: FIXTURES.ruoyiCloudVue3 }], history: false });
    const ep = graph.entrypoints.find((e) => e.method === "GET" && e.path === "/user/list");
    const view = new GraphView(graph);
    const base = view.flowDetail(ep?.id ?? "")?.steps ?? [];
    const deep = view.flowDetail(ep?.id ?? "", 30)?.steps ?? [];
    const ctl = base.findIndex((s) => s.layer === "controller");
    expect(deep[0]?.layer).toBe("frontend");
    expect(deep.slice(0, ctl + 1).map((s) => s.id)).toEqual(base.slice(0, ctl + 1).map((s) => s.id));
  });
});
