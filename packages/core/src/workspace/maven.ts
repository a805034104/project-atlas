import { XMLParser } from "fast-xml-parser";
import type { SourceRef } from "../model/types.js";
import type { LoadedFile } from "./load.js";

/**
 * pom.xml → MavenModule. Only what module/service detection needs:
 * coordinates, child modules, dependencies, properties and profiles.
 */

export interface MavenDependency {
  groupId: string;
  artifactId: string;
}

export interface MavenProfile {
  id: string;
  activeByDefault: boolean;
  properties: Record<string, string>;
}

export interface MavenModule {
  rootId: string;
  /** Directory of the pom relative to the root ("" for the root pom). */
  dir: string;
  pom: SourceRef;
  groupId: string;
  artifactId: string;
  packaging: string;
  modules: string[];
  dependencies: MavenDependency[];
  properties: Record<string, string>;
  profiles: MavenProfile[];
}

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ["module", "dependency", "profile"].includes(name),
});

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(asRecord(value))) out[k] = str(v);
  return out;
}

export function parsePom(file: LoadedFile): MavenModule | undefined {
  if (!file.text) return undefined;
  let doc: Record<string, unknown>;
  try {
    doc = asRecord(parser.parse(file.text));
  } catch {
    return undefined;
  }
  const project = asRecord(doc["project"]);
  if (Object.keys(project).length === 0) return undefined;
  const parent = asRecord(project["parent"]);
  const deps = asRecord(project["dependencies"])["dependency"];
  const profiles = asRecord(project["profiles"])["profile"];
  const dir = file.relPath.includes("/") ? file.relPath.slice(0, file.relPath.lastIndexOf("/")) : "";
  return {
    rootId: file.rootId,
    dir,
    pom: { rootId: file.rootId, file: file.relPath, line: 1 },
    groupId: str(project["groupId"]) || str(parent["groupId"]),
    artifactId: str(project["artifactId"]),
    packaging: str(project["packaging"]) || "jar",
    modules: (asRecord(project["modules"])["module"] as unknown[] | undefined)?.map(str).filter(Boolean) ?? [],
    dependencies: ((deps as unknown[] | undefined) ?? []).map((d) => ({
      groupId: str(asRecord(d)["groupId"]),
      artifactId: str(asRecord(d)["artifactId"]),
    })),
    properties: stringMap(project["properties"]),
    profiles: ((profiles as unknown[] | undefined) ?? []).map((p) => {
      const rec = asRecord(p);
      return {
        id: str(rec["id"]),
        activeByDefault: str(asRecord(rec["activation"])["activeByDefault"]) === "true",
        properties: stringMap(rec["properties"]),
      };
    }),
  };
}

/** Internal dependency closure: artifactId → modules reachable through <dependency>. */
export function moduleClosure(start: MavenModule, all: readonly MavenModule[]): MavenModule[] {
  const byArtifact = new Map(all.map((m) => [m.artifactId, m]));
  const seen = new Set<MavenModule>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift() as MavenModule;
    for (const dep of current.dependencies) {
      const target = byArtifact.get(dep.artifactId);
      if (target && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return [...seen];
}
