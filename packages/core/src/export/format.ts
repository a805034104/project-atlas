import path from "node:path";
import type { FlowDetailData } from "../protocol.js";
import type { AtlasGraph, Entrypoint, SourceRef } from "../model/types.js";
import { entrypointLabel } from "../overrides/apply.js";

/**
 * Plain-text building blocks shared by ATLAS.md, the CLI and the MCP server,
 * so all three print the same `file:line` and flow-step notation.
 *
 *   SourceRef ─▶ formatRef ─▶ "ruoyi-admin/src/…/SysUserController.java:59"
 *                               (prefixed "<root>/" only in multi-root graphs)
 *   FlowDetailData ─▶ flowStepLines ─▶ ["filter · XssFilter.doFilter (…:43)", …]
 *   query ─▶ findEntrypoints ─▶ id | "GET /system/user/list" | "/system/user/list"
 *
 * Never prints absolute paths: output is meant to be committed and shared.
 */

export type RefFormatter = (ref: SourceRef) => string;

export function createRefFormatter(graph: Pick<AtlasGraph, "project">): RefFormatter {
  const roots = graph.project.roots;
  const prefix = new Map<string, string>();
  if (roots.length > 1) for (const r of roots) prefix.set(r.id, `${path.basename(r.path)}/`);
  return (ref) => `${prefix.get(ref.rootId) ?? ""}${ref.file}${ref.line !== undefined ? `:${ref.line}` : ""}`;
}

/** `layer · Symbol (file:line)` for each step, in flow order. */
export function flowStepLines(detail: FlowDetailData, fmt: RefFormatter, options: { withService?: boolean } = {}): string[] {
  const serviceName = new Map(detail.services.map((s) => [s.id, s.name]));
  const multi = options.withService ?? detail.services.length > 1;
  return detail.steps.map((s) => {
    const service = multi ? ` [${serviceName.get(s.serviceId) ?? s.serviceId}]` : "";
    return `${s.layer} · ${s.symbol.name} (${fmt(s.symbol)})${service}`;
  });
}

/** Stable order for entrypoints: label, then service, then id. */
export function compareEntrypoints(a: Entrypoint, b: Entrypoint): number {
  return cmp(a.path ?? a.handler.name, b.path ?? b.handler.name) || cmp(a.method ?? "", b.method ?? "") || cmp(a.serviceId, b.serviceId) || cmp(a.id, b.id);
}

export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Resolve a user-typed entrypoint reference. Tries, in order: exact id, exact
 * label (method case-insensitive, e.g. "get /system/user/list"), bare path.
 * Returns every match at the first level that matches anything.
 */
export function findEntrypoints(graph: Pick<AtlasGraph, "entrypoints">, query: string): Entrypoint[] {
  const q = query.trim();
  const byId = graph.entrypoints.filter((e) => e.id === q);
  if (byId.length > 0) return byId;
  const normalized = q.replace(/\s+/, " ");
  const space = normalized.indexOf(" ");
  const label = space < 0 ? normalized : `${normalized.slice(0, space).toUpperCase()}${normalized.slice(space)}`;
  const byLabel = graph.entrypoints.filter((e) => entrypointLabel(e) === label);
  if (byLabel.length > 0) return [...byLabel].sort(compareEntrypoints);
  return graph.entrypoints.filter((e) => e.path !== undefined && e.path === q).sort(compareEntrypoints);
}
