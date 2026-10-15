import type { Node, Tree } from "web-tree-sitter";
import type {
  AnnotationValue,
  JavaAnnotation,
  JavaCall,
  JavaCreation,
  JavaField,
  JavaFileFacts,
  JavaMethod,
  JavaParam,
  JavaType,
} from "./types.js";

/**
 * tree-sitter-java syntax tree → JavaFileFacts.
 *
 * Only declarations and call sites are extracted; expressions are kept as text.
 * Calls inside lambdas and anonymous classes are attributed to the enclosing
 * method (the flow builder only needs "who calls whom").
 */

const TYPE_DECLARATIONS: Record<string, JavaType["kind"]> = {
  class_declaration: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
  record_declaration: "record",
  annotation_type_declaration: "annotation",
};

const MAX_ARG_TEXT = 200;

function line(node: Node): number {
  return node.startPosition.row + 1;
}

/** Strip generics and array suffixes: `List<SysUser>[]` → `List`. */
export function rawTypeName(typeText: string): string {
  const lt = typeText.indexOf("<");
  const base = (lt >= 0 ? typeText.slice(0, lt) : typeText).replace(/\[\]/g, "").trim();
  return base;
}

export function javaStringLiteral(node: Node): string | null {
  if (node.type === "string_literal") {
    const text = node.text;
    if (text.startsWith('"""')) return text.slice(3, -3).replace(/^\n/, "");
    return unescapeJava(text.slice(1, -1));
  }
  if (node.type === "parenthesized_expression") {
    const inner = node.namedChildren[0];
    return inner ? javaStringLiteral(inner) : null;
  }
  if (node.type === "binary_expression" && node.childForFieldName("operator")?.text === "+") {
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    const l = left ? javaStringLiteral(left) : null;
    const r = right ? javaStringLiteral(right) : null;
    return l !== null && r !== null ? l + r : null;
  }
  return null;
}

function unescapeJava(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_m, esc: string) => {
    if (esc.startsWith("u") && esc.length === 5) return String.fromCharCode(parseInt(esc.slice(1), 16));
    switch (esc) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      default:
        return esc;
    }
  });
}

function annotationValue(node: Node): AnnotationValue {
  if (node.type === "element_value_array_initializer") {
    const values: string[] = [];
    for (const child of node.namedChildren) {
      const s = javaStringLiteral(child);
      if (s === null) return { kind: "expr", text: node.text };
      values.push(s);
    }
    return { kind: "strings", values };
  }
  const s = javaStringLiteral(node);
  return s !== null ? { kind: "string", value: s } : { kind: "expr", text: node.text };
}

function simpleName(qualified: string): string {
  const dot = qualified.lastIndexOf(".");
  return dot >= 0 ? qualified.slice(dot + 1) : qualified;
}

function annotation(node: Node): JavaAnnotation {
  const name = simpleName(node.childForFieldName("name")?.text ?? "");
  const args: Record<string, AnnotationValue> = {};
  const list = node.childForFieldName("arguments");
  if (list) {
    for (const child of list.namedChildren) {
      if (child.type === "element_value_pair") {
        const key = child.childForFieldName("key")?.text;
        const value = child.childForFieldName("value");
        if (key && value) args[key] = annotationValue(value);
      } else if (child.type !== "comment") {
        args["value"] = annotationValue(child);
      }
    }
  }
  return { name, args, line: line(node) };
}

function modifiersOf(node: Node): { modifiers: string[]; annotations: JavaAnnotation[] } {
  const modifiers: string[] = [];
  const annotations: JavaAnnotation[] = [];
  const mods = node.namedChildren.find((c) => c.type === "modifiers");
  if (mods) {
    for (const child of mods.children) {
      if (child.type === "annotation" || child.type === "marker_annotation") annotations.push(annotation(child));
      else if (child.type !== "comment" && child.type !== "line_comment" && child.type !== "block_comment") {
        modifiers.push(child.text);
      }
    }
  }
  return { modifiers, annotations };
}

function params(node: Node | null): JavaParam[] {
  if (!node) return [];
  const out: JavaParam[] = [];
  for (const child of node.namedChildren) {
    if (child.type !== "formal_parameter" && child.type !== "spread_parameter") continue;
    const { annotations } = modifiersOf(child);
    const typeNode = child.childForFieldName("type") ?? child.namedChildren.find((c) => c.type.endsWith("_type") || c.type === "type_identifier");
    let name = child.childForFieldName("name")?.text;
    if (!name) {
      const declarator = child.namedChildren.find((c) => c.type === "variable_declarator");
      name = declarator?.childForFieldName("name")?.text ?? declarator?.text ?? "";
    }
    const type = (typeNode?.text ?? "") + (child.type === "spread_parameter" ? "..." : "");
    out.push({ name, type, annotations });
  }
  return out;
}

function argumentsOf(argsNode: Node | null): { argLiterals: (string | null)[]; argTexts: string[] } {
  const argNodes = argsNode ? argsNode.namedChildren.filter((c) => !c.type.includes("comment")) : [];
  return { argLiterals: argNodes.map((a) => javaStringLiteral(a)), argTexts: argNodes.map((a) => a.text.slice(0, MAX_ARG_TEXT)) };
}

function collectBody(body: Node | null): { calls: JavaCall[]; locals: Record<string, string>; creations: JavaCreation[] } {
  const calls: JavaCall[] = [];
  const locals: Record<string, string> = {};
  const creations: JavaCreation[] = [];
  if (!body) return { calls, locals, creations };
  for (const created of body.descendantsOfType("object_creation_expression")) {
    const type = created.childForFieldName("type")?.text;
    if (type) creations.push({ type, ...argumentsOf(created.childForFieldName("arguments")), line: line(created) });
  }
  creations.sort((a, b) => a.line - b.line);
  for (const decl of body.descendantsOfType("local_variable_declaration")) {
    const type = decl.childForFieldName("type")?.text;
    if (!type) continue;
    for (const declarator of decl.childrenForFieldName("declarator")) {
      const name = declarator.childForFieldName("name")?.text;
      if (name && type !== "var") locals[name] = type;
      if (name && type === "var") {
        const value = declarator.childForFieldName("value");
        if (value?.type === "object_creation_expression") {
          const created = value.childForFieldName("type")?.text;
          if (created) locals[name] = created;
        }
      }
    }
  }
  for (const resource of body.descendantsOfType("resource")) {
    const type = resource.childForFieldName("type")?.text;
    const name = resource.childForFieldName("name")?.text;
    if (type && name) locals[name] = type;
  }
  for (const call of body.descendantsOfType("method_invocation")) {
    const method = call.childForFieldName("name")?.text;
    if (!method) continue;
    const receiverNode = call.childForFieldName("object");
    const argsNode = call.childForFieldName("arguments");
    const argNodes = argsNode ? argsNode.namedChildren.filter((c) => !c.type.includes("comment")) : [];
    const entry: JavaCall = {
      method,
      argCount: argNodes.length,
      argLiterals: argNodes.map((a) => javaStringLiteral(a)),
      argTexts: argNodes.map((a) => a.text.slice(0, MAX_ARG_TEXT)),
      line: line(call),
    };
    if (receiverNode) entry.receiver = receiverNode.text.replace(/\s+/g, "");
    calls.push(entry);
  }
  calls.sort((a, b) => a.line - b.line);
  return { calls, locals, creations };
}

function method(node: Node, isConstructor: boolean): JavaMethod {
  const { modifiers, annotations } = modifiersOf(node);
  const body = node.childForFieldName("body");
  const { calls, locals, creations } = collectBody(body);
  return {
    name: node.childForFieldName("name")?.text ?? "<init>",
    returnType: isConstructor ? "" : (node.childForFieldName("type")?.text ?? "void"),
    params: params(node.childForFieldName("parameters")),
    modifiers,
    annotations,
    creations,
    isConstructor,
    locals,
    calls,
    line: line(node),
    endLine: node.endPosition.row + 1,
  };
}

function fields(node: Node): JavaField[] {
  const { modifiers, annotations } = modifiersOf(node);
  const type = node.childForFieldName("type")?.text ?? "";
  const out: JavaField[] = [];
  for (const declarator of node.childrenForFieldName("declarator")) {
    const name = declarator.childForFieldName("name")?.text;
    if (!name) continue;
    const field: JavaField = { name, type, modifiers, annotations, line: line(declarator) };
    const value = declarator.childForFieldName("value");
    const literal = value ? javaStringLiteral(value) : null;
    if (literal !== null) field.stringValue = literal;
    out.push(field);
  }
  return out;
}

function typeList(node: Node | null | undefined): string[] {
  if (!node) return [];
  const list = node.namedChildren.find((c) => c.type === "type_list") ?? node;
  return list.namedChildren.filter((c) => !c.type.includes("comment")).map((c) => c.text);
}

function collectTypes(node: Node, pkg: string, outerName: string | undefined, out: JavaType[]): void {
  const kind = TYPE_DECLARATIONS[node.type];
  if (!kind) return;
  const simple = node.childForFieldName("name")?.text ?? "";
  const name = outerName ? `${outerName}.${simple}` : simple;
  const { modifiers, annotations } = modifiersOf(node);
  const type: JavaType = {
    kind,
    name,
    fqcn: pkg ? `${pkg}.${name}` : name,
    modifiers,
    annotations,
    interfaces: [],
    fields: [],
    methods: [],
    enumConstants: [],
    line: line(node),
  };
  const superclass = node.childForFieldName("superclass");
  if (superclass) {
    const t = superclass.namedChildren[0];
    if (t) type.superclass = t.text;
  }
  type.interfaces = typeList(
    node.childForFieldName("interfaces") ?? node.namedChildren.find((c) => c.type === "extends_interfaces"),
  );
  if (kind === "record") {
    for (const p of params(node.childForFieldName("parameters"))) {
      type.fields.push({ name: p.name, type: p.type, modifiers: ["private", "final"], annotations: p.annotations, line: type.line });
    }
  }

  const body = node.childForFieldName("body");
  const members = body
    ? body.namedChildren.flatMap((c) => (c.type === "enum_body_declarations" ? c.namedChildren : [c]))
    : [];
  for (const member of members) {
    switch (member.type) {
      case "field_declaration":
      case "constant_declaration":
        type.fields.push(...fields(member));
        break;
      case "method_declaration":
      case "annotation_type_element_declaration":
        type.methods.push(method(member, false));
        break;
      case "constructor_declaration":
      case "compact_constructor_declaration":
        type.methods.push(method(member, true));
        break;
      case "enum_constant":
        type.enumConstants.push({ name: member.childForFieldName("name")?.text ?? "", ...argumentsOf(member.childForFieldName("arguments")), line: line(member) });
        break;
      default:
        if (TYPE_DECLARATIONS[member.type]) collectTypes(member, pkg, name, out);
    }
  }
  out.push(type);
}

export function extractJavaFacts(tree: Tree): JavaFileFacts {
  const root = tree.rootNode;
  let pkg = "";
  const imports: Record<string, string> = {};
  const wildcardImports: string[] = [];
  const types: JavaType[] = [];

  for (const child of root.namedChildren) {
    if (child.type === "package_declaration") {
      pkg = child.namedChildren.find((c) => c.type !== "annotation" && c.type !== "marker_annotation")?.text ?? "";
    } else if (child.type === "import_declaration") {
      const text = child.text.replace(/^import\s+/, "").replace(/;\s*$/, "").replace(/\s+/g, "");
      const isStatic = text.startsWith("static");
      const target = isStatic ? text.slice("static".length) : text;
      if (target.endsWith(".*")) {
        if (!isStatic) wildcardImports.push(target.slice(0, -2));
      } else if (!isStatic) {
        imports[simpleName(target)] = target;
      }
    } else if (TYPE_DECLARATIONS[child.type]) {
      collectTypes(child, pkg, undefined, types);
    }
  }
  types.sort((a, b) => a.line - b.line);
  return { lang: "java", package: pkg, imports, wildcardImports, types, hasErrors: root.hasError };
}
