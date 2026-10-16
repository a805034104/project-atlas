import { describe, expect, it } from "vitest";
import type { CostPlan } from "@project-atlas/core";
import { parseAtlasYaml } from "../../core/src/overrides/atlas-yaml.js";
import { formatTokens, formatUsd, phaseChoices, planTitle } from "@project-atlas/core";
import { addEdgeRemoval } from "@project-atlas/core";

const plan: CostPlan = {
  model: "claude-sonnet-5-5",
  phases: [
    { phase: "file-summary", calls: 120, inputTokens: 480_000, outputTokens: 30_000, usd: 1.26 },
    { phase: "features", calls: 1, inputTokens: 9_000, outputTokens: 2_500, usd: 0.0430 },
  ],
  total: { calls: 121, inputTokens: 489_000, outputTokens: 32_500, usd: 1.303 },
};

describe("cost dialog formatting", () => {
  it("formats tokens and money", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_345)).toBe("12.3k");
    expect(formatTokens(2_500_000)).toBe("2.50M");
    expect(formatUsd(0, true)).toBe("免费（本地）");
    expect(formatUsd(undefined, false)).toBe("price unknown");
    expect(formatUsd(0.004, false)).toBe("< $0.01");
    expect(formatUsd(1.303, false)).toBe("≈ $1.30");
  });

  it("produces one pre-ticked choice per phase in both languages", () => {
    const zh = phaseChoices(plan, true);
    expect(zh.map((c) => c.label)).toEqual(["文件摘要", "功能清单"]);
    expect(zh.every((c) => c.picked)).toBe(true);
    expect(zh[0]?.description).toContain("120 次请求");
    expect(phaseChoices(plan, false)[1]?.label).toBe("Feature list");
    expect(planTitle(plan, true)).toContain("确认后才会发送");
    expect(planTitle(plan, false)).toContain("nothing is sent until you confirm");
  });
});

describe(".atlas/overrides.yaml writer", () => {
  it("creates the file and appends without duplicates", () => {
    const first = addEdgeRemoval(undefined, "a.B#c()", "d.E#f()", "marked wrong");
    const second = addEdgeRemoval(first, "a.B#c()", "d.E#f()");
    expect(second).toBe(first);
    const parsed = parseAtlasYaml(second, "overrides.yaml");
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.overrides.edges.remove).toEqual([{ from: "a.B#c()", to: "d.E#f()", note: "marked wrong" }]);
  });

  it("keeps comments and existing content", () => {
    const existing = "# team overrides\nversion: 1\nignoreEntrypoints:\n  - GET /actuator/**\nedges:\n  remove:\n    - from: x\n      to: y\n";
    const out = addEdgeRemoval(existing, "p", "q");
    expect(out).toContain("# team overrides");
    const parsed = parseAtlasYaml(out, "overrides.yaml").overrides;
    expect(parsed.ignoreEntrypoints).toEqual(["GET /actuator/**"]);
    expect(parsed.edges.remove.map((e) => `${e.from}>${e.to}`)).toEqual(["x>y", "p>q"]);
  });
});
