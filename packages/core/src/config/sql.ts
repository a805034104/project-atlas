/**
 * Minimal SQL dump reader: `CREATE TABLE t (cols…)` + `INSERT INTO t [(cols)] VALUES (…), (…);`
 * → rows keyed by column name. Enough for Nacos `config_info` and RuoYi `sys_menu`.
 * Non-literal values (`sysdate()`, `null`) come back as their raw text.
 */

export interface SqlRow {
  values: Record<string, string>;
  /** 1-based line where the tuple starts. */
  line: number;
}

function createColumns(sql: string, table: string): string[] | undefined {
  const re = new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?\`?${table}\`?\\s*\\(`, "i");
  const m = re.exec(sql);
  if (!m) return undefined;
  const columns: string[] = [];
  let depth = 1;
  let i = m.index + m[0].length;
  let lineStart = i;
  for (; i < sql.length && depth > 0; i++) {
    const ch = sql[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if ((ch === "," && depth === 1) || depth === 0) {
      const def = sql.slice(lineStart, i).trim();
      const col = /^`?(\w+)`?\s+\w/.exec(def)?.[1];
      if (col && !/^(primary|unique|key|index|constraint|foreign|fulltext)$/i.test(col)) columns.push(col.toLowerCase());
      lineStart = i + 1;
    }
  }
  return columns;
}

export function parseSqlTuple(sql: string, start: number): { values: string[]; end: number } {
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
      let depth = 0;
      const begin = pos;
      while (pos < sql.length) {
        const ch = sql[pos];
        if (ch === "(") depth++;
        else if (ch === ")" && depth === 0) break;
        else if (ch === ")") depth--;
        else if (ch === "," && depth === 0) break;
        pos++;
      }
      values.push(sql.slice(begin, pos).trim());
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

export function parseSqlInserts(sql: string, table: string): SqlRow[] {
  const rows: SqlRow[] = [];
  const declared = createColumns(sql, table);
  const insert = new RegExp(`insert\\s+into\\s+\`?${table}\`?\\s*(?:\\(([^)]*)\\))?\\s*values\\s*`, "gi");
  const lineAt = (() => {
    const starts: number[] = [0];
    for (let i = 0; i < sql.length; i++) if (sql[i] === "\n") starts.push(i + 1);
    return (offset: number): number => {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((starts[mid] as number) <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    };
  })();
  for (let m = insert.exec(sql); m; m = insert.exec(sql)) {
    const columns = m[1] ? m[1].split(",").map((c) => c.trim().replace(/`/g, "").toLowerCase()) : declared;
    if (!columns) continue;
    let pos = insert.lastIndex;
    for (;;) {
      while (/\s/.test(sql[pos] ?? "")) pos++;
      if (sql[pos] !== "(") break;
      const line = lineAt(pos);
      const { values, end } = parseSqlTuple(sql, pos + 1);
      pos = end;
      rows.push({ values: Object.fromEntries(columns.map((c, i) => [c, values[i] ?? ""])), line });
      while (/\s/.test(sql[pos] ?? "")) pos++;
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
