import { isAlias, isMap, isScalar, isSeq, LineCounter, parseAllDocuments, type Document, type Node as YamlNode } from "yaml";
import type { SourceRef } from "../model/types.js";

/**
 * Config sources → flat key/value entries with locations.
 *
 *   application.yml ─┐
 *   *.properties ────┼─▶ ConfigDocument { entries: key → { value, at }, profiles? }
 *   .env ────────────┤
 *   Nacos SQL dump ──┘ (config_info rows → yml documents)
 */

export interface ConfigEntry {
  key: string;
  value: string;
  at: SourceRef;
}

export interface ConfigDocument {
  /** Profiles this document is restricted to (`spring.config.activate.on-profile`); undefined = always. */
  profiles?: string[];
  entries: ConfigEntry[];
}

function flatten(
  node: YamlNode | null | undefined,
  prefix: string,
  out: ConfigEntry[],
  ref: (offset: number) => SourceRef,
  doc: Document.Parsed,
  depth = 0,
): void {
  if (!node || depth > 32) return;
  if (isAlias(node)) {
    flatten(node.resolve(doc) as YamlNode | undefined, prefix, out, ref, doc, depth + 1);
    return;
  }
  if (isMap(node)) {
    const merged: ConfigEntry[] = [];
    for (const pair of node.items) {
      const keyNode = pair.key as YamlNode | null;
      const key = isScalar(keyNode) ? String(keyNode.value) : String(keyNode ?? "");
      if (key === "<<") {
        // Merge keys: explicit keys of this map win, so merged entries go last.
        const sources = isSeq(pair.value) ? (pair.value.items as YamlNode[]) : [pair.value as YamlNode];
        for (const source of sources) flatten(source, prefix, merged, ref, doc, depth + 1);
        continue;
      }
      flatten(pair.value as YamlNode | null, prefix ? `${prefix}.${key}` : key, out, ref, doc, depth + 1);
    }
    out.push(...merged.filter((m) => !out.some((e) => e.key === m.key)));
    return;
  }
  if (isSeq(node)) {
    node.items.forEach((item, i) => flatten(item as YamlNode | null, `${prefix}[${i}]`, out, ref, doc, depth + 1));
    return;
  }
  if (isScalar(node)) {
    const offset = node.range?.[0] ?? 0;
    out.push({ key: prefix, value: node.value === null ? "" : String(node.value), at: ref(offset) });
  }
}

export function parseYamlConfig(text: string, rootId: string, file: string): ConfigDocument[] {
  const lineCounter = new LineCounter();
  const docs = parseAllDocuments(text, { lineCounter, uniqueKeys: false });
  const ref = (offset: number): SourceRef => ({ rootId, file, line: lineCounter.linePos(offset).line });
  const out: ConfigDocument[] = [];
  for (const doc of docs) {
    if (!("contents" in doc)) continue;
    const entries: ConfigEntry[] = [];
    flatten(doc.contents as YamlNode | null, "", entries, ref, doc);
    const document: ConfigDocument = { entries };
    const onProfile = entries.find((e) => e.key === "spring.config.activate.on-profile" || e.key === "spring.profiles");
    if (onProfile && out.length > 0) document.profiles = onProfile.value.split(/[,|]/).map((p) => p.trim().replace(/^!/, ""));
    out.push(document);
  }
  return out;
}

/** Java .properties: `key=value`, `key: value`, `key value`, `\` continuation, `#`/`!` comments. */
export function parsePropertiesConfig(text: string, rootId: string, file: string): ConfigDocument {
  const entries: ConfigEntry[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const startLine = i + 1;
    let logical = (lines[i] ?? "").replace(/^\s+/, "");
    if (!logical || logical.startsWith("#") || logical.startsWith("!")) continue;
    while (/(^|[^\\])(\\\\)*\\$/.test(logical) && i + 1 < lines.length) {
      logical = logical.slice(0, -1) + (lines[++i] ?? "").replace(/^\s+/, "");
    }
    const match = /^((?:\\.|[^=:\s])+)\s*[=:\s]\s*(.*)$/.exec(logical);
    const key = (match ? match[1] : logical) ?? "";
    entries.push({ key: key.replace(/\\(.)/g, "$1"), value: match?.[2] ?? "", at: { rootId, file, line: startLine } });
  }
  return { entries };
}

/** `.env` files (Vite / Vue CLI): `KEY = 'value'` with optional quotes and `#` comments. */
export function parseDotEnv(text: string, rootId: string, file: string): ConfigDocument {
  const entries: ConfigEntry[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const match = /^(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/.exec(line);
    if (!match) return;
    let value = (match[2] ?? "").trim();
    const quote = value[0];
    if ((quote === "'" || quote === '"') && value.endsWith(quote) && value.length >= 2) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    entries.push({ key: match[1] ?? "", value, at: { rootId, file, line: i + 1 } });
  });
  return { entries };
}

export interface NacosConfigRow {
  dataId: string;
  group: string;
  tenant: string;
  content: string;
  /** Line of the row in the dump. */
  line: number;
}

/**
 * Nacos `config_info` rows from a SQL dump (`INSERT INTO config_info(cols) VALUES (...), (...)`).
 * Handles MySQL string escapes (`\n`, `\'`, `''`) inside values.
 */
export function parseNacosSqlDump(sql: string): NacosConfigRow[] {
  const rows: NacosConfigRow[] = [];
  const insert = /insert\s+into\s+`?config_info`?\s*\(([^)]*)\)\s*values\s*/gi;
  for (let m = insert.exec(sql); m; m = insert.exec(sql)) {
    const columns = (m[1] ?? "").split(",").map((c) => c.trim().replace(/`/g, "").toLowerCase());
    let pos = insert.lastIndex;
    for (;;) {
      while (pos < sql.length && /\s/.test(sql[pos] ?? "")) pos++;
      if (sql[pos] !== "(") break;
      const rowLine = sql.slice(0, pos).split("\n").length;
      const { values, end } = parseTuple(sql, pos + 1);
      pos = end;
      const get = (name: string): string => values[columns.indexOf(name)] ?? "";
      rows.push({ dataId: get("data_id"), group: get("group_id"), tenant: get("tenant_id"), content: get("content"), line: rowLine });
      while (pos < sql.length && /\s/.test(sql[pos] ?? "")) pos++;
      if (sql[pos] === ",") {
        pos++;
        continue;
      }
      break;
    }
    insert.lastIndex = pos;
  }
  return rows;
}

function parseTuple(sql: string, start: number): { values: string[]; end: number } {
  const values: string[] = [];
  let pos = start;
  for (;;) {
    while (/\s/.test(sql[pos] ?? "")) pos++;
    if (sql[pos] === "'") {
      let value = "";
      pos++;
      while (pos < sql.length) {
        const ch = sql[pos] as string;
        if (ch === "\\") {
          const next = sql[pos + 1] ?? "";
          value += next === "n" ? "\n" : next === "r" ? "\r" : next === "t" ? "\t" : next === "0" ? "\0" : next;
          pos += 2;
        } else if (ch === "'" && sql[pos + 1] === "'") {
          value += "'";
          pos += 2;
        } else if (ch === "'") {
          pos++;
          break;
        } else {
          value += ch;
          pos++;
        }
      }
      values.push(value);
    } else {
      const end = sql.slice(pos).search(/[,)]/);
      values.push(sql.slice(pos, end < 0 ? undefined : pos + end).trim());
      pos = end < 0 ? sql.length : pos + end;
    }
    while (/\s/.test(sql[pos] ?? "")) pos++;
    if (sql[pos] === ",") {
      pos++;
      continue;
    }
    if (sql[pos] === ")") pos++;
    return { values, end: pos };
  }
}
