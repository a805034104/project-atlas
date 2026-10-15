import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyzeWorkspace } from "../../src/analyze.js";
import type { AtlasGraph } from "../../src/model/types.js";

/** Write a throwaway workspace (relative path → content) into a fresh temp dir. */
export async function writeTree(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "atlas-synth-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

export function pom(artifactId: string, deps: string[] = []): string {
  return `<project><groupId>demo</groupId><artifactId>${artifactId}</artifactId><dependencies>${deps
    .map((d) => `<dependency><groupId>x</groupId><artifactId>${d}</artifactId></dependency>`)
    .join("")}</dependencies></project>`;
}

export function nacosDump(rows: Record<string, string>): string {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n");
  return `insert into config_info(id, data_id, group_id, content, tenant_id) values ${Object.entries(rows)
    .map(([id, content], i) => `(${i + 1},'${id}','DEFAULT_GROUP','${esc(content)}','')`)
    .join(",\n")};\n`;
}

/** Minimal single-service Spring app around the given Java sources (package `app`). */
export function springApp(sources: Record<string, string>, extra: Record<string, string> = {}): Record<string, string> {
  const files: Record<string, string> = {
    "pom.xml": pom("app"),
    "src/main/java/app/App.java": "package app;\n@SpringBootApplication\npublic class App {}\n",
    "src/main/resources/application.yml": "server:\n  port: 8080\nspring:\n  application:\n    name: app\n",
    ...extra,
  };
  for (const [name, body] of Object.entries(sources)) files[`src/main/java/app/${name}`] = `package app;\n${body}\n`;
  return files;
}

export async function analyzeTree(files: Record<string, string>): Promise<AtlasGraph> {
  const dir = await writeTree(files);
  return (await analyzeWorkspace({ roots: [{ path: dir }], history: false })).graph;
}

/** Names of the steps called from the handler of `METHOD path`. */
export function calleesOf(graph: AtlasGraph, method: string, entryPath: string): { name: string; rationale?: string }[] {
  const ep = graph.entrypoints.find((e) => e.kind === "http" && e.method === method && e.path === entryPath);
  if (!ep) throw new Error(`no entrypoint ${method} ${entryPath}`);
  const handler = graph.steps.find((s) => s.symbol.fqn === ep.handler.fqn && s.layer === "controller");
  const steps = new Map(graph.steps.map((s) => [s.id, s]));
  return graph.edges
    .filter((e) => e.from === handler?.id && !e.chain)
    .sort((a, b) => a.order - b.order)
    .map((e) => ({ name: steps.get(e.to)?.symbol.name ?? "?", ...(e.rationale ? { rationale: e.rationale } : {}) }));
}
