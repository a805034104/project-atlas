import type { ConfigDocument, ConfigEntry } from "./sources.js";

/**
 * Layered, profile-aware config view with Spring-style placeholder resolution.
 *
 *   layers (highest priority first) ─▶ get(key)  [relaxed binding]
 *                                   └▶ resolve("${a:${b:x}}")  [nested, cycle-safe]
 *
 * SpEL (`#{...}`) is never evaluated; it is reported as unresolved.
 */

export interface ConfigLayer {
  name: string;
  documents: ConfigDocument[];
}

export interface Resolved {
  value: string;
  /** Placeholders that could not be resolved (kept verbatim in `value`). */
  unresolved: string[];
}

/** Relaxed binding: `spring.application.name` == `spring.Application-Name` == `SPRING_APPLICATION_NAME`. */
export function canonicalKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/_/g, ".")
    .split(".")
    .map((segment) => segment.replace(/-/g, ""))
    .join(".");
}

const MAX_DEPTH = 16;

/** `a.b[0].c[2].d` → ["a.b", "a.b[0].c"]: every list the key lives in. */
function listBases(canonical: string): string[] {
  const out: string[] = [];
  const re = /\[\d+\]/g;
  for (let m = re.exec(canonical); m; m = re.exec(canonical)) out.push(canonical.slice(0, m.index));
  return out;
}

export class ConfigView {
  private readonly index = new Map<string, ConfigEntry>();
  private readonly ordered: ConfigEntry[] = [];

  constructor(
    layers: readonly ConfigLayer[],
    readonly profiles: readonly string[] = [],
    /** Maven resource-filtering tokens substituted for `@name@` before placeholder resolution. */
    private readonly mavenTokens: Readonly<Record<string, string>> = {},
  ) {
    // Spring replaces lists wholesale: once a higher-priority document defines any `a.b[i]…`,
    // lower-priority documents contribute nothing under `a.b[`.
    const claimedLists = new Set<string>();
    for (const layer of layers) {
      // Within a file, later documents override earlier ones.
      const active = layer.documents.filter((d) => !d.profiles || d.profiles.some((p) => profiles.includes(p)));
      for (const doc of [...active].reverse()) {
        const listsHere = new Set<string>();
        for (const entry of doc.entries) {
          const canonical = canonicalKey(entry.key);
          const bases = listBases(canonical);
          if (bases.some((b) => claimedLists.has(b))) continue;
          for (const b of bases) listsHere.add(b);
          if (!this.index.has(canonical)) {
            this.index.set(canonical, entry);
            this.ordered.push(entry);
          }
        }
        for (const b of listsHere) claimedLists.add(b);
      }
    }
  }

  get(key: string): ConfigEntry | undefined {
    return this.index.get(canonicalKey(key));
  }

  /** Resolved value of a key, or undefined when the key is absent. */
  value(key: string): Resolved | undefined {
    const entry = this.get(key);
    return entry ? this.resolve(entry.value) : undefined;
  }

  /** Entries whose key starts with `prefix.` or `prefix[`, in priority order. */
  list(prefix: string): ConfigEntry[] {
    const canonical = canonicalKey(prefix);
    return this.ordered.filter((e) => {
      const k = canonicalKey(e.key);
      return k.startsWith(`${canonical}.`) || k.startsWith(`${canonical}[`);
    });
  }

  resolve(raw: string): Resolved {
    const unresolved: string[] = [];
    const filtered = raw.replace(/@([\w.-]+)@/g, (m, key: string) => this.mavenTokens[key] ?? m);
    const value = this.expand(filtered, [], unresolved);
    return { value, unresolved };
  }

  private expand(text: string, stack: string[], unresolved: string[]): string {
    let out = "";
    let i = 0;
    while (i < text.length) {
      const start = text.indexOf("${", i);
      if (start < 0) {
        out += text.slice(i);
        break;
      }
      out += text.slice(i, start);
      const end = matchingBrace(text, start + 1);
      if (end < 0) {
        out += text.slice(start);
        break;
      }
      const body = text.slice(start + 2, end);
      const colon = topLevelColon(body);
      const key = colon < 0 ? body : body.slice(0, colon);
      const fallback = colon < 0 ? undefined : body.slice(colon + 1);
      const canonical = canonicalKey(key);
      const entry = this.index.get(canonical);
      if (entry && !stack.includes(canonical) && stack.length < MAX_DEPTH) {
        out += this.expand(entry.value, [...stack, canonical], unresolved);
      } else if (fallback !== undefined) {
        out += this.expand(fallback, stack, unresolved);
      } else {
        unresolved.push(key);
        out += text.slice(start, end + 1);
      }
      i = end + 1;
    }
    if (out.includes("#{")) unresolved.push(out.slice(out.indexOf("#{")));
    return out;
  }
}

function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

function topLevelColon(body: string): number {
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ":" && depth === 0) return i;
  }
  return -1;
}
