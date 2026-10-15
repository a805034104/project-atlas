import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import iconv from "iconv-lite";
import { afterEach, describe, expect, it } from "vitest";
import { decodeSource, looksBinary } from "../../src/ingest/decode.js";
import { classifyFile } from "../../src/ingest/lang.js";
import { walkWorkspace } from "../../src/ingest/walker.js";

describe("classifyFile", () => {
  it.each([
    ["src/main/java/A.java", "java"],
    ["pom.xml", "maven-pom"],
    ["ruoyi-ui/package.json", "npm-manifest"],
    ["src/main/resources/mapper/system/SysUserMapper.xml", "mybatis-xml"],
    ["src/main/resources/logback.xml", "xml"],
    ["application-druid.yml", "yaml"],
    ["docker-compose.yml", "compose"],
    ["compose.prod.yaml", "compose"],
    [".env.production", "env"],
    ["Dockerfile", "dockerfile"],
    ["ry.sh", "shell"],
    ["ry.bat", "shell"],
    ["src/views/index.vue", "vue"],
    ["vite.config.ts", "typescript"],
    ["build.gradle.kts", "gradle"],
    ["foo.kts", "other"],
    ["LICENSE", "other"],
  ])("%s → %s", (file, kind) => {
    expect(classifyFile(file)).toBe(kind);
  });
});

describe("decodeSource", () => {
  it("decodes UTF-8, UTF-8 BOM and UTF-16LE", () => {
    expect(decodeSource(Buffer.from("用户", "utf8"))).toEqual({ text: "用户", encoding: "utf-8" });
    expect(decodeSource(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("a")]))).toEqual({ text: "a", encoding: "utf-8" });
    expect(decodeSource(Buffer.from([0xff, 0xfe, 0x61, 0x00])).text).toBe("a");
  });

  it("falls back to GBK for legacy Chinese sources", () => {
    const gbk = iconv.encode("// 查询用户列表\nclass A {}", "gbk");
    expect(decodeSource(gbk)).toEqual({ text: "// 查询用户列表\nclass A {}", encoding: "gb18030" });
  });

  it("sniffs binaries", () => {
    expect(looksBinary(Buffer.from([1, 2, 0, 3]))).toBe(true);
    expect(looksBinary(Buffer.from("text"))).toBe(false);
  });
});

describe("walkWorkspace", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function tree(files: Record<string, string>): Promise<string> {
    dir = await mkdtemp(path.join(tmpdir(), "atlas-walk-"));
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await writeFile(path.join(dir, rel), content);
    }
    return dir;
  }

  it("applies defaults, nested .gitignore, .atlasignore and extra excludes", async () => {
    const root = await tree({
      "pom.xml": "<project/>",
      "a/src/A.java": "class A {}",
      "a/target/A.class": "x",
      "node_modules/x/index.js": "x",
      "ui/.gitignore": "generated/\n",
      "ui/generated/api.js": "x",
      "ui/src/main.js": "x",
      ".atlasignore": "docs/\n",
      "docs/readme.md": "x",
      "sql/ry.sql": "x",
      "ui/dist/app.min.js": "x",
    });
    const result = await walkWorkspace({ rootId: "r", rootPath: root, exclude: ["sql/"] });
    expect(result.files.map((f) => f.relPath).sort()).toEqual([".atlasignore", "a/src/A.java", "pom.xml", "ui/.gitignore", "ui/src/main.js"]);
    expect(result.files.find((f) => f.relPath === "a/src/A.java")).toMatchObject({ rootId: "r", kind: "java" });
  });

  it("skips oversized files with a diagnostic", async () => {
    const root = await tree({ "big.java": "x".repeat(3 * 1024), "small.java": "x" });
    const result = await walkWorkspace({ rootId: "r", rootPath: root, maxFileSizeKB: 2 });
    expect(result.files.map((f) => f.relPath)).toEqual(["small.java"]);
    expect(result.diagnostics[0]).toMatchObject({ code: "ATLAS-W003", at: { file: "big.java" } });
  });

  it("does not follow symlinked directories", async () => {
    const root = await tree({ "src/A.java": "class A {}" });
    try {
      await symlink(path.join(root, "src"), path.join(root, "loop"), "junction");
    } catch {
      return; // symlinks unavailable (e.g. restricted Windows account)
    }
    const result = await walkWorkspace({ rootId: "r", rootPath: root });
    expect(result.files.map((f) => f.relPath)).toEqual(["src/A.java"]);
    expect(result.diagnostics.some((d) => d.code === "ATLAS-I003")).toBe(true);
  });

  it("honours cancellation", async () => {
    const root = await tree({ "a.java": "x" });
    const controller = new AbortController();
    controller.abort();
    await expect(walkWorkspace({ rootId: "r", rootPath: root, signal: controller.signal })).rejects.toThrow();
  });
});
