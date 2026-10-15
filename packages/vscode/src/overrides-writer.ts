import { parseDocument, YAMLSeq, isMap, isSeq } from "yaml";

/**
 * "标记为错误" → `.atlas/overrides.yaml` `edges.remove` entry, preserving any
 * comments and existing entries in the file. Pure string → string.
 */
export function addEdgeRemoval(existing: string | undefined, from: string, to: string, note?: string): string {
  const doc = parseDocument(existing && existing.trim() ? existing : "version: 1\n");
  if (!doc.has("version")) doc.set("version", 1);
  let edges = doc.get("edges");
  if (!isMap(edges)) {
    doc.set("edges", doc.createNode({ remove: [] }));
    edges = doc.get("edges");
  }
  if (!isMap(edges)) throw new Error("edges must be a mapping");
  let remove = edges.get("remove");
  if (!isSeq(remove)) {
    remove = new YAMLSeq();
    edges.set("remove", remove);
  }
  const seq = remove as YAMLSeq;
  const duplicate = seq.items.some((item) => {
    const js = (item as { toJSON?: () => unknown }).toJSON?.() as { from?: string; to?: string } | undefined;
    return js?.from === from && js?.to === to;
  });
  if (!duplicate) seq.add(doc.createNode(note ? { from, to, note } : { from, to }));
  return doc.toString();
}
