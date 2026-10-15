import type { Node, Tree } from "web-tree-sitter";
import type {
  ScriptCall,
  ScriptFileFacts,
  ScriptFunction,
  ScriptImport,
  ScriptValue,
  ScriptVariable,
} from "./types.js";

/**
 * tree-sitter-javascript / typescript tree → ScriptFileFacts.
 *
 * Captures what the Vue rules need: imports, exported request helpers
 * (`export function listUser(q) { return request({ url, method }) }`), route
 * tables (`const constantRoutes = [...]`), the default export (Vue options or
 * config objects such as vue.config.js / vite.config.ts) and all call sites.
 */

const MAX_DEPTH = 12;
const MAX_TEXT = 200;

function line(node: Node): number {
  return node.startPosition.row + 1;
}

function stringValue(node: Node): string {
  return node.namedChildren
    .map((c) => (c.type === "escape_sequence" ? unescapeJs(c.text) : c.text))
    .join("");
}

function unescapeJs(seq: string): string {
  switch (seq) {
    case "\\n":
      return "\n";
    case "\\t":
      return "\t";
    default:
      return seq.slice(1);
  }
}

function propertyKey(node: Node): string | undefined {
  if (node.type === "property_identifier" || node.type === "identifier") return node.text;
  if (node.type === "string") return stringValue(node);
  if (node.type === "number") return node.text;
  // `[process.env.VUE_APP_BASE_API]` / `['^' + x]`: keep the expression text in brackets for the resolvers.
  if (node.type === "computed_property_name") return `[${node.namedChildren[0]?.text.replace(/\s+/g, "") ?? ""}]`;
  return undefined;
}

export function scriptValue(node: Node, depth = 0): ScriptValue {
  if (depth > MAX_DEPTH) return { kind: "expr", text: node.text.slice(0, MAX_TEXT) };
  switch (node.type) {
    case "string":
      return { kind: "string", value: stringValue(node) };
    case "template_string": {
      const text = node.text.slice(1, -1);
      return text.includes("${") ? { kind: "template", value: text } : { kind: "string", value: text };
    }
    case "number":
      return { kind: "number", value: Number(node.text) };
    case "true":
    case "false":
      return { kind: "boolean", value: node.type === "true" };
    case "identifier":
    case "shorthand_property_identifier":
      return { kind: "identifier", name: node.text };
    case "member_expression":
      return { kind: "member", text: node.text.replace(/\s+/g, "") };
    case "parenthesized_expression":
    case "as_expression":
    case "satisfies_expression":
    case "non_null_expression": {
      const inner = node.namedChildren[0];
      return inner ? scriptValue(inner, depth + 1) : { kind: "expr", text: node.text };
    }
    case "object": {
      const props: Record<string, ScriptValue> = {};
      for (const child of node.namedChildren) {
        if (child.type === "pair") {
          const keyNode = child.childForFieldName("key");
          const valueNode = child.childForFieldName("value");
          const key = keyNode ? propertyKey(keyNode) : undefined;
          if (key !== undefined && valueNode) props[key] = scriptValue(valueNode, depth + 1);
        } else if (child.type === "shorthand_property_identifier") {
          props[child.text] = { kind: "identifier", name: child.text };
        } else if (child.type === "method_definition") {
          const key = child.childForFieldName("name");
          if (key) props[key.text] = { kind: "function", text: key.text };
        }
      }
      return { kind: "object", props };
    }
    case "array":
      return { kind: "array", items: node.namedChildren.filter((c) => c.type !== "comment").map((c) => scriptValue(c, depth + 1)) };
    case "arrow_function":
    case "function_expression":
    case "function": {
      const body = node.childForFieldName("body");
      const lazy = body ? lazyComponent(body) : undefined;
      if (lazy) return lazy;
      const fn: ScriptValue = { kind: "function", text: node.text.slice(0, MAX_TEXT) };
      const returned = body ? returnedExpression(body) : undefined;
      if (returned) fn.returns = scriptValue(returned, depth + 1);
      return fn;
    }
    case "binary_expression": {
      const concat = concatenation(node);
      return concat ?? { kind: "expr", text: node.text.slice(0, MAX_TEXT) };
    }
    case "call_expression": {
      const lazy = lazyComponent(node);
      if (lazy) return lazy;
      const fn = node.childForFieldName("function");
      const args = node.childForFieldName("arguments");
      return {
        kind: "call",
        callee: fn?.text.replace(/\s+/g, "") ?? "",
        args: args ? args.namedChildren.filter((c) => c.type !== "comment").map((c) => scriptValue(c, depth + 1)) : [],
      };
    }
    default:
      return { kind: "expr", text: node.text.slice(0, MAX_TEXT) };
  }
}

/**
 * `'/system/user/' + parseStrEmpty(userId)` → template `/system/user/${parseStrEmpty(userId)}`.
 * Only produced when at least one operand is a string literal.
 */
function concatenation(node: Node): ScriptValue | undefined {
  const parts: string[] = [];
  let sawString = false;
  let dynamic = false;
  const walk = (n: Node): boolean => {
    if (n.type === "binary_expression" && n.childForFieldName("operator")?.text === "+") {
      const left = n.childForFieldName("left");
      const right = n.childForFieldName("right");
      return !!left && !!right && walk(left) && walk(right);
    }
    if (n.type === "string") {
      sawString = true;
      parts.push(stringValue(n));
      return true;
    }
    if (n.type === "template_string") {
      sawString = true;
      parts.push(n.text.slice(1, -1));
      dynamic ||= n.text.includes("${");
      return true;
    }
    if (n.type === "parenthesized_expression") {
      const inner = n.namedChildren[0];
      return inner ? walk(inner) : false;
    }
    dynamic = true;
    parts.push("${" + n.text.slice(0, 60) + "}");
    return true;
  };
  if (!walk(node) || !sawString) return undefined;
  const value = parts.join("");
  return dynamic ? { kind: "template", value } : { kind: "string", value };
}

/** Expression an arrow/function body evaluates to: `=> ({...})` or the last top-level `return x`. */
function returnedExpression(body: Node): Node | undefined {
  if (body.type !== "statement_block") return body;
  let found: Node | undefined;
  for (const statement of body.namedChildren) {
    if (statement.type === "return_statement") found = statement.namedChildren[0] ?? undefined;
  }
  return found;
}

/** `import('x')`, `() => import('x')`, `resolve => require(['x'], resolve)`. */
function lazyComponent(node: Node): ScriptValue | undefined {
  if (node.type === "call_expression") {
    const fn = node.childForFieldName("function");
    const first = node.childForFieldName("arguments")?.namedChildren[0];
    if (fn?.type === "import" && first?.type === "string") return { kind: "dynamic-import", source: stringValue(first) };
    if (fn?.text === "require" && first) {
      if (first.type === "string") return { kind: "require", source: stringValue(first) };
      const inner = first.type === "array" ? first.namedChildren[0] : undefined;
      if (inner?.type === "string") return { kind: "require", source: stringValue(inner) };
    }
  }
  return undefined;
}

function collectCalls(node: Node): ScriptCall[] {
  const calls: ScriptCall[] = [];
  for (const call of node.descendantsOfType("call_expression")) {
    const fn = call.childForFieldName("function");
    if (!fn || fn.type === "import") continue;
    const args = call.childForFieldName("arguments");
    calls.push({
      callee: fn.text.replace(/\s+/g, "").slice(0, MAX_TEXT),
      args: args ? args.namedChildren.filter((c) => c.type !== "comment").map((c) => scriptValue(c)) : [],
      line: line(call),
    });
  }
  return calls;
}

function paramNames(node: Node | null): string[] {
  if (!node) return [];
  return node.namedChildren
    .map((p) => (p.type === "required_parameter" || p.type === "optional_parameter" ? p.childForFieldName("pattern") : p))
    .filter((p): p is Node => p !== null)
    .map((p) => p.text);
}

function importOf(node: Node): ScriptImport | undefined {
  const source = node.childForFieldName("source");
  if (!source) return undefined;
  const result: ScriptImport = { source: stringValue(source), named: [], line: line(node) };
  const clause = node.namedChildren.find((c) => c.type === "import_clause");
  for (const part of clause?.namedChildren ?? []) {
    if (part.type === "identifier") result.default = part.text;
    else if (part.type === "namespace_import") {
      const id = part.namedChildren.find((c) => c.type === "identifier");
      if (id) result.namespace = id.text;
    } else if (part.type === "named_imports") {
      for (const spec of part.namedChildren) {
        if (spec.type !== "import_specifier") continue;
        const imported = spec.childForFieldName("name")?.text;
        if (!imported) continue;
        result.named.push({ imported, local: spec.childForFieldName("alias")?.text ?? imported });
      }
    }
  }
  return result;
}

export function extractScriptFacts(tree: Tree, lang: ScriptFileFacts["lang"]): ScriptFileFacts {
  const root = tree.rootNode;
  const imports: ScriptImport[] = [];
  const functions: ScriptFunction[] = [];
  const variables: ScriptVariable[] = [];
  const facts: ScriptFileFacts = { lang, imports, functions, variables, calls: [], hasErrors: root.hasError };

  const declare = (decl: Node, exported: boolean): void => {
    if (decl.type === "enum_declaration") {
      // `enum Api { list = '/sys/user/list' }` → variable Api = { list: '/sys/user/list' }
      const name = decl.childForFieldName("name")?.text;
      const body = decl.childForFieldName("body");
      if (!name || !body) return;
      const props: Record<string, ScriptValue> = {};
      for (const member of body.namedChildren) {
        if (member.type === "enum_assignment") {
          const key = member.childForFieldName("name");
          const value = member.childForFieldName("value");
          const k = key ? propertyKey(key) : undefined;
          if (k !== undefined && value) props[k] = scriptValue(value);
        } else if (member.type === "property_identifier") {
          props[member.text] = { kind: "string", value: member.text };
        }
      }
      variables.push({ name, exported, value: { kind: "object", props }, line: line(decl) });
      return;
    }
    if (decl.type === "function_declaration" || decl.type === "generator_function_declaration") {
      const name = decl.childForFieldName("name")?.text;
      if (!name) return;
      functions.push({ name, exported, params: paramNames(decl.childForFieldName("parameters")), calls: collectCalls(decl), line: line(decl) });
      return;
    }
    if (decl.type === "lexical_declaration" || decl.type === "variable_declaration") {
      for (const declarator of decl.namedChildren.filter((c) => c.type === "variable_declarator")) {
        const name = declarator.childForFieldName("name")?.text;
        const value = declarator.childForFieldName("value");
        if (!name || !value) continue;
        if (value.type === "arrow_function" || value.type === "function_expression" || value.type === "function") {
          const lazy = scriptValue(value);
          if (lazy.kind === "dynamic-import" || lazy.kind === "require") {
            variables.push({ name, exported, value: lazy, line: line(declarator) });
            continue;
          }
          functions.push({ name, exported, params: paramNames(value.childForFieldName("parameters")), calls: collectCalls(value), line: line(declarator) });
        } else {
          variables.push({ name, exported, value: scriptValue(value), line: line(declarator) });
        }
      }
    }
  };

  for (const child of root.namedChildren) {
    switch (child.type) {
      case "import_statement": {
        const imp = importOf(child);
        if (imp) imports.push(imp);
        break;
      }
      case "export_statement": {
        const decl = child.childForFieldName("declaration");
        if (decl) declare(decl, true);
        const value = child.childForFieldName("value");
        if (value && child.children.some((c) => c.type === "default")) facts.defaultExport = scriptValue(value);
        break;
      }
      case "expression_statement": {
        // CommonJS: module.exports = {...}
        const expr = child.namedChildren[0];
        if (expr?.type === "assignment_expression" && expr.childForFieldName("left")?.text === "module.exports") {
          const right = expr.childForFieldName("right");
          if (right) facts.defaultExport = scriptValue(right);
        }
        break;
      }
      default:
        declare(child, false);
    }
  }

  // Calls outside named functions: module level, Vue options methods, setup().
  const inFunction = new Set(functions.flatMap((f) => f.calls.map((c) => `${c.line}:${c.callee}`)));
  facts.calls = collectCalls(root).filter((c) => !inFunction.has(`${c.line}:${c.callee}`));
  return facts;
}

export interface SfcScript {
  content: string;
  lang: "javascript" | "typescript";
}

/**
 * Extract `<script>` / `<script setup>` blocks from a Vue SFC. Content is
 * padded with newlines so line numbers in facts match the .vue file.
 */
export function extractSfcScript(source: string): SfcScript | undefined {
  const blocks: { start: number; body: string; ts: boolean }[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const attrs = m[1] ?? "";
    if (/\bsrc\s*=/.test(attrs)) continue;
    blocks.push({ start: m.index + m[0].indexOf(">") + 1, body: m[2] ?? "", ts: /\blang\s*=\s*["']tsx?["']/.test(attrs) });
  }
  if (blocks.length === 0) return undefined;
  let content = "";
  let consumedLines = 0;
  for (const block of blocks) {
    const lineOfStart = source.slice(0, block.start).split("\n").length - 1;
    content += "\n".repeat(Math.max(0, lineOfStart - consumedLines)) + block.body;
    consumedLines = lineOfStart + block.body.split("\n").length - 1;
  }
  return { content, lang: blocks.some((b) => b.ts) ? "typescript" : "javascript" };
}
