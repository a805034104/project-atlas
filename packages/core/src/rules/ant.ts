/**
 * Path pattern matching used by Spring MVC interceptors (Ant style), servlet
 * filter url-patterns, and gateway Path predicates.
 *
 *   ant:     /system/**   /user/*   /a/?b   /x/{id}
 *   servlet: /*   /api/*   *.do   /exact
 *
 * Paths are normalized (see normalizeHttpPath), so `{}` marks a path variable;
 * it matches `*`, `**` and `{var}` but never a literal segment.
 */

function segmentMatches(pattern: string, segment: string): boolean {
  if (pattern === "*" || /^\{[^}]*\}$/.test(pattern)) return true;
  if (segment === "{}") return false;
  if (!pattern.includes("*") && !pattern.includes("?")) return pattern === segment;
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  return re.test(segment);
}

function split(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

export function antMatch(pattern: string, path: string): boolean {
  const p = split(pattern);
  const s = split(path);
  const memo = new Map<string, boolean>();
  const match = (i: number, j: number): boolean => {
    const key = `${i}:${j}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (i === p.length) result = j === s.length;
    else if (p[i] === "**") result = match(i + 1, j) || (j < s.length && match(i, j + 1));
    else result = j < s.length && segmentMatches(p[i] as string, s[j] as string) && match(i + 1, j + 1);
    memo.set(key, result);
    return result;
  };
  return match(0, 0);
}

export function servletPatternMatch(pattern: string, path: string): boolean {
  const p = pattern.trim();
  if (p === "/*" || p === "/" || p === "/**") return true;
  if (p.startsWith("*.")) return path.endsWith(p.slice(1));
  if (p.endsWith("/*")) {
    const prefix = p.slice(0, -2);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  return p === path;
}
