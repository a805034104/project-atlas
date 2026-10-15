import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeWorkspace } from "../../src/analyze.js";
import { parseYamlConfig } from "../../src/config/sources.js";
import { ConfigView } from "../../src/config/view.js";
import type { Entrypoint } from "../../src/model/types.js";
import { matchEntrypoint } from "../../src/rules/xservice.js";
import { loadStoredGraph, saveGraph } from "../../src/store/graph-store.js";
import { analyzeTree, calleesOf, springApp, writeTree } from "../helpers/synthetic.js";

describe("red-team regressions", () => {
  it("replaces lists wholesale across config layers (no index-wise splicing)", () => {
    const high = parseYamlConfig("routes:\n  - id: auth\n    uri: lb://auth\n    predicates:\n      - Path=/auth/**\n", "r", "nacos.yml");
    const low = parseYamlConfig("routes:\n  - id: old\n    predicates:\n      - Path=/auth/**\n      - Path=/legacy/**\n    filters:\n      - StripPrefix=1\n  - id: legacy2\n", "r", "application.yml");
    const view = new ConfigView([
      { name: "nacos", documents: high },
      { name: "local", documents: low },
    ]);
    expect(view.list("routes").map((e) => `${e.key}=${e.value}`)).toEqual(["routes[0].id=auth", "routes[0].uri=lb://auth", "routes[0].predicates[0]=Path=/auth/**"]);
  });

  it("prefers a literal ANY mapping over a variable GET mapping regardless of order", () => {
    const e = (id: string, method: string, p: string) => ({ id, serviceId: "s", kind: "http", method, path: p, handler: {} }) as Entrypoint;
    expect(matchEntrypoint([e("var", "GET", "/user/{}"), e("lit", "ANY", "/user/list")], "s", "GET", "/user/list")?.id).toBe("lit");
    expect(matchEntrypoint([e("lit", "ANY", "/user/list"), e("var", "GET", "/user/{}")], "s", "GET", "/user/list")?.id).toBe("lit");
  });

  it("keeps handlers that share METHOD+path (header/param conditions) as separate entrypoints", async () => {
    const graph = await analyzeTree(
      springApp({
        "V1.java": "@Service public class V1 { public void list() {} }",
        "V2.java": "@Service public class V2 { public void list() {} }",
        "Ctl.java":
          '@RestController public class Ctl { @Autowired V1 v1; @Autowired V2 v2; @GetMapping(value = "/user/list", headers = "X-API-VERSION=1") public void listV1() { v1.list(); } @GetMapping(value = "/user/list", headers = "X-API-VERSION=2") public void listV2() { v2.list(); } }',
      }),
    );
    const eps = graph.entrypoints.filter((e) => e.path === "/user/list");
    expect(eps.map((e) => e.handler.name).sort()).toEqual(["Ctl.listV1", "Ctl.listV2"]);
    expect(new Set(graph.flows.map((f) => f.entrypointId)).size).toBe(graph.flows.length);
    expect(graph.diagnostics.some((d) => d.code === "ATLAS-I005")).toBe(true);
  });

  it("marks unresolved placeholders and constants instead of turning them into path variables", async () => {
    const graph = await analyzeTree(
      springApp({
        "Ctl.java": '@RestController @RequestMapping("${api.prefix}/user") public class Ctl { @GetMapping(Missing.BASE + "/list") public void list() {} @GetMapping("/info") public void info() {} }',
      }),
    );
    const paths = graph.entrypoints.filter((e) => e.kind === "http").map((e) => e.path ?? "");
    expect(paths.length).toBe(2);
    expect(paths.every((p) => p.includes("⟨unresolved⟩"))).toBe(true);
    expect(paths.some((p) => p.includes("{}"))).toBe(false);
    expect(graph.diagnostics.filter((d) => d.code === "ATLAS-W011").length).toBeGreaterThanOrEqual(2);
  });

  it("edges.remove on a cross-service hop also removes the link and the upstream lane", async () => {
    const backend = springApp({ "U.java": '@RestController @RequestMapping("/user") public class U { @GetMapping("/list") public Object list() { return null; } }' });
    const dir = await writeTree({
      ...Object.fromEntries(Object.entries(backend).map(([k, v]) => [`api/${k}`, v])),
      "ui/package.json": JSON.stringify({ name: "ui", dependencies: { vue: "3" } }),
      "ui/vite.config.js": "export default { server: { proxy: { '/dev-api': { target: 'http://localhost:8080', rewrite: (p) => p.replace(/^\\/dev-api/, '') } } } }",
      "ui/.env.development": "VITE_APP_BASE_API=/dev-api\n",
      "ui/src/utils/request.js": "import axios from 'axios'\nconst service = axios.create({ baseURL: import.meta.env.VITE_APP_BASE_API })\nexport default service",
      "ui/src/api/user.js": "import request from '@/utils/request'\nexport function listUser() { return request({ url: '/user/list', method: 'get' }) }",
    });
    const base = await analyzeWorkspace({ roots: [{ path: dir }], history: false });
    expect(base.graph.serviceLinks.length).toBe(1);
    const overrides = { version: 1, services: [], wrappers: [], edges: { add: [], remove: [{ from: "listUser()", to: "U.list" }] }, ignoreEntrypoints: [] };
    const { graph } = await analyzeWorkspace({ roots: [{ path: dir }], history: false, overrides });
    expect(graph.serviceLinks).toEqual([]);
    const ep = graph.entrypoints.find((e) => e.path === "/user/list");
    const flow = graph.flows.find((f) => f.entrypointId === ep?.id);
    const steps = new Map(graph.steps.map((s) => [s.id, s]));
    expect(flow?.stepIds.some((id) => steps.get(id)?.layer === "frontend")).toBe(false);
    expect(calleesOf(graph, "GET", "/user/list")).toEqual([]);
  });

  it("never serves a half-written store: missing shards force a rebuild", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "atlas-store-"));
    try {
      const graph = await analyzeTree(springApp({ "Ctl.java": '@RestController public class Ctl { @GetMapping("/x") public void x() {} }' }));
      await saveGraph(dir, graph);
      await saveGraph(dir, graph); // the second generation replaces the first
      const generations = (await readdir(path.join(dir, "graph"))).filter((d) => d.startsWith("services"));
      expect(generations).toHaveLength(1);
      expect((await loadStoredGraph(dir)).status).toBe("ok");
      await rm(path.join(dir, "graph", generations[0] as string), { recursive: true, force: true });
      expect(await loadStoredGraph(dir)).toMatchObject({ status: "rebuild" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("identical files parsed concurrently with a cache never report parse failures", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`src/main/java/p${i}/package-info.java`] = "package same;\n";
    const dir = await writeTree(files);
    const cache = await mkdtemp(path.join(tmpdir(), "atlas-cache-"));
    try {
      const { graph } = await analyzeWorkspace({ roots: [{ path: dir }], cacheDir: cache, history: false });
      expect(graph.diagnostics.filter((d) => d.code === "ATLAS-E010")).toEqual([]);
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });

  it("data objects and plain accessors are not flow steps (S0: 199 entity getters/setters as service steps)", async () => {
    const graph = await analyzeTree({
      "pom.xml": "<project><groupId>d</groupId><artifactId>app</artifactId></project>",
      "src/main/java/app/App.java": `package app;
@SpringBootApplication public class App {}`,
      "src/main/java/app/domain/User.java": `package app.domain;
public class User { private String name; public String getName() { return name; } public void setName(String n) { this.name = n; } public User copy() { return audit(this); } }`,
      "src/main/java/app/util/Page.java": `package app.util;
public class Page { private int total; public void setTotal(int t) { this.total = t; } public int compute() { return Math.max(total, 1); } }`,
      "src/main/java/app/UserService.java": `package app;
import app.domain.User;
@Service public class UserService { public User find() { return new User(); } }`,
      "src/main/java/app/UserController.java": `package app;
import app.domain.User;
import app.util.Page;
@RestController public class UserController {
  @Autowired private UserService userService;
  @GetMapping("/u") public Object get() { User u = userService.find(); u.setName("x"); u.copy(); Page p = new Page(); p.setTotal(1); return p.compute(); }
}`,
    });
    expect(calleesOf(graph, "GET", "/u").map((c) => c.name)).toEqual(["UserService.find", "Page.compute"]);
  });

  it("a class in a data package that calls a bean does real work and stays a step", async () => {
    const graph = await analyzeTree({
      "pom.xml": "<project><groupId>d</groupId><artifactId>app</artifactId></project>",
      "src/main/java/app/App.java": `package app;
@SpringBootApplication public class App {}`,
      "src/main/java/app/CouponService.java": `package app;
@Service public class CouponService { public int apply(int p) { return p; } }`,
      "src/main/java/app/model/PricingEngine.java": `package app.model;
import app.CouponService;
public class PricingEngine { private final CouponService couponService; public PricingEngine(CouponService c) { this.couponService = c; } public int calculate(int p) { return couponService.apply(p); } }`,
      "src/main/java/app/PriceController.java": `package app;
import app.model.PricingEngine;
@RestController public class PriceController {
  @Autowired private CouponService couponService;
  @GetMapping("/p") public int price() { PricingEngine e = new PricingEngine(couponService); return e.calculate(1); }
}`,
    });
    expect(calleesOf(graph, "GET", "/p").map((c) => c.name)).toEqual(["PricingEngine.calculate"]);
  });
});

