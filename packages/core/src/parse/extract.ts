import { extractJavaFacts } from "../facts/java.js";
import { extractScriptFacts, extractSfcScript } from "../facts/script.js";
import type { FileFacts } from "../facts/types.js";
import type { ParserSet } from "./treesitter.js";

export type ParsedKind = "java" | "javascript" | "typescript" | "vue";

/**
 * Parse one file into facts. Trees are deleted immediately: the WASM heap is
 * capped at 4 GB and leaked trees are the classic way to hit it.
 */
export function extractFacts(set: ParserSet, kind: ParsedKind, text: string, relPath: string): FileFacts | undefined {
  let source = text;
  let grammar: keyof ParserSet["languages"];
  let lang: "javascript" | "typescript" | "vue" | "java";
  switch (kind) {
    case "java":
      grammar = "java";
      lang = "java";
      break;
    case "javascript":
      grammar = "javascript";
      lang = "javascript";
      break;
    case "typescript":
      grammar = relPath.endsWith(".tsx") ? "tsx" : "typescript";
      lang = "typescript";
      break;
    case "vue": {
      const script = extractSfcScript(text);
      if (!script) return { lang: "vue", imports: [], functions: [], variables: [], calls: [], hasErrors: false };
      source = script.content;
      grammar = script.lang;
      lang = "vue";
      break;
    }
  }
  set.parser.setLanguage(set.languages[grammar]);
  const tree = set.parser.parse(source);
  if (!tree) return undefined;
  try {
    return lang === "java" ? extractJavaFacts(tree) : extractScriptFacts(tree, lang);
  } finally {
    tree.delete();
  }
}
