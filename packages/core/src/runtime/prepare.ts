import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AtlasGraph, Service } from "../model/types.js";
import { buildAgentConfig, formatMethodsInclude, instrumentedMethods } from "./agent-config.js";
import { runtimeConfigDir } from "./agent-fetch.js";

/** Services that can be traced with the Java agent. */
export function traceableServices(graph: AtlasGraph): Service[] {
  return graph.services.filter((s) => s.stack === "java-spring");
}

/** Absolute directory of a service (root path + service path). */
export function serviceDir(graph: AtlasGraph, service: Service): string | undefined {
  const root = graph.project.roots.find((r) => r.id === service.rootId);
  return root ? path.join(root.path, service.path) : undefined;
}

export interface PreparedAgentConfig {
  configPath: string;
  methods: number;
  classes: number;
}

/**
 * Write the agent configuration for one service (outside the workspace, ASCII-safe
 * directory, mode 600: it holds the receiver token) and return its path.
 */
export async function writeAgentConfigFile(input: { graph: AtlasGraph; service: Service; workspace: string; endpoint: string; token: string; homeDir?: string; include?: readonly string[]; exclude?: readonly string[] }): Promise<PreparedAgentConfig> {
  const methods = instrumentedMethods(input.graph, { serviceIds: [input.service.id], ...(input.include ? { include: input.include } : {}), ...(input.exclude ? { exclude: input.exclude } : {}) });
  const dir = runtimeConfigDir(input.homeDir);
  await mkdir(dir, { recursive: true });
  const configPath = path.join(dir, `${input.service.name.replace(/[^\w.-]/g, "_")}-${createHash("sha1").update(path.resolve(input.workspace)).digest("hex").slice(0, 8)}.properties`);
  await writeFile(configPath, buildAgentConfig({ serviceName: input.service.name, endpoint: input.endpoint, token: input.token, methodsInclude: formatMethodsInclude(methods) }), { mode: 0o600 });
  return { configPath, methods: [...methods.values()].reduce((n, m) => n + m.size, 0), classes: methods.size };
}
