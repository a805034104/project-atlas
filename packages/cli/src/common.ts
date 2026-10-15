import { stat } from "node:fs/promises";
import path from "node:path";
import { analyzeWorkspace, type AnalysisPhase, type AnalysisResult, type CostPlan } from "@project-atlas/core";
import { CliError, EXIT_ANALYSIS, EXIT_USAGE } from "./errors.js";
import type { CliIo } from "./io.js";

/**
 * Shared steps of `analyze` and `estimate`.
 *
 *   paths ─▶ resolveInputPaths (exist? → E061) ─▶ runAnalysis (progress → stderr,
 *   no services → E050) ─▶ AnalysisResult;  CostPlan ─▶ formatCostPlan (stderr)
 */

export async function resolveInputPaths(paths: readonly string[], cwd: string): Promise<string[]> {
  const inputs = paths.length > 0 ? paths : ["."];
  const out: string[] = [];
  for (const p of inputs) {
    const abs = path.resolve(cwd, p);
    let isDir = false;
    try {
      isDir = (await stat(abs)).isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
    }
    if (!isDir) {
      throw new CliError(
        {
          code: "ATLAS-E061",
          problem: `Path not found or not a directory: ${p}`,
          cause: `${abs} does not exist or is a file.`,
          fix: "Pass the repository root directory (or omit paths to analyze the current directory).",
        },
        EXIT_USAGE,
      );
    }
    out.push(abs);
  }
  return out;
}

export function defaultOutDir(paths: readonly string[], cwd: string, out: string | undefined): string {
  return out !== undefined ? path.resolve(cwd, out) : path.join(paths[0] ?? cwd, ".atlas");
}

export async function runAnalysis(io: CliIo, paths: readonly string[], options: { cacheDir: string; history: boolean }): Promise<AnalysisResult> {
  let current: AnalysisPhase | undefined;
  const started = Date.now();
  let result: AnalysisResult;
  try {
    result = await analyzeWorkspace({
      roots: paths.map((p) => ({ path: p })),
      cacheDir: options.cacheDir,
      history: options.history,
      onPhase: (phase) => {
        if (phase === current) return;
        current = phase;
        io.stderr(`atlas: ${phase}…\n`);
      },
    });
  } catch (error) {
    throw new CliError(
      {
        code: "ATLAS-E065",
        problem: "Analysis failed.",
        cause: error instanceof Error ? error.message : String(error),
        fix: "Re-run with the same paths; if it persists, report it with the message above (no source code is included).",
      },
      EXIT_ANALYSIS,
    );
  }
  const g = result.graph;
  io.stderr(`atlas: analyzed ${g.services.length} service(s), ${g.entrypoints.length} entrypoint(s) in ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
  if (g.services.length === 0) {
    throw new CliError(
      {
        code: "ATLAS-E050",
        problem: "No supported stack was detected.",
        cause: `None of ${paths.join(", ")} contains a Spring Boot service or a Vue app.`,
        fix: "Check the path, or set `stack` for the service in atlas.yaml. v0.1 supports Java Spring and Vue.",
      },
      EXIT_ANALYSIS,
    );
  }
  return result;
}

function num(n: number): string {
  return n.toLocaleString("en-US");
}

function usd(n: number | undefined): string {
  return n === undefined ? "n/a" : `$${n.toFixed(2)}`;
}

export function formatCostPlan(plan: CostPlan, provider: string, maxInputTokens: number): string {
  const rows = [["phase", "calls", "input tokens", "output tokens", "est. USD"], ...plan.phases.map((p) => [p.phase, num(p.calls), num(p.inputTokens), num(p.outputTokens), usd(p.usd)])];
  rows.push(["total", num(plan.total.calls), num(plan.total.inputTokens), num(plan.total.outputTokens), usd(plan.total.usd)]);
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length))) ?? [];
  const line = (r: string[]) => `  ${r.map((c, i) => (i === 0 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0))).join("   ")}`;
  return [
    `AI cost plan — ${provider} / ${plan.model} (upper-bound estimate; nothing has been sent)`,
    ...rows.map(line),
    `  input-token cap: ${num(maxInputTokens)}${plan.total.usd === undefined ? " · no price known for this model" : ""}`,
    "",
  ].join("\n");
}
