import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { selectProvider } from "../src/ai-config.js";
import { parseCliArgs } from "../src/args.js";
import { CliError } from "../src/errors.js";
import type { CliIo } from "../src/io.js";
import { run } from "../src/main.js";

const RUOYI_VUE = path.resolve("fixtures/repos/ruoyi-vue");
const haveFixture = existsSync(RUOYI_VUE);
const SECRET = "sk-ant-test-0123456789abcdef";

interface TestIo extends CliIo {
  out: () => string;
  err: () => string;
  fetchCalls: string[];
}

function testIo(options: { env?: Record<string, string>; interactive?: boolean; answer?: string; reply?: (url: string) => Response } = {}): TestIo {
  const out: string[] = [];
  const err: string[] = [];
  const fetchCalls: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    fetchCalls.push(String(input));
    if (!options.reply) throw new Error("network access in a test");
    return options.reply(String(input));
  }) as typeof fetch;
  return {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    env: options.env ?? {},
    cwd: process.cwd(),
    interactive: options.interactive ?? false,
    ask: async () => {
      if (options.answer === undefined) throw new Error("unexpected prompt");
      return options.answer;
    },
    fetch: fakeFetch,
    out: () => out.join(""),
    err: () => err.join(""),
    fetchCalls,
  };
}

function usageCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof CliError) return `${error.error.code}/${error.exitCode}`;
    throw error;
  }
  return undefined;
}

describe("argument parsing", () => {
  it("parses analyze with defaults and every flag", () => {
    expect(parseCliArgs(["analyze"])).toEqual({ command: "analyze", paths: [], json: false, noAi: false, noHistory: false, yes: false });
    expect(
      parseCliArgs(["analyze", "a", "b", "--out", "o", "--json", "--no-ai", "--no-history", "--markdown", "ATLAS.md", "--provider", "ollama", "--model", "m", "--base-url", "http://x", "--lang", "zh-CN", "-y", "--max-input-tokens", "5000"]),
    ).toEqual({
      command: "analyze",
      paths: ["a", "b"],
      out: "o",
      json: true,
      noAi: true,
      noHistory: true,
      markdown: "ATLAS.md",
      provider: "ollama",
      model: "m",
      baseUrl: "http://x",
      lang: "zh-cn",
      yes: true,
      maxInputTokens: 5000,
    });
  });

  it("parses show and estimate", () => {
    expect(parseCliArgs(["show", "GET", "/system/user/list", "--depth", "30"])).toEqual({ command: "show", entrypoint: "GET /system/user/list", depth: 30, json: false });
    expect(parseCliArgs(["show", "abc", "--dir", "x/.atlas", "--json"])).toEqual({ command: "show", entrypoint: "abc", dir: "x/.atlas", json: true });
    expect(parseCliArgs(["estimate", "--provider", "anthropic"])).toEqual({ command: "estimate", paths: [], json: false, noHistory: false, provider: "anthropic" });
    expect(parseCliArgs([])).toEqual({ command: "help" });
    expect(parseCliArgs(["--version"])).toEqual({ command: "version" });
  });

  it("rejects bad usage with ATLAS-E060 / exit 2", () => {
    expect(usageCode(() => parseCliArgs(["frobnicate"]))).toBe("ATLAS-E060/2");
    expect(usageCode(() => parseCliArgs(["analyze", "--bogus"]))).toBe("ATLAS-E060/2");
    expect(usageCode(() => parseCliArgs(["analyze", "--provider", "gpt"]))).toBe("ATLAS-E060/2");
    expect(usageCode(() => parseCliArgs(["analyze", "--lang", "fr"]))).toBe("ATLAS-E060/2");
    expect(usageCode(() => parseCliArgs(["analyze", "--max-input-tokens", "-3"]))).toBe("ATLAS-E060/2");
    expect(usageCode(() => parseCliArgs(["show"]))).toBe("ATLAS-E060/2");
    expect(usageCode(() => parseCliArgs(["show", "x", "--yes"]))).toBe("ATLAS-E060/2");
    expect(usageCode(() => parseCliArgs(["estimate", "--markdown", "a.md"]))).toBe("ATLAS-E060/2");
  });

  it("selects a provider only from flags or env", () => {
    expect(selectProvider({}, {})).toEqual({ status: "not-configured" });
    expect(selectProvider({}, { ATLAS_PROVIDER: "none", ANTHROPIC_API_KEY: SECRET })).toEqual({ status: "not-configured" });
    const anthropic = selectProvider({}, { ANTHROPIC_API_KEY: SECRET });
    expect(anthropic.status === "configured" && anthropic.config).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5", baseUrl: "https://api.anthropic.com" });
    const ollama = selectProvider({ provider: "ollama" }, { ATLAS_MODEL: "qwen" });
    expect(ollama.status === "configured" && ollama.config).toEqual({ provider: "ollama", model: "qwen", baseUrl: "http://localhost:11434" });
    expect(usageCode(() => selectProvider({ provider: "anthropic" }, {}))).toBe("ATLAS-E020/2");
    expect(usageCode(() => selectProvider({ provider: "openai-compatible" }, { ATLAS_API_KEY: SECRET }))).toBe("ATLAS-E060/2");
    expect(usageCode(() => selectProvider({}, { ATLAS_PROVIDER: "gpt" }))).toBe("ATLAS-E060/2");
  });
});

describe("errors", () => {
  it("reports a missing path as ATLAS-E061 with exit 2 and nothing on stdout", async () => {
    const io = testIo();
    expect(await run(["analyze", "definitely/not/here", "--no-ai", "--json"], io)).toBe(2);
    expect(io.err()).toMatch(/^error ATLAS-E061: Path not found or not a directory: definitely\/not\/here\n {2}cause: .+\n {2}fix: {3}.+\n {2}docs: {2}https:\/\/.+atlas-e061\n$/);
    expect(io.out()).toBe("");
  });

  it("reports a missing store for show as ATLAS-E062 with exit 1", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "atlas-cli-"));
    try {
      const io = testIo();
      expect(await run(["show", "GET /x", "--dir", dir], io)).toBe(1);
      expect(io.err()).toContain("ATLAS-E062");
      expect(io.err()).toContain("project-atlas analyze");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!haveFixture)("on RuoYi-Vue", () => {
  let out: string;
  beforeAll(async () => {
    out = await mkdtemp(path.join(tmpdir(), "atlas-cli-"));
  });
  afterAll(async () => {
    await rm(out, { recursive: true, force: true });
  });

  it("analyze --json --no-ai prints only the machine summary on stdout", async () => {
    const io = testIo({ env: { ANTHROPIC_API_KEY: SECRET } });
    const code = await run(["analyze", RUOYI_VUE, "--out", path.join(out, "a"), "--json", "--no-ai", "--no-history", "--markdown", path.join(out, "ATLAS.md")], io);
    expect(code, io.err()).toBe(0);
    const summary = JSON.parse(io.out()) as Record<string, unknown>;
    expect(Object.keys(summary)).toEqual(["services", "entrypoints", "links", "unresolved", "diagnostics", "aiUsage"]);
    expect(summary.services).toEqual([expect.objectContaining({ name: "ruoyi-admin", kind: "backend", stack: "java-spring", path: "ruoyi-admin" })]);
    expect(summary.entrypoints).toBeGreaterThan(100);
    expect(summary.unresolved).toEqual(expect.any(Number));
    expect(summary.diagnostics).toEqual({ error: expect.any(Number), warning: expect.any(Number), info: expect.any(Number) });
    expect(summary.aiUsage).toEqual({ status: "disabled", inputTokens: 0, outputTokens: 0, phases: [] });
    expect(io.err()).toContain("atlas: parse…");
    expect(io.fetchCalls).toEqual([]);
    expect(existsSync(path.join(out, "a", "graph", "meta.json"))).toBe(true);
    expect(await readFile(path.join(out, "ATLAS.md"), "utf8")).toContain("## Request flows");
  }, 120_000);

  it("show prints the user list flow (text and JSON)", async () => {
    const io = testIo();
    expect(await run(["show", "GET /system/user/list", "--dir", path.join(out, "a")], io)).toBe(0);
    const text = io.out();
    expect(text.split("\n")[0]).toBe("GET /system/user/list  [ruoyi-admin]");
    const layers = ["filter · XssFilter.doFilter", "controller · SysUserController.list", "service · SysUserServiceImpl.selectUserList", "repository · SysUserMapper.selectUserList", 'sql · <select id="selectUserList">'];
    const positions = layers.map((l) => text.indexOf(l));
    expect(positions.every((p) => p > 0), text).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(text).toMatch(/controller · SysUserController\.list \(ruoyi-admin\/src\/main\/java\/com\/ruoyi\/web\/controller\/system\/SysUserController\.java:\d+\)/);

    const json = testIo();
    expect(await run(["show", "get /system/user/list", "--dir", path.join(out, "a"), "--json", "--depth", "30"], json)).toBe(0);
    const detail = JSON.parse(json.out()) as { entrypoint: { path: string }; steps: { layer: string }[] };
    expect(detail.entrypoint.path).toBe("/system/user/list");
    expect(detail.steps.map((s) => s.layer)).toContain("sql");

    const missing = testIo();
    expect(await run(["show", "GET /system/user/nope", "--dir", path.join(out, "a")], missing)).toBe(2);
    expect(missing.err()).toContain("ATLAS-E063");
  });

  it("estimate prints the cost plan and sends nothing", async () => {
    const io = testIo();
    expect(await run(["estimate", RUOYI_VUE, "--out", path.join(out, "e"), "--no-history", "--json"], io)).toBe(0);
    const plan = JSON.parse(io.out()) as { provider: string; model: string; phases: { phase: string; calls: number }[]; total: { inputTokens: number; usd: number }; withinBudget: boolean };
    expect(plan.provider).toBe("anthropic");
    expect(plan.model).toBe("claude-sonnet-5-5");
    expect(plan.phases.map((p) => p.phase)).toEqual(expect.arrayContaining(["file-summary", "module-summary", "features", "startup"]));
    expect(plan.total.inputTokens).toBeGreaterThan(0);
    expect(plan.total.usd).toBeGreaterThan(0);
    expect(plan.withinBudget).toBe(true);
    expect(io.fetchCalls).toEqual([]);
    expect(existsSync(path.join(out, "e", "graph"))).toBe(false);

    const text = testIo({ env: { ATLAS_PROVIDER: "ollama" } });
    expect(await run(["estimate", RUOYI_VUE, "--out", path.join(out, "e"), "--no-history"], text)).toBe(0);
    expect(text.out()).toContain("AI cost plan — ollama / qwen2.5-coder:7b");
    expect(text.out()).toMatch(/total .*\$0\.00/);
  }, 120_000);

  it("non-TTY without --yes prints the plan but never calls the provider", async () => {
    const io = testIo({ env: { ATLAS_PROVIDER: "anthropic", ATLAS_API_KEY: SECRET }, reply: () => new Response("{}") });
    expect(await run(["analyze", RUOYI_VUE, "--out", path.join(out, "b"), "--json", "--no-history"], io)).toBe(0);
    expect(io.fetchCalls).toEqual([]);
    expect(io.err()).toContain("AI cost plan — anthropic @ https://api.anthropic.com / claude-sonnet-5-5");
    expect(io.err()).toContain("not a terminal and --yes was not given");
    expect((JSON.parse(io.out()) as { aiUsage: { status: string } }).aiUsage.status).toBe("skipped-non-interactive");
    expect(io.err() + io.out()).not.toContain(SECRET);
  }, 120_000);

  it("an interactive 'n' declines without sending", async () => {
    const io = testIo({ env: { ATLAS_PROVIDER: "anthropic", ATLAS_API_KEY: SECRET }, interactive: true, answer: "n", reply: () => new Response("{}") });
    expect(await run(["analyze", RUOYI_VUE, "--out", path.join(out, "b"), "--json", "--no-history"], io)).toBe(0);
    expect(io.fetchCalls).toEqual([]);
    expect((JSON.parse(io.out()) as { aiUsage: { status: string } }).aiUsage.status).toBe("declined");
  }, 120_000);

  it("--yes sends through the injected fetch, tolerates partial failures and never prints the key", async () => {
    const reply = () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ summary: "摘要" }) }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }), {
        status: 200,
      });
    const io = testIo({ env: { ATLAS_PROVIDER: "anthropic", ATLAS_API_KEY: SECRET }, reply });
    const code = await run(["analyze", RUOYI_VUE, "--out", path.join(out, "c"), "--json", "--no-history", "--yes", "--lang", "zh-cn"], io);
    expect(code, io.err()).toBe(0);
    expect(io.fetchCalls.length).toBeGreaterThan(0);
    expect(io.fetchCalls.every((u) => u === "https://api.anthropic.com/v1/messages")).toBe(true);
    const summary = JSON.parse(io.out()) as { aiUsage: { status: string; inputTokens: number } };
    // features/startup replies have the wrong shape → partial, still exit 0
    expect(summary.aiUsage.status).toBe("partial");
    expect(summary.aiUsage.inputTokens).toBeGreaterThan(0);
    expect(io.err()).toContain("warning ATLAS-E025");
    expect(io.err() + io.out()).not.toContain(SECRET);
  }, 120_000);
});
