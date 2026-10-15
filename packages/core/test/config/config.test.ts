import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseDotEnv, parseNacosSqlDump, parsePropertiesConfig, parseYamlConfig } from "../../src/config/sources.js";
import { canonicalKey, ConfigView } from "../../src/config/view.js";

describe("parseYamlConfig", () => {
  it("flattens maps and lists with line numbers", () => {
    const docs = parseYamlConfig(
      `server:\n  port: 9201\nspring:\n  cloud:\n    gateway:\n      routes:\n        - id: ruoyi-auth\n          uri: lb://ruoyi-auth\n          predicates:\n            - Path=/auth/**\n`,
      "r",
      "bootstrap.yml",
    );
    expect(docs).toHaveLength(1);
    expect(docs[0]?.entries).toEqual([
      { key: "server.port", value: "9201", at: { rootId: "r", file: "bootstrap.yml", line: 2 } },
      { key: "spring.cloud.gateway.routes[0].id", value: "ruoyi-auth", at: { rootId: "r", file: "bootstrap.yml", line: 7 } },
      { key: "spring.cloud.gateway.routes[0].uri", value: "lb://ruoyi-auth", at: { rootId: "r", file: "bootstrap.yml", line: 8 } },
      { key: "spring.cloud.gateway.routes[0].predicates[0]", value: "Path=/auth/**", at: { rootId: "r", file: "bootstrap.yml", line: 10 } },
    ]);
  });

  it("marks profile-specific documents", () => {
    const docs = parseYamlConfig(`a: 1\n---\nspring:\n  config:\n    activate:\n      on-profile: dev\na: 2\n---\nspring:\n  profiles: prod | test\na: 3\n`, "r", "f.yml");
    expect(docs.map((d) => d.profiles)).toEqual([undefined, ["dev"], ["prod", "test"]]);
  });

  it("does not throw on malformed YAML", () => {
    expect(() => parseYamlConfig("a: [1, 2\nb: : :", "r", "bad.yml")).not.toThrow();
  });

  it("supports anchors and merge keys", () => {
    const docs = parseYamlConfig(`base: &b\n  timeout: 10\nsvc:\n  <<: *b\n  name: x\n`, "r", "f.yml");
    expect(docs[0]?.entries.map((e) => `${e.key}=${e.value}`)).toContain("svc.timeout=10");
  });
});

describe("parsePropertiesConfig / parseDotEnv", () => {
  it("parses separators, comments and continuations", () => {
    const doc = parsePropertiesConfig(`# c\n! c\na=1\nb: 2\nc 3\nd=multi \\\n  line\nkey\\:x=y\n`, "r", "a.properties");
    expect(doc.entries.map((e) => [e.key, e.value, e.at.line])).toEqual([
      ["a", "1", 3],
      ["b", "2", 4],
      ["c", "3", 5],
      ["d", "multi line", 6],
      ["key:x", "y", 8],
    ]);
  });

  it("parses .env with quotes and comments", () => {
    const doc = parseDotEnv(`# 页面标题\nVITE_APP_TITLE = 若依管理系统\nVITE_APP_BASE_API = '/dev-api'\nexport X="y" \nZ=1 # note\n`, "r", ".env.development");
    expect(doc.entries.map((e) => [e.key, e.value])).toEqual([
      ["VITE_APP_TITLE", "若依管理系统"],
      ["VITE_APP_BASE_API", "/dev-api"],
      ["X", "y"],
      ["Z", "1"],
    ]);
  });
});

describe("parseNacosSqlDump", () => {
  it("reads multi-row inserts with escapes", () => {
    const sql = `insert into config_info(id, data_id, group_id, content, md5, tenant_id) values \n(1,'application-dev.yml','DEFAULT_GROUP','spring:\\n  a: \\'x\\'\\n','abc',''),\n(2, 'ruoyi-gateway-dev.yml', 'DEFAULT_GROUP', 'it''s', 'm', 'ns1');\ninsert into other(x) values (1);`;
    expect(parseNacosSqlDump(sql)).toEqual([
      { dataId: "application-dev.yml", group: "DEFAULT_GROUP", tenant: "", content: "spring:\n  a: 'x'\n", line: 2 },
      { dataId: "ruoyi-gateway-dev.yml", group: "DEFAULT_GROUP", tenant: "ns1", content: "it's", line: 3 },
    ]);
  });

  const dump = path.resolve("fixtures/repos/ruoyi-cloud/sql/ry_config_20250902.sql");
  it.skipIf(!existsSync(dump))("reads the RuoYi-Cloud dump", async () => {
    const rows = parseNacosSqlDump(await readFile(dump, "utf8"));
    const gateway = rows.find((r) => r.dataId === "ruoyi-gateway-dev.yml");
    expect(gateway?.content).toContain("lb://ruoyi-system");
    expect(rows.map((r) => r.dataId)).toContain("ruoyi-system-dev.yml");
  });
});

describe("ConfigView", () => {
  const layer = (name: string, text: string) => ({ name, documents: parseYamlConfig(text, "r", name) });

  it("applies layer priority, profiles and relaxed binding", () => {
    const view = new ConfigView(
      [
        layer("application-dev.yml", `server:\n  port: 9201\n`),
        layer("application.yml", `server:\n  port: 8080\nspring:\n  application:\n    name: ruoyi-system\n---\nspring:\n  config:\n    activate:\n      on-profile: prod\nserver:\n  port: 80\n`),
      ],
      ["dev"],
    );
    expect(view.value("server.port")?.value).toBe("9201");
    expect(view.value("SPRING_APPLICATION_NAME")?.value).toBe("ruoyi-system");
    expect(view.value("Spring.Application.NAME")?.value).toBe("ruoyi-system");
    expect(view.get("server.port")?.at.file).toBe("application-dev.yml");
  });

  it("resolves nested placeholders with defaults and reports unresolved ones", () => {
    const view = new ConfigView([
      layer("a.yml", `spring:\n  profiles:\n    active: dev\n  cloud:\n    nacos:\n      config:\n        file-extension: yml\nself: \${self}\nspel: "#{1+1}"\n`),
    ]);
    expect(view.resolve("application-${spring.profiles.active}.${spring.cloud.nacos.config.file-extension}")).toEqual({ value: "application-dev.yml", unresolved: [] });
    expect(view.resolve("${missing:${spring.profiles.active:x}}").value).toBe("dev");
    expect(view.resolve("${a:${b:fallback}}").value).toBe("fallback");
    expect(view.resolve("${nope}")).toEqual({ value: "${nope}", unresolved: ["nope"] });
    expect(view.value("self")?.unresolved).toEqual(["self"]);
    expect(view.value("spel")?.unresolved).toEqual(["#{1+1}"]);
  });

  it("lists entries under a prefix", () => {
    const view = new ConfigView([layer("g.yml", `spring:\n  cloud:\n    gateway:\n      routes:\n        - id: a\n          uri: lb://a\n`)]);
    expect(view.list("spring.cloud.gateway.routes").map((e) => e.key)).toEqual(["spring.cloud.gateway.routes[0].id", "spring.cloud.gateway.routes[0].uri"]);
  });

  it("canonicalizes keys", () => {
    expect(canonicalKey("spring.cloud.nacos.config.file-extension")).toBe(canonicalKey("SPRING_CLOUD_NACOS_CONFIG_FILEEXTENSION"));
  });
});
