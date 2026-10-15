#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { run } from "./main.js";

// Node's fetch ignores HTTP(S)_PROXY unless NODE_USE_ENV_PROXY is set at startup, so re-run
// once with it enabled; without this, AI calls bypass the user's proxy (403 in unsupported regions).
const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];
if (PROXY_VARS.some((k) => process.env[k]) && process.env.NODE_USE_ENV_PROXY === undefined) {
  const child = spawnSync(process.execPath, ["--disable-warning=UNDICI-EHPA", ...process.execArgv, ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, NODE_USE_ENV_PROXY: "1" },
  });
  process.exit(child.status ?? 1);
}

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
