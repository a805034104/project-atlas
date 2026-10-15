/**
 * File classification. The kind decides which extractor runs on a file and
 * whether it may ever be sent to an LLM.
 */

export type FileKind =
  | "java"
  | "javascript"
  | "typescript"
  | "vue"
  | "mybatis-xml"
  | "xml"
  | "maven-pom"
  | "gradle"
  | "npm-manifest"
  | "yaml"
  | "properties"
  | "env"
  | "dockerfile"
  | "compose"
  | "nginx"
  | "shell"
  | "sql"
  | "markdown"
  | "other";

const BY_EXTENSION: Record<string, FileKind> = {
  ".java": "java",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescript",
  ".vue": "vue",
  ".xml": "xml",
  ".gradle": "gradle",
  ".kts": "gradle",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".properties": "properties",
  ".conf": "nginx",
  ".sh": "shell",
  ".bat": "shell",
  ".cmd": "shell",
  ".sql": "sql",
  ".md": "markdown",
};

export function classifyFile(relPath: string): FileKind {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  const lower = base.toLowerCase();
  if (lower === "pom.xml") return "maven-pom";
  if (lower === "package.json") return "npm-manifest";
  if (lower === "dockerfile" || lower.endsWith(".dockerfile")) return "dockerfile";
  if (/^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(lower)) return "compose";
  if (lower === ".env" || lower.startsWith(".env.")) return "env";
  if (lower === "nginx.conf") return "nginx";
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return "other";
  const kind = BY_EXTENSION[lower.slice(dot)] ?? "other";
  if (kind === "xml" && /mapper/i.test(relPath)) return "mybatis-xml";
  if (kind === "gradle" && !lower.startsWith("build.gradle") && !lower.startsWith("settings.gradle")) return "other";
  return kind;
}

/** Kinds that the tree-sitter worker pool parses into facts. */
export function isParsedKind(kind: FileKind): kind is "java" | "javascript" | "typescript" | "vue" {
  return kind === "java" || kind === "javascript" || kind === "typescript" || kind === "vue";
}
