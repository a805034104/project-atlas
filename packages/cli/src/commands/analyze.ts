import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildAiInput,
  createProvider,
  DEFAULT_MAX_INPUT_TOKENS,
  enrichWithAi,
  estimateAiCost,
  LlmBudgetExceeded,
  LlmError,
  renderAtlasMarkdown,
  saveGraph,
  type AtlasGraph,
  type LlmUsage,
} from "@project-atlas/core";
import { displayUrl, selectProvider } from "../ai-config.js";
import type { AnalyzeCommand } from "../args.js";
import { defaultOutDir, formatCostPlan, resolveInputPaths, runAnalysis } from "../common.js";
import { CliError, EXIT_ANALYSIS, EXIT_OK, formatError } from "../errors.js";
import type { CliIo } from "../io.js";

/**
 * `project-atlas analyze`
 *
 *   paths ─▶ provider selection (fail fast on bad AI config)
 *     ─▶ analyzeWorkspace (cacheDir = out) ─▶ saveGraph       ← deterministic map is now usable
 *     ─▶ [AI configured ∧ ¬--no-ai] cost plan ─▶ --yes | TTY y/N | non-TTY: skip
 *          ─▶ enrichWithAi(io.fetch) ─▶ saveGraph again
 *     ─▶ [--markdown] ATLAS.md ─▶ summary (stdout: JSON with --json, else text)
 */

export type AiStatus = "disabled" | "not-configured" | "declined" | "skipped-non-interactive" | "skipped-over-budget" | "done" | "partial" | "failed";

export interface AnalyzeSummary {
  services: { id: string; name: string; kind: string; stack: string; path: string }[];
  entrypoints: number;
  links: number;
  unresolved: number;
  diagnostics: { error: number; warning: number; info: number };
  aiUsage: { status: AiStatus; inputTokens: number; outputTokens: number; phases: LlmUsage[] };
}

async function save(outDir: string, graph: AtlasGraph): Promise<void> {
  try {
    await saveGraph(outDir, graph);
  } catch (error) {
    throw writeError(path.join(outDir, "graph"), error);
  }
}

function writeError(target: string, error: unknown): CliError {
  return new CliError(
    {
      code: "ATLAS-E064",
      problem: `Cannot write ${target}.`,
      cause: error instanceof Error ? error.message : String(error),
      fix: "Check that the directory is writable, or choose another location with --out / --markdown.",
    },
    EXIT_ANALYSIS,
  );
}

export function summarize(graph: AtlasGraph, status: AiStatus): AnalyzeSummary {
  const diagnostics = { error: 0, warning: 0, info: 0 };
  for (const d of graph.diagnostics) diagnostics[d.severity]++;
  return {
    services: graph.services.map((s) => ({ id: s.id, name: s.name, kind: s.kind, stack: s.stack, path: s.path })),
    entrypoints: graph.entrypoints.length,
    links: graph.serviceLinks.length,
    unresolved: graph.unresolvedCalls.length,
    diagnostics,
    aiUsage: {
      status,
      inputTokens: graph.llmUsage.reduce((n, u) => n + u.inputTokens, 0),
      outputTokens: graph.llmUsage.reduce((n, u) => n + u.outputTokens, 0),
      phases: graph.llmUsage,
    },
  };
}

export async function analyzeCommand(cmd: AnalyzeCommand, io: CliIo): Promise<number> {
  const paths = await resolveInputPaths(cmd.paths, io.cwd);
  const outDir = defaultOutDir(paths, io.cwd, cmd.out);
  // Resolve AI config before the (slow) analysis so a missing key fails in milliseconds.
  const selection = cmd.noAi ? undefined : selectProvider(cmd, io.env);

  const analysis = await runAnalysis(io, paths, { cacheDir: outDir, history: !cmd.noHistory });
  let graph = analysis.graph;
  await save(outDir, graph);
  io.stderr(`atlas: saved ${path.join(outDir, "graph")}\n`);

  let status: AiStatus = cmd.noAi ? "disabled" : "not-configured";
  if (selection?.status === "configured") {
    const { config } = selection;
    const maxInputTokens = cmd.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
    const input = await buildAiInput(graph, analysis.workspace);
    const plan = estimateAiCost(input, config.model, config.provider);
    io.stderr(`\n${formatCostPlan(plan, `${config.provider} @ ${displayUrl(config.baseUrl)}`, maxInputTokens)}`);

    if (plan.total.inputTokens > maxInputTokens) {
      status = "skipped-over-budget";
      io.stderr(`${formatError(new LlmBudgetExceeded(0, plan.total.inputTokens, maxInputTokens).toUserFacing(), "warning")}\natlas: AI skipped; the deterministic map is saved.\n`);
    } else {
      let confirmed = cmd.yes;
      if (!confirmed && io.interactive) {
        const answer = await io.ask(`Send this to ${config.provider}? [y/N] `);
        confirmed = /^\s*y(es)?\s*$/i.test(answer);
        if (!confirmed) status = "declined";
      } else if (!confirmed) {
        status = "skipped-non-interactive";
        io.stderr("atlas: AI skipped — not a terminal and --yes was not given. Nothing was sent. Re-run with --yes to confirm the plan above.\n");
      }
      if (status === "declined") io.stderr("atlas: AI declined. Nothing was sent; the deterministic map is saved.\n");
      if (confirmed) {
        const provider = createProvider(config, io.fetch);
        let lastPhase = "";
        try {
          const { graph: enriched, result } = await enrichWithAi({
            graph,
            input,
            provider,
            cacheDir: outDir,
            language: cmd.lang ?? (io.env.ATLAS_LANG?.toLowerCase().startsWith("zh") ? "zh-cn" : "en"),
            maxInputTokens,
            onProgress: (p) => {
              if (p.phase !== lastPhase) io.stderr(`atlas: ai ${p.phase}…\n`);
              lastPhase = p.phase;
            },
          });
          graph = enriched;
          status = result.failures.length > 0 ? "partial" : "done";
          if (result.failures.length > 0) {
            const first = result.failures[0];
            io.stderr(`atlas: ${result.failures.length} AI request(s) failed; results are partial (cached answers are reused next time).\n`);
            if (first) io.stderr(`${formatError(first.error, "warning")}\n`);
          }
        } catch (error) {
          if (!(error instanceof LlmError)) throw error;
          status = "failed";
          io.stderr(`${formatError(error.toUserFacing(), "warning")}\natlas: AI enrichment stopped; the deterministic map is saved.\n`);
        }
        if (status !== "failed") await save(outDir, graph);
      }
    }
  }

  if (cmd.markdown !== undefined) {
    const file = path.resolve(io.cwd, cmd.markdown);
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, renderAtlasMarkdown(graph, cmd.lang ? { language: cmd.lang } : {}));
    } catch (error) {
      throw writeError(file, error);
    }
    io.stderr(`atlas: wrote ${file}\n`);
  }

  const summary = summarize(graph, status);
  if (cmd.json) io.stdout(`${JSON.stringify(summary, null, 2)}\n`);
  else {
    const d = summary.diagnostics;
    io.stdout(
      [
        `Services: ${summary.services.map((s) => `${s.name} (${s.kind})`).join(", ")}`,
        `Entrypoints: ${summary.entrypoints} · Cross-service links: ${summary.links} · Unresolved calls: ${summary.unresolved}`,
        `Diagnostics: ${d.error} error(s), ${d.warning} warning(s), ${d.info} info`,
        `AI: ${status}${summary.aiUsage.inputTokens > 0 ? ` (${summary.aiUsage.inputTokens} in / ${summary.aiUsage.outputTokens} out tokens)` : ""}`,
        `Graph: ${path.join(outDir, "graph")}`,
        `Next: project-atlas show "<METHOD /path>" --dir ${JSON.stringify(outDir)}`,
        "",
      ].join("\n"),
    );
  }
  return EXIT_OK;
}
