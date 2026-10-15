import { docsUrlFor, type UserFacingError } from "@project-atlas/core";

/**
 * CLI error contract (spec DX Pass 3): every failure the user sees is
 * `ATLAS-Exxx problem / cause / fix / docs` on stderr plus an exit code.
 *
 *   code         meaning                                   exit
 *   ──────────   ───────────────────────────────────────   ────
 *   ATLAS-E060   usage: unknown command/option, bad value   2
 *   ATLAS-E061   input path does not exist                  2
 *   ATLAS-E063   entrypoint not found / ambiguous           2
 *   ATLAS-E020   AI provider configured without a key       2
 *   ATLAS-E062   no (or corrupt) .atlas graph store         1
 *   ATLAS-E064   cannot write an output file                1
 *   ATLAS-E050   no supported stack detected                1
 *   ATLAS-E065   analysis failed unexpectedly               1
 *
 * AI problems after analysis (declined, E021–E026, partial failures) are
 * warnings: the deterministic map was produced, so the exit code stays 0.
 */

export const EXIT_OK = 0;
export const EXIT_ANALYSIS = 1;
export const EXIT_USAGE = 2;

export class CliError extends Error {
  constructor(
    readonly error: Omit<UserFacingError, "docsUrl">,
    readonly exitCode: number,
  ) {
    super(`${error.code}: ${error.problem}`);
    this.name = "CliError";
  }
}

export function usageError(problem: string, fix = "Run `project-atlas --help` for usage."): CliError {
  return new CliError({ code: "ATLAS-E060", problem, cause: "The command line could not be parsed.", fix }, EXIT_USAGE);
}

export function storeError(dir: string, cause: string): CliError {
  return new CliError(
    {
      code: "ATLAS-E062",
      problem: `No usable Atlas graph in ${dir}.`,
      cause,
      fix: "Run `project-atlas analyze` in the project (or the VS Code command “Atlas: Analyze Workspace”), or pass --dir <path to .atlas>.",
    },
    EXIT_ANALYSIS,
  );
}

/** Multi-line, key-free rendering for stderr. */
export function formatError(error: Omit<UserFacingError, "docsUrl"> & { docsUrl?: string }, level: "error" | "warning" = "error"): string {
  return [
    `${level} ${error.code}: ${error.problem}`,
    `  cause: ${error.cause}`,
    `  fix:   ${error.fix}`,
    `  docs:  ${error.docsUrl ?? docsUrlFor(error.code)}`,
  ].join("\n");
}
