import path from "node:path/posix";
import { parseSqlInserts } from "../config/sql.js";
import type { ScriptCall, ScriptFileFacts, ScriptValue } from "../facts/types.js";
import type { GraphBuilder } from "../graph/builder.js";
import { normalizeHttpPath, stableId } from "../model/ids.js";
import type { Entrypoint, SymbolRef } from "../model/types.js";
import type { FrontendApp } from "../workspace/detect.js";
import type { LoadedFile } from "../workspace/load.js";

/**
 * Vue rules for one frontend app.
 *
 *   src/api/*.js  export function listUser(q) { return request({ url, method }) }
 *        └─▶ api step + FrontendCall { method, url, browserPath = baseApi + url }
 *   views/**.vue  import { listUser } from '@/api/system/user'; listUser(...)
 *        └─▶ page step ─▶ api step
 *   routes: router/index.js route tables + RuoYi sys_menu rows (SQL) ─▶ frontend-route entrypoints
 */

export interface FrontendCall {
  stepId: string;
  method: string;
  /** URL as written in code, normalized (no base API). */
  url: string;
  /** Path the browser requests: baseApi + url. */
  browserPath: string;
  at: SymbolRef;
}

export interface FrontendRoute {
  entrypoint: Entrypoint;
  pageStepId: string;
}

export interface VueResult {
  calls: FrontendCall[];
  routes: FrontendRoute[];
}

const SCRIPT_EXTENSIONS = ["", ".js", ".ts", ".vue", "/index.js", "/index.ts", "/index.vue"];
const HTTP_VERBS = new Set(["get", "post", "put", "delete", "patch", "head", "options"]);

function urlOf(value: ScriptValue | undefined): string | undefined {
  if (!value) return undefined;
  if (value.kind === "string") return value.value;
  if (value.kind === "template") return value.value.replace(/\$\{[^}]*\}/g, "${}");
  return undefined;
}

export function runVueRules(app: FrontendApp, files: readonly LoadedFile[], sqlFiles: readonly LoadedFile[], graph: GraphBuilder): VueResult {
  const { service } = app;
  const root = service.rootId;
  const base = app.dir ? `${app.dir}/` : "";
  const appFiles = files.filter((f) => f.rootId === root && f.relPath.startsWith(base) && f.facts && f.facts.lang !== "java");
  const byPath = new Map(appFiles.map((f) => [f.relPath, f]));
  const result: VueResult = { calls: [], routes: [] };

  const resolveImport = (from: string, source: string): LoadedFile | undefined => {
    let target: string;
    if (source.startsWith("@/")) target = `${base}src/${source.slice(2)}`;
    else if (source.startsWith("~/")) target = `${base}src/${source.slice(2)}`;
    else if (source.startsWith(".")) target = path.normalize(path.join(path.dirname(from), source));
    else return undefined;
    for (const ext of SCRIPT_EXTENSIONS) {
      const hit = byPath.get(target + ext);
      if (hit) return hit;
    }
    return undefined;
  };

  // ── API helpers ───────────────────────────────────────────────────────────
  /** api file → exported function name → step id */
  const apiSteps = new Map<string, Map<string, string>>();
  for (const file of appFiles) {
    const facts = file.facts as ScriptFileFacts;
    const clients = new Set<string>();
    for (const imp of facts.imports) {
      const resolved = resolveImport(file.relPath, imp.source);
      if (imp.source === "axios" || /(request|http|axios|service)/i.test(resolved?.relPath ?? imp.source)) {
        if (imp.default) clients.add(imp.default);
        for (const n of imp.named) if (/^(request|http|service|axios)$/i.test(n.imported)) clients.add(n.local);
      }
    }
    if (clients.size === 0) continue;
    for (const fn of facts.functions) {
      if (!fn.exported) continue;
      const call = fn.calls.find((c) => clients.has(c.callee) || clients.has(c.callee.split(".")[0] ?? ""));
      if (!call) continue;
      const request = requestOf(call, clients);
      if (!request) continue;
      const at: SymbolRef = { rootId: root, file: file.relPath, line: fn.line, name: `${fn.name}()`, fqn: `${file.relPath}#${fn.name}` };
      const stepId = graph.step(service.id, service.name, "frontend", at.fqn, at);
      const perFile = apiSteps.get(file.relPath) ?? new Map<string, string>();
      perFile.set(fn.name, stepId);
      apiSteps.set(file.relPath, perFile);
      if (request.url === undefined) {
        graph.unresolved.push({ fromStepId: stepId, expression: `${call.callee}(…)`, reason: "unresolved-config", at });
        continue;
      }
      const url = normalizeHttpPath(request.url);
      result.calls.push({ stepId, method: request.method, url, browserPath: normalizeHttpPath(`${app.baseApi}/${request.url}`), at });
    }
  }

  // ── Pages ─────────────────────────────────────────────────────────────────
  const pageSteps = new Map<string, string>();
  const pageStep = (file: LoadedFile): string => {
    const existing = pageSteps.get(file.relPath);
    if (existing) return existing;
    const name = file.relPath.slice(`${base}src/`.length);
    const at: SymbolRef = { rootId: root, file: file.relPath, line: 1, name, fqn: file.relPath };
    const id = graph.step(service.id, service.name, "frontend", `page:${file.relPath}`, at);
    pageSteps.set(file.relPath, id);
    return id;
  };
  for (const file of appFiles) {
    if (apiSteps.has(file.relPath)) continue;
    const facts = file.facts as ScriptFileFacts;
    const locals = new Map<string, string>();
    for (const imp of facts.imports) {
      const target = resolveImport(file.relPath, imp.source);
      const steps = target ? apiSteps.get(target.relPath) : undefined;
      if (!steps) continue;
      for (const n of imp.named) {
        const id = steps.get(n.imported);
        if (id) locals.set(n.local, id);
      }
      if (imp.namespace) for (const [fn, id] of steps) locals.set(`${imp.namespace}.${fn}`, id);
    }
    if (locals.size === 0) continue;
    const calls = [...facts.calls, ...facts.functions.flatMap((f) => f.calls)].sort((a, b) => a.line - b.line);
    let order = 0;
    for (const call of calls) {
      const target = locals.get(call.callee) ?? locals.get(call.callee.replace(/^this\./, ""));
      if (target) graph.edge(pageStep(file), target, { provenance: "static", order: order++ });
    }
  }

  // ── Routes ────────────────────────────────────────────────────────────────
  const addRoute = (routePath: string, view: LoadedFile, evidence: SymbolRef): void => {
    const normalized = normalizeHttpPath(routePath);
    const entrypoint: Entrypoint = {
      id: stableId("entrypoint", service.name, `route:${normalized}`),
      serviceId: service.id,
      kind: "frontend-route",
      path: normalized,
      handler: evidence,
    };
    if (graph.entrypoints.has(entrypoint.id)) return;
    graph.addEntrypoint(entrypoint);
    result.routes.push({ entrypoint, pageStepId: pageStep(view) });
  };
  const viewFile = (component: string): LoadedFile | undefined => {
    const clean = component.replace(/^@\/views\//, "").replace(/^\/+/, "");
    for (const ext of ["", ".vue", "/index.vue", ".js", ".ts"]) {
      const hit = byPath.get(`${base}src/views/${clean}${ext}`) ?? byPath.get(`${base}src/${clean.replace(/^@\//, "")}${ext}`);
      if (hit) return hit;
    }
    return undefined;
  };

  const routerFile = appFiles.find((f) => new RegExp(`^${base}src/router/index\\.[jt]s$`).test(f.relPath));
  if (routerFile) {
    const facts = routerFile.facts as ScriptFileFacts;
    const walk = (value: ScriptValue, parent: string): void => {
      if (value.kind === "array") {
        for (const item of value.items) walk(item, parent);
        return;
      }
      if (value.kind !== "object") return;
      const own = value.props["path"]?.kind === "string" ? (value.props["path"] as { value: string }).value : "";
      const full = own.startsWith("/") ? own : `${parent.replace(/\/$/, "")}/${own}`;
      const component = value.props["component"];
      const source = component?.kind === "dynamic-import" || component?.kind === "require" ? component.source : undefined;
      const view = source ? (resolveImport(routerFile.relPath, source) ?? viewFile(source)) : undefined;
      if (view && !full.includes("(")) addRoute(full || "/", view, { rootId: root, file: routerFile.relPath, line: 1, name: `route ${full || "/"}`, fqn: `route:${full}` });
      const children = value.props["children"];
      if (children) walk(children, full);
    };
    for (const variable of facts.variables) if (variable.value.kind === "array") walk(variable.value, "");
  }

  for (const sql of sqlFiles) {
    if (!sql.text || !/insert\s+into\s+`?sys_menu/i.test(sql.text)) continue;
    const rows = parseSqlInserts(sql.text, "sys_menu");
    const byId = new Map(rows.map((r) => [r.values["menu_id"] ?? "", r]));
    const fullPath = (row: (typeof rows)[number], depth = 0): string => {
      const own = row.values["path"] ?? "";
      const parent = byId.get(row.values["parent_id"] ?? "");
      if (!parent || depth > 8) return `/${own}`;
      return `${fullPath(parent, depth + 1).replace(/\/$/, "")}/${own}`;
    };
    for (const row of rows) {
      const component = row.values["component"];
      if (row.values["menu_type"] !== "C" || !component || component === "null") continue;
      const view = viewFile(component);
      if (!view) continue;
      addRoute(fullPath(row), view, { rootId: sql.rootId, file: sql.relPath, line: row.line, name: `menu ${row.values["menu_name"] ?? ""}`, fqn: `sys_menu:${row.values["menu_id"]}` });
    }
  }

  return result;
}

function requestOf(call: ScriptCall, clients: Set<string>): { method: string; url: string | undefined } | undefined {
  const [head, verb] = call.callee.split(".");
  if (head && clients.has(head) && verb && HTTP_VERBS.has(verb.toLowerCase())) {
    return { method: verb.toUpperCase(), url: urlOf(call.args[0]) };
  }
  if (clients.has(call.callee) || (head && clients.has(head) && verb === "request")) {
    const opts = call.args[0];
    if (opts?.kind === "string") return { method: "GET", url: opts.value };
    if (opts?.kind !== "object") return undefined;
    const method = opts.props["method"];
    return { method: method?.kind === "string" ? method.value.toUpperCase() : "GET", url: urlOf(opts.props["url"]) };
  }
  return undefined;
}
