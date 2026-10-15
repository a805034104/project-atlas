import { buildAiInput, DEFAULT_MAX_INPUT_TOKENS, estimateAiCost } from "@project-atlas/core";
import { estimateTarget } from "../ai-config.js";
import type { EstimateCommand } from "../args.js";
import { defaultOutDir, formatCostPlan, resolveInputPaths, runAnalysis } from "../common.js";
import { EXIT_OK } from "../errors.js";
import type { CliIo } from "../io.js";

/**
 * `project-atlas estimate` — the AI cost plan, and nothing else.
 *
 *   paths ─▶ deterministic analysis (facts cache in out dir; graph NOT saved)
 *     ─▶ buildAiInput ─▶ estimateAiCost ─▶ stdout (table, or JSON with --json)
 *
 * Never creates a provider and never touches the network; works without a key.
 */

export async function estimateCommand(cmd: EstimateCommand, io: CliIo): Promise<number> {
  const paths = await resolveInputPaths(cmd.paths, io.cwd);
  const target = estimateTarget(cmd, io.env);
  const analysis = await runAnalysis(io, paths, { cacheDir: defaultOutDir(paths, io.cwd, cmd.out), history: !cmd.noHistory });
  const input = await buildAiInput(analysis.graph, analysis.workspace);
  const plan = estimateAiCost(input, target.model, target.provider);
  const maxInputTokens = cmd.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
  if (cmd.json) {
    io.stdout(`${JSON.stringify({ provider: target.provider, ...plan, maxInputTokens, withinBudget: plan.total.inputTokens <= maxInputTokens }, null, 2)}\n`);
  } else {
    io.stdout(formatCostPlan(plan, target.provider, maxInputTokens));
    io.stdout(`Hub files: ${input.files.length} · modules: ${input.modules.length} · entrypoints: ${input.entrypoints.length}\n`);
  }
  return EXIT_OK;
}
