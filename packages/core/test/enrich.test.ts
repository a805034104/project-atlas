import { describe, expect, it } from "vitest";
import { analyzeWorkspace } from "../src/analyze.js";
import { buildAiInput, enrichWithAi, estimateAiCost, HUBS_PER_MODULE, mergeAiResult } from "../src/enrich.js";
import type { AiPipelineResult } from "../src/llm/pipeline.js";
import type { AtlasGraph } from "../src/model/types.js";
import type { LlmProvider } from "../src/llm/providers.js";
import { FIXTURES, haveFixtures } from "./helpers/fixtures.js";

/** Scripted provider answering each phase with valid JSON based on what it was asked. */
function fakeProvider(): LlmProvider & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    name: "anthropic",
    model: "claude-sonnet-5-5",
    prompts,
    async complete(req) {
      prompts.push(`${req.system}\n${req.user}`);
      const all = `${req.system}
${req.user}`;
      const ids = [...all.matchAll(/id=([a-z2-7]{16})/g)].map((m) => m[1]);
      let text = JSON.stringify({ summary: "摘要" });
      if (all.includes('{"features"')) text = JSON.stringify({ features: [{ title: "用户管理", description: "管理系统用户", tier: "core", moduleIds: ids.slice(0, 1), entrypointIds: [] }] });
      if (all.includes('{"guides"')) text = JSON.stringify({ guides: [] });
      return { text, inputTokens: 100, outputTokens: 20 };
    },
  } as LlmProvider & { prompts: string[] };
}

describe.skipIf(!haveFixtures(FIXTURES.ruoyiVue, FIXTURES.ruoyiVue3))("AI enrichment", () => {
  it("selects hub files, estimates cost and merges results without leaking secrets", async () => {
    const { graph, workspace } = await analyzeWorkspace({ roots: [{ path: FIXTURES.ruoyiVue }, { path: FIXTURES.ruoyiVue3 }], history: false });
    const input = await buildAiInput(graph, workspace);
    const perModule = new Map<string, number>();
    for (const f of input.files) perModule.set(f.moduleId, (perModule.get(f.moduleId) ?? 0) + 1);
    expect(Math.max(...perModule.values())).toBeLessThanOrEqual(HUBS_PER_MODULE);
    expect(input.files.some((f) => f.path.endsWith("SysUserController.java"))).toBe(true);
    expect(input.files.length).toBeLessThan(workspace.files.length / 2);

    const plan = estimateAiCost(input, "claude-sonnet-5-5", "anthropic");
    expect(plan.phases.map((p) => p.phase)).toEqual(expect.arrayContaining(["file-summary", "module-summary", "features", "startup"]));
    expect(plan.total.inputTokens).toBeGreaterThan(0);
    expect(estimateAiCost(input, "qwen2.5-coder:7b", "ollama").total.usd).toBe(0);

    const provider = fakeProvider();
    const { graph: enriched, result } = await enrichWithAi({ graph, input, provider, language: "zh-cn", skipPhases: ["history"] });
    expect(result.failures).toEqual([]);
    expect(enriched.modules.some((m) => m.summary === "摘要")).toBe(true);
    expect(enriched.llmUsage.length).toBeGreaterThan(0);
    // application-druid.yml carries the datasource password: never sent verbatim
    expect(provider.prompts.some((p) => /password:\s*password\b/.test(p))).toBe(false);
  }, 120_000);
});

describe("mergeAiResult — startup", () => {
  const ref = (file: string, line?: number) => (line === undefined ? { file } : { file, line });
  it("folds AI guides into the deterministic guide they describe instead of duplicating it", () => {
    const graph = {
      modules: [],
      features: [],
      history: [],
      diagnostics: [],
      startup: [
        { target: "ruoyi-admin", prerequisites: [{ name: "JDK", evidence: ref("pom.xml") }], steps: [{ command: "sh ry.sh start", cwd: ".", evidence: ref("ry.sh", 2) }], ports: [], configFiles: [] },
        { target: "ruoyi", prerequisites: [], steps: [{ command: "npm run dev", cwd: ".", evidence: ref("package.json", 9) }], ports: [], configFiles: [] },
      ],
    } as unknown as AtlasGraph;
    const result = {
      moduleSummaries: {},
      historySummaries: {},
      features: [],
      usage: [],
      failures: [],
      excludedFiles: [],
      evidenceRejected: { features: 0, startup: 0 },
      startup: [
        // Named freely, but mentions the deterministic target.
        { target: "后端（ruoyi-admin，Spring Boot）", prerequisites: [{ name: "jdk", evidence: ref("pom.xml") }, { name: "Redis", evidence: ref("application.yml") }], steps: [{ command: "./ry.sh start", cwd: ".", evidence: ref("ry.sh", 2) }], ports: [], configFiles: [] },
        // Different name, same evidence file.
        { target: "前端（Vue3 + Vite）", prerequisites: [], steps: [{ command: "npm install", cwd: ".", evidence: ref("package.json", 18) }], ports: [], configFiles: [] },
        { target: "docs", prerequisites: [], steps: [{ command: "npm run docs", cwd: "docs", evidence: ref("docs/package.json", 3) }], ports: [], configFiles: [] },
      ],
    } as unknown as AiPipelineResult;
    const merged = mergeAiResult(graph, result).startup;
    expect(merged.map((g) => g.target)).toEqual(["ruoyi-admin", "ruoyi", "docs"]);
    expect(merged[0]!.steps.map((s) => s.command)).toEqual(["sh ry.sh start"]);
    expect(merged[0]!.prerequisites.map((p) => p.name)).toEqual(["JDK", "Redis"]);
    expect(merged[1]!.steps.map((s) => s.command)).toEqual(["npm run dev", "npm install"]);
  });
});
