import { describe, expect, it } from "vitest";
import { edgeKey, httpKey, javaMethodKey, mqKey, normalizeHttpPath, stableId } from "../../src/model/ids.js";

describe("stableId", () => {
  it("is deterministic and 16 lowercase base32 chars", () => {
    const a = stableId("step", "ruoyi-admin", "com.ruoyi.SysUserController#list(SysUser)");
    const b = stableId("step", "ruoyi-admin", "com.ruoyi.SysUserController#list(SysUser)");
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-z2-7]{16}$/);
  });

  it("separates kind, service and key", () => {
    const key = "GET /system/user/list";
    const ids = new Set([
      stableId("entrypoint", "svc-a", key),
      stableId("entrypoint", "svc-b", key),
      stableId("step", "svc-a", key),
    ]);
    expect(ids.size).toBe(3);
  });

  it("is not fooled by concatenation ambiguity", () => {
    expect(stableId("step", "ab", "c")).not.toBe(stableId("step", "a", "bc"));
  });

  it("rejects empty keys", () => {
    expect(() => stableId("step", "svc", "")).toThrow(/empty canonical key/);
  });
});

describe("canonical keys", () => {
  it("keeps overloads distinct and ignores whitespace in generics", () => {
    expect(javaMethodKey("com.acme.Foo", "bar", ["Map<String, Object>", "int"])).toBe(
      "com.acme.Foo#bar(Map<String,Object>,int)",
    );
    expect(javaMethodKey("com.acme.Foo", "bar", [])).toBe("com.acme.Foo#bar()");
  });

  it("builds http, mq and edge keys", () => {
    expect(httpKey("get", "/system/user/{userId}/")).toBe("GET /system/user/{}");
    expect(mqKey("Kafka", "order-created")).toBe("kafka:order-created");
    expect(edgeKey("a", "b")).toBe("a->b");
    expect(edgeKey("a", "b", "impl2")).toBe("a->b#impl2");
  });
});

describe("normalizeHttpPath", () => {
  it.each([
    ["/user/{id}", "/user/{}"],
    ["/user/:id", "/user/{}"],
    ["/user/:id?", "/user/{}"],
    ["/user/<int:id>", "/user/{}"],
    ["/user/<id>", "/user/{}"],
    ["/user/${userId}", "/user/{}"],
    ["user//list/", "/user/list"],
    ["/user/list?pageNum=1", "/user/list"],
    ["/", "/"],
    ["", "/"],
    ["/static/**", "/static/**"],
    ["/api/*/detail", "/api/*/detail"],
    ["  /trim/me  ", "/trim/me"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeHttpPath(input)).toBe(expected);
  });

  it("does not treat partial braces as variables", () => {
    expect(normalizeHttpPath("/file/{name}.json")).toBe("/file/{name}.json");
  });
});
