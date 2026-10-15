/** Value of a Java string literal given as source text (`"a\"b"` → `a"b`), else undefined. */
export function javaStringLiteralText(text: string): string | undefined {
  const t = text.trim();
  if (t.length < 2 || !t.startsWith('"') || !t.endsWith('"') || t.startsWith('"""')) return undefined;
  const body = t.slice(1, -1);
  // Reject `"a" + "b"` (two literals): an unescaped quote inside means it is not one literal.
  if (/(^|[^\\])"/.test(body)) return undefined;
  return body.replace(/\\(.)/g, (_m, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
}

/** Split `{"a", "b"}` / `"a"` / `{A.B, "c"}` annotation-array text into element expressions. */
export function splitArrayElements(text: string): string[] {
  const t = text.trim();
  const inner = t.startsWith("{") && t.endsWith("}") ? t.slice(1, -1) : t;
  const out: string[] = [];
  let depth = 0;
  let inString = false;
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i] as string;
    if (ch === '"' && inner[i - 1] !== "\\") inString = !inString;
    if (!inString) {
      if (ch === "(" || ch === "{") depth++;
      else if (ch === ")" || ch === "}") depth--;
      else if (ch === "," && depth === 0) {
        out.push(current.trim());
        current = "";
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}
