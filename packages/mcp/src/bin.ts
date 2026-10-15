#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAtlasServer } from "./server.js";

/**
 * atlas-mcp [--dir <path to .atlas>]   (default ./.atlas)
 * stdout carries the MCP protocol; diagnostics go to stderr only.
 */

const USAGE = "Usage: atlas-mcp [--dir <path to .atlas>]\nRead-only MCP server over stdio for a ProjectAtlas graph (default ./.atlas).\n";

async function main(): Promise<void> {
  let dir: string;
  try {
    const { values } = parseArgs({ args: process.argv.slice(2), options: { dir: { type: "string" }, help: { type: "boolean", short: "h" } }, strict: true });
    if (values.help) {
      process.stderr.write(USAGE);
      return;
    }
    dir = path.resolve(values.dir ?? ".atlas");
  } catch (error) {
    if (!(error as NodeJS.ErrnoException).code?.startsWith("ERR_PARSE_ARGS")) throw error;
    process.stderr.write(`error ATLAS-E060: ${(error as Error).message}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const server = createAtlasServer(dir);
  await server.connect(new StdioServerTransport());
  process.stderr.write(`atlas-mcp: serving ${dir} (read-only)\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`atlas-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
