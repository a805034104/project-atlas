import { beforeAll, describe, expect, it } from "vitest";
import { extractFacts } from "../../src/parse/extract.js";
import { loadParsers, type ParserSet } from "../../src/parse/treesitter.js";
import type { JavaFileFacts } from "../../src/facts/types.js";

let set: ParserSet;
beforeAll(async () => {
  set = await loadParsers();
});

function java(source: string): JavaFileFacts {
  const facts = extractFacts(set, "java", source, "A.java");
  if (!facts || facts.lang !== "java") throw new Error("expected java facts");
  return facts;
}

const CONTROLLER = `
package com.ruoyi.web.controller.system;

import java.util.List;
import com.ruoyi.system.service.ISysUserService;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/system/user")
public class SysUserController extends BaseController
{
    @Autowired
    private ISysUserService userService;

    private static final String TOPIC = "user-" + "events";

    @PreAuthorize("@ss.hasPermi('system:user:list')")
    @GetMapping("/list")
    public TableDataInfo list(SysUser user)
    {
        startPage();
        List<SysUser> list = userService.selectUserList(user);
        var helper = new PageHelper();
        return getDataTable(list);
    }

    @RequestMapping(value = {"/a", "/b"}, method = RequestMethod.POST)
    @RepeatSubmit
    public AjaxResult add(@Validated @RequestBody SysUser user, String... names)
    {
        restTemplate.postForObject("http://ruoyi-auth/token/" + "check", user, String.class);
        list.forEach(u -> this.userService.insertUser(u));
        return toAjax(1);
    }

    static class Inner implements Runnable, Comparable<Inner> {
        public void run() {}
    }
}
`;

describe("extractJavaFacts", () => {
  it("captures package, imports and wildcard imports", () => {
    const facts = java(CONTROLLER);
    expect(facts.package).toBe("com.ruoyi.web.controller.system");
    expect(facts.imports["ISysUserService"]).toBe("com.ruoyi.system.service.ISysUserService");
    expect(facts.wildcardImports).toEqual(["org.springframework.web.bind.annotation"]);
    expect(facts.hasErrors).toBe(false);
  });

  it("captures class annotations, superclass and nested types", () => {
    const facts = java(CONTROLLER);
    const ctrl = facts.types.find((t) => t.name === "SysUserController");
    expect(ctrl?.fqcn).toBe("com.ruoyi.web.controller.system.SysUserController");
    expect(ctrl?.superclass).toBe("BaseController");
    expect(ctrl?.annotations.map((a) => a.name)).toEqual(["RestController", "RequestMapping"]);
    expect(ctrl?.annotations[1]?.args["value"]).toEqual({ kind: "string", value: "/system/user" });
    const inner = facts.types.find((t) => t.name === "SysUserController.Inner");
    expect(inner?.fqcn).toBe("com.ruoyi.web.controller.system.SysUserController.Inner");
    expect(inner?.interfaces).toEqual(["Runnable", "Comparable<Inner>"]);
  });

  it("captures injected fields and constant string values", () => {
    const ctrl = java(CONTROLLER).types.find((t) => t.name === "SysUserController");
    const svc = ctrl?.fields.find((f) => f.name === "userService");
    expect(svc).toMatchObject({ type: "ISysUserService", annotations: [{ name: "Autowired" }] });
    expect(ctrl?.fields.find((f) => f.name === "TOPIC")?.stringValue).toBe("user-events");
  });

  it("captures methods, parameters, annotations, locals and calls", () => {
    const ctrl = java(CONTROLLER).types.find((t) => t.name === "SysUserController");
    const list = ctrl?.methods.find((m) => m.name === "list");
    expect(list?.annotations.map((a) => a.name)).toEqual(["PreAuthorize", "GetMapping"]);
    expect(list?.annotations[0]?.args["value"]).toEqual({ kind: "string", value: "@ss.hasPermi('system:user:list')" });
    expect(list?.params).toEqual([{ name: "user", type: "SysUser", annotations: [] }]);
    expect(list?.locals).toMatchObject({ list: "List<SysUser>", helper: "PageHelper" });
    expect(list?.calls.map((c) => `${c.receiver ?? ""}.${c.method}`)).toEqual([
      ".startPage",
      "userService.selectUserList",
      ".getDataTable",
    ]);
  });

  it("captures array annotation values, enum expressions, varargs and lambda calls", () => {
    const ctrl = java(CONTROLLER).types.find((t) => t.name === "SysUserController");
    const add = ctrl?.methods.find((m) => m.name === "add");
    expect(add?.annotations[0]?.args).toEqual({
      value: { kind: "strings", values: ["/a", "/b"] },
      method: { kind: "expr", text: "RequestMethod.POST" },
    });
    expect(add?.params.map((p) => p.type)).toEqual(["SysUser", "String..."]);
    expect(add?.params[0]?.annotations.map((a) => a.name)).toEqual(["Validated", "RequestBody"]);
    const rest = add?.calls.find((c) => c.method === "postForObject");
    expect(rest?.argLiterals[0]).toBe("http://ruoyi-auth/token/check");
    expect(add?.calls.some((c) => c.receiver === "this.userService" && c.method === "insertUser")).toBe(true);
  });

  it("handles interfaces, enums, records and GBK-free unicode escapes", () => {
    const facts = java(`
      package p;
      public interface ISysUserService extends IService<SysUser>, Other { List<SysUser> selectUserList(SysUser u); }
      enum Color { RED, GREEN; private final String label = "\\u4e2d"; void x() { y(); } }
      record Point(int x, @NotNull String label) {}
    `);
    const svc = facts.types.find((t) => t.name === "ISysUserService");
    expect(svc?.kind).toBe("interface");
    expect(svc?.interfaces).toEqual(["IService<SysUser>", "Other"]);
    expect(svc?.methods[0]?.name).toBe("selectUserList");
    const color = facts.types.find((t) => t.name === "Color");
    expect(color?.fields[0]?.stringValue).toBe("中");
    expect(color?.methods[0]?.calls[0]?.method).toBe("y");
    const point = facts.types.find((t) => t.name === "Point");
    expect(point?.fields.map((f) => f.name)).toEqual(["x", "label"]);
  });

  it("flags syntax errors without throwing", () => {
    const facts = java("public class Broken { void x( { }");
    expect(facts.hasErrors).toBe(true);
  });

  it("captures constructors for Lombok-free constructor injection", () => {
    const facts = java(`class S { private final A a; S(A a, @Qualifier("b2") B b) { this.a = a; } }`);
    const ctor = facts.types[0]?.methods.find((m) => m.isConstructor);
    expect(ctor?.params.map((p) => p.type)).toEqual(["A", "B"]);
    expect(ctor?.params[1]?.annotations[0]?.args["value"]).toEqual({ kind: "string", value: "b2" });
  });
});
