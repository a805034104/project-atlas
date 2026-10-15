import type { SourceRef } from "../model/types.js";
import type { LoadedFile } from "../workspace/load.js";

/**
 * MyBatis mapper XML index: `namespace.statementId` → location.
 * A regex scan is enough here (we need ids and lines, not the SQL AST), and it
 * survives the malformed / DOCTYPE-heavy XML common in generated mappers.
 */

export interface MapperStatement {
  namespace: string;
  id: string;
  kind: "select" | "insert" | "update" | "delete";
  at: SourceRef;
}

export function indexMapperXml(files: readonly LoadedFile[]): Map<string, MapperStatement> {
  const index = new Map<string, MapperStatement>();
  for (const file of files) {
    if ((file.kind !== "mybatis-xml" && file.kind !== "xml") || !file.text?.includes("<mapper")) continue;
    const text = file.text;
    const ns = /<mapper\b[^>]*\bnamespace\s*=\s*"([^"]+)"/.exec(text)?.[1];
    if (!ns) continue;
    const lineStarts: number[] = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
    const lineOf = (offset: number): number => {
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((lineStarts[mid] as number) <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    };
    const re = /<(select|insert|update|delete)\b[^>]*?\bid\s*=\s*"([^"]+)"/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const kind = m[1] as MapperStatement["kind"];
      const id = m[2] as string;
      index.set(`${ns}.${id}`, { namespace: ns, id, kind, at: { rootId: file.rootId, file: file.relPath, line: lineOf(m.index) } });
    }
  }
  return index;
}

export function mapperNamespaces(index: Map<string, MapperStatement>): Set<string> {
  return new Set([...index.values()].map((s) => s.namespace));
}
