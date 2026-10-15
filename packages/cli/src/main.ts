import { ANALYZER_VERSION } from "@project-atlas/core";
import { parseCliArgs, USAGE } from "./args.js";
import { analyzeCommand } from "./commands/analyze.js";
import { estimateCommand } from "./commands/estimate.js";
import { showCommand } from "./commands/show.js";
import { traceCommand } from "./commands/trace.js";
import { CliError, EXIT_OK, formatError } from "./errors.js";
import { processIo, type CliIo } from "./io.js";

/**
 * CLI entry: argv + injectable IO → exit code. Never calls process.exit, so
 * tests drive it in-process (fake fetch, captured streams, no TTY).
 *
 *   argv ─▶ parseCliArgs ─▶ analyze | show | estimate | help | version
 *              │                  │
 *              └─ CliError ───────┴─▶ stderr "error ATLAS-Exxx …" ─▶ exit 1 / 2
 */

export { parseCliArgs, USAGE } from "./args.js";
export type { CliIo } from "./io.js";
export { summarize, type AnalyzeSummary, type AiStatus } from "./commands/analyze.js";

export async function run(argv: readonly string[], io: CliIo = processIo()): Promise<number> {
  try {
    const cmd = parseCliArgs(argv);
    switch (cmd.command) {
      case "help":
        io.stdout(`${USAGE}\n`);
        return EXIT_OK;
      case "version":
        io.stdout(`project-atlas ${ANALYZER_VERSION}\n`);
        return EXIT_OK;
      case "analyze":
        return await analyzeCommand(cmd, io);
      case "estimate":
        return await estimateCommand(cmd, io);
      case "show":
        return await showCommand(cmd, io);
      case "trace":
        return await traceCommand(cmd, io);
    }
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    io.stderr(`${formatError(error.error)}\n`);
    return error.exitCode;
  }
}
