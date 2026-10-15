import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ANALYZER_VERSION, MAX_FLOW_DEPTH, type GraphView } from "@project-atlas/core";
import { z } from "zod";
import { GraphSource, StoreUnavailableError } from "./store.js";
import { findSymbol, getFlow, getModuleHistory, listEntrypoints, listServices, ToolInputError, type ToolOutput } from "./tools.js";

/**
 * Read-only MCP server over stdio (spec T2, child #20).
 *
 *   MCP client ──stdio──▶ McpServer ─▶ tool(args) ─▶ GraphSource.view() ─▶ pure tool fn
 *                                                        │                     │
 *                          missing/corrupt store ◀───────┘     { text, data } ─┘
 *                          → isError result with "run project-atlas analyze"
 *
 * No tool analyzes, writes, or calls an LLM; there is no network listener.
 */

export { GraphSource, StoreUnavailableError } from "./store.js";
export * from "./tools.js";

export const TOOL_NAMES = ["list_services", "list_entrypoints", "get_flow", "find_symbol", "get_module_history"] as const;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const ENTRYPOINT_KINDS = ["http", "mq-consumer", "scheduled", "cli-main", "frontend-route", "websocket"] as const;
const limit = (max: number, fallback: number) => z.number().int().min(1).max(max).optional().describe(`Maximum results (default ${fallback}).`);
/** Structured output is a loose object: the text content is the primary, documented shape. */
const anyRecords = z.array(z.record(z.string(), z.unknown()));

async function respond(source: GraphSource, tool: (view: GraphView) => ToolOutput): Promise<CallToolResult> {
  try {
    const out = tool(await source.view());
    return { content: [{ type: "text", text: out.text }], structuredContent: out.data };
  } catch (error) {
    if (error instanceof StoreUnavailableError || error instanceof ToolInputError) {
      return { content: [{ type: "text", text: error.message }], isError: true };
    }
    throw error;
  }
}

export function createAtlasServer(atlasDir: string): McpServer {
  const source = new GraphSource(atlasDir);
  const server = new McpServer({ name: "project-atlas", version: ANALYZER_VERSION });

  server.registerTool(
    "list_services",
    {
      title: "List services",
      description: "Services detected in the analyzed workspace (name, kind, stack, path, entrypoint/module counts) and aggregated cross-service links.",
      outputSchema: { project: z.string(), analyzedAt: z.string(), services: anyRecords, links: anyRecords },
      annotations: READ_ONLY,
    },
    () => respond(source, listServices),
  );

  server.registerTool(
    "list_entrypoints",
    {
      title: "List entrypoints",
      description: 'HTTP endpoints, message consumers (Kafka/RabbitMQ/RocketMQ/Redis Stream/Spring Cloud Stream), scheduled jobs and frontend routes with their handler and file:line. Labels such as "GET /system/user/list" or "KAFKA order-created" can be passed to get_flow.',
      inputSchema: {
        service: z.string().optional().describe("Service name or id."),
        kind: z.enum(ENTRYPOINT_KINDS).optional(),
        method: z.string().optional().describe("HTTP method, e.g. GET."),
        pathContains: z.string().optional().describe("Case-insensitive substring of the path (or handler name for non-HTTP entrypoints)."),
        limit: limit(1000, 100),
      },
      outputSchema: { total: z.number(), returned: z.number(), entrypoints: anyRecords },
      annotations: READ_ONLY,
    },
    (args) => respond(source, (view) => listEntrypoints(view, args)),
  );

  server.registerTool(
    "get_flow",
    {
      title: "Get request flow",
      description:
        "The statically verified call chain of one entrypoint, in order: filters → interceptors → controller → services → mappers → SQL (and frontend/gateway hops), each as layer · symbol (file:line).",
      inputSchema: {
        entrypoint: z.string().min(1).describe('Entrypoint id, or label like "GET /system/user/list".'),
        depth: z.number().int().min(1).max(MAX_FLOW_DEPTH).optional().describe(`Re-project deeper than the stored default (max ${MAX_FLOW_DEPTH}).`),
      },
      outputSchema: { entrypoint: z.record(z.string(), z.unknown()), truncated: z.boolean(), steps: anyRecords, unresolvedCalls: anyRecords },
      annotations: READ_ONLY,
    },
    (args) => respond(source, (view) => getFlow(view, args)),
  );

  server.registerTool(
    "find_symbol",
    {
      title: "Find symbol",
      description: "Case-insensitive substring search over call-graph step symbols (name or fully-qualified name); returns file:line and which entrypoint flows include each step.",
      inputSchema: { query: z.string().min(1).describe("e.g. SysUserServiceImpl.selectUserList or selectUserList"), limit: limit(200, 20) },
      outputSchema: { total: z.number(), returned: z.number(), steps: anyRecords },
      annotations: READ_ONLY,
    },
    (args) => respond(source, (view) => findSymbol(view, args)),
  );

  server.registerTool(
    "get_module_history",
    {
      title: "Get module history",
      description: "Recent git commits recorded for one module (newest first), with the 90-day commit count and any AI summary.",
      inputSchema: { module: z.string().min(1).describe("Module id or name, e.g. ruoyi-system."), limit: limit(500, 20) },
      outputSchema: {
        module: z.record(z.string(), z.unknown()),
        total: z.number(),
        returned: z.number(),
        commits90d: z.number(),
        degraded: z.string().optional(),
        aiSummary: z.string().optional(),
        commits: anyRecords,
      },
      annotations: READ_ONLY,
    },
    (args) => respond(source, (view) => getModuleHistory(view, args)),
  );

  return server;
}
