#!/usr/bin/env node
import { run } from "./main.js";

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Not a CliError: a bug. Report it in the error contract shape, exit 1.
    process.stderr.write(
      `error ATLAS-E065: Unexpected failure.\n  cause: ${error instanceof Error ? error.message : String(error)}\n  fix:   Please report this with the command you ran.\n`,
    );
    if (process.env.ATLAS_DEBUG && error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  },
);
