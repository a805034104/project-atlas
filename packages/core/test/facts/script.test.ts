import { beforeAll, describe, expect, it } from "vitest";
import { extractSfcScript } from "../../src/facts/script.js";
import type { ScriptFileFacts } from "../../src/facts/types.js";
import { extractFacts } from "../../src/parse/extract.js";
import { loadParsers, type ParserSet } from "../../src/parse/treesitter.js";

let set: ParserSet;
beforeAll(async () => {
  set = await loadParsers();
});

function script(kind: "javascript" | "typescript" | "vue", source: string, rel = "a.js"): ScriptFileFacts {
  const facts = extractFacts(set, kind, source, rel);
  if (!facts || facts.lang === "java") throw new Error("expected script facts");
  return facts;
}

const API = `
import request from '@/utils/request'
import { parseStrEmpty } from "@/utils/ruoyi";

// 查询用户列表
export function listUser(query) {
  return request({
    url: '/system/user/list',
    method: 'get',
    params: query
  })
}

export function getUser(userId) {
  return request({ url: '/system/user/' + parseStrEmpty(userId), method: 'get' })
}

export const delUser = (userId) => request({ url: \`/system/user/\${userId}\`, method: 'delete' })
`;

describe("extractScriptFacts", () => {
  it("captures imports", () => {
    const facts = script("javascript", API);
    expect(facts.imports).toEqual([
      { source: "@/utils/request", default: "request", named: [], line: 2 },
      { source: "@/utils/ruoyi", named: [{ imported: "parseStrEmpty", local: "parseStrEmpty" }], line: 3 },
    ]);
  });

  it("captures exported request helpers with their object arguments", () => {
    const facts = script("javascript", API);
    const list = facts.functions.find((f) => f.name === "listUser");
    expect(list?.exported).toBe(true);
    expect(list?.params).toEqual(["query"]);
    expect(list?.calls[0]).toMatchObject({
      callee: "request",
      args: [{ kind: "object", props: { url: { kind: "string", value: "/system/user/list" }, method: { kind: "string", value: "get" } } }],
    });
    const del = facts.functions.find((f) => f.name === "delUser");
    expect(del?.calls[0]?.args[0]).toMatchObject({ props: { url: { kind: "template", value: "/system/user/${userId}" } } });
    const get = facts.functions.find((f) => f.name === "getUser");
    expect(get?.calls.find((c) => c.callee === "request")?.args[0]).toMatchObject({ props: { url: { kind: "template", value: "/system/user/${parseStrEmpty(userId)}" } } });
  });

  it("captures route tables with lazy components", () => {
    const facts = script(
      "javascript",
      `
      import Layout from '@/layout'
      export const constantRoutes = [
        { path: '/login', component: () => import('@/views/login'), hidden: true },
        { path: '/user', component: Layout, children: [
          { path: 'profile', component: (resolve) => require(['@/views/system/user/profile/index'], resolve), name: 'Profile' }
        ]}
      ]
    `,
    );
    const routes = facts.variables.find((v) => v.name === "constantRoutes");
    expect(routes?.exported).toBe(true);
    expect(routes?.value).toMatchObject({
      kind: "array",
      items: [
        { kind: "object", props: { path: { value: "/login" }, component: { kind: "dynamic-import", source: "@/views/login" } } },
        {
          kind: "object",
          props: {
            component: { kind: "identifier", name: "Layout" },
            children: { kind: "array", items: [{ props: { component: { kind: "require", source: "@/views/system/user/profile/index" } } }] },
          },
        },
      ],
    });
  });

  it("captures default exports and CommonJS config objects", () => {
    const vueConfig = script(
      "javascript",
      `module.exports = { devServer: { port: 80, proxy: { [process.env.VUE_APP_BASE_API]: { target: 'http://localhost:8080', pathRewrite: { ['^' + process.env.VUE_APP_BASE_API]: '' } } } } }`,
    );
    expect(vueConfig.defaultExport).toMatchObject({ kind: "object", props: { devServer: { props: { port: { value: 80 } } } } });
    const vite = script("typescript", `export default defineConfig({ server: { port: 80, proxy: { '/dev-api': { target: 'http://localhost:8080', rewrite: (p) => p.replace(/^\\/dev-api/, '') } } } })`, "vite.config.ts");
    expect(vite.defaultExport).toMatchObject({ kind: "call", callee: "defineConfig", args: [{ props: { server: { props: { proxy: { props: { "/dev-api": { props: { target: { value: "http://localhost:8080" } } } } } } } } }] });
  });

  it("collects calls outside named functions (Vue options methods)", () => {
    const facts = script(
      "vue",
      `<template><div/></template>
<script>
import { listUser, delUser } from "@/api/system/user";
export default {
  name: "User",
  methods: {
    getList() {
      listUser(this.queryParams).then(res => { this.list = res.rows })
    }
  }
}
</script>`,
      "index.vue",
    );
    expect(facts.lang).toBe("vue");
    expect(facts.imports[0]?.named.map((n) => n.local)).toEqual(["listUser", "delUser"]);
    const call = facts.calls.find((c) => c.callee === "listUser");
    expect(call?.line).toBe(8);
  });
});

describe("extractSfcScript", () => {
  it("keeps line numbers aligned and merges script + script setup", () => {
    const src = `<template>\n  <div/>\n</template>\n<script>\nexport default {}\n</script>\n<script setup lang="ts">\nconst a: number = 1\n</script>\n`;
    const result = extractSfcScript(src);
    expect(result?.lang).toBe("typescript");
    const lines = result?.content.split("\n") ?? [];
    expect(lines[4]).toBe("export default {}");
    expect(lines[7]).toBe("const a: number = 1");
  });

  it("ignores external script src and template-only files", () => {
    expect(extractSfcScript(`<template><div/></template>`)).toBeUndefined();
    expect(extractSfcScript(`<script src="./x.js"></script>`)).toBeUndefined();
  });
});

describe("value shapes needed by the Vue rules", () => {
  it("turns string concatenation into templates", () => {
    const facts = script("javascript", `export function getUser(id) { return request({ url: '/system/user/' + parseStrEmpty(id) + '/detail', method: 'get' }) }
export function a() { return request({ url: '/a' + '/b' }) }`);
    expect(facts.functions[0]?.calls.find((c) => c.callee === "request")?.args[0]).toMatchObject({
      props: { url: { kind: "template", value: "/system/user/${parseStrEmpty(id)}/detail" } },
    });
    expect(facts.functions[1]?.calls[0]?.args[0]).toMatchObject({ props: { url: { kind: "string", value: "/a/b" } } });
  });

  it("keeps the object returned by config functions", () => {
    const facts = script("javascript", `export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd())
  return { server: { port: 80, proxy: { '/dev-api': { target: 'http://localhost:8080', rewrite: (p) => p.replace(/^\/dev-api/, '') } } } }
})`, "vite.config.js");
    expect(facts.defaultExport).toMatchObject({
      kind: "call",
      args: [{ kind: "function", returns: { kind: "object", props: { server: { props: { proxy: { props: { "/dev-api": { props: { target: { value: "http://localhost:8080" } } } } } } } } } }],
    });
  });
});

describe("TypeScript enums", () => {
  it("exposes enum members as an object variable", () => {
    const facts = script("typescript", `enum Api { list = '/sys/user/list', save = '/sys/user/add', Plain }\nexport const list = (params) => defHttp.get({ url: Api.list, params });`, "user.api.ts");
    expect(facts.variables.find((v) => v.name === "Api")?.value).toEqual({
      kind: "object",
      props: { list: { kind: "string", value: "/sys/user/list" }, save: { kind: "string", value: "/sys/user/add" }, Plain: { kind: "string", value: "Plain" } },
    });
    expect(facts.functions.find((f) => f.name === "list")?.calls[0]).toMatchObject({ callee: "defHttp.get", args: [{ kind: "object", props: { url: { kind: "member", text: "Api.list" } } }] });
  });
});
