/**
 * Facts: the serializable, per-file output of the parse workers.
 *
 *   file bytes ─(worker: tree-sitter)─▶ *FileFacts ─(main: RuleSets)─▶ AtlasGraph
 *
 * Facts never hold tree-sitter nodes, so they cross worker boundaries and are
 * cached by content hash + analyzer version.
 */

// ── Java ─────────────────────────────────────────────────────────────────────

export type AnnotationValue =
  | { kind: "string"; value: string }
  | { kind: "strings"; values: string[] }
  /** Anything that is not a literal: constants, enums (`RequestMethod.GET`), concatenations. */
  | { kind: "expr"; text: string };

export interface JavaAnnotation {
  /** Simple name without `@` and package, e.g. `GetMapping`. */
  name: string;
  /** Positional single value is stored under `value`. */
  args: Record<string, AnnotationValue>;
  line: number;
}

export interface JavaParam {
  name: string;
  type: string;
  annotations: JavaAnnotation[];
}

export interface JavaCall {
  /** Receiver expression text (`userService`, `this.mapper`, `SecurityUtils`), absent for unqualified calls. */
  receiver?: string;
  method: string;
  argCount: number;
  /** String literal value per argument, null when not a literal. */
  argLiterals: (string | null)[];
  /** Raw argument text per argument (trimmed, capped at 200 chars). */
  argTexts: string[];
  line: number;
}

export interface JavaField {
  name: string;
  type: string;
  modifiers: string[];
  annotations: JavaAnnotation[];
  /** String literal initializer, for constants such as topic names. */
  stringValue?: string;
  line: number;
}

export interface JavaMethod {
  name: string;
  returnType: string;
  params: JavaParam[];
  modifiers: string[];
  annotations: JavaAnnotation[];
  isConstructor: boolean;
  /** Local variable declarations: name → declared type text. */
  locals: Record<string, string>;
  calls: JavaCall[];
  line: number;
  endLine: number;
}

export interface JavaType {
  kind: "class" | "interface" | "enum" | "record" | "annotation";
  /** Simple name; nested types use `Outer.Inner`. */
  name: string;
  fqcn: string;
  modifiers: string[];
  annotations: JavaAnnotation[];
  superclass?: string;
  interfaces: string[];
  fields: JavaField[];
  methods: JavaMethod[];
  line: number;
}

export interface JavaFileFacts {
  lang: "java";
  package: string;
  /** Single-type imports: simple name → fully qualified name. */
  imports: Record<string, string>;
  wildcardImports: string[];
  types: JavaType[];
  hasErrors: boolean;
}

// ── JavaScript / TypeScript / Vue ────────────────────────────────────────────

export type ScriptValue =
  | { kind: "string"; value: string }
  /** Template literal; `${expr}` placeholders kept verbatim. */
  | { kind: "template"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "identifier"; name: string }
  | { kind: "member"; text: string }
  | { kind: "object"; props: Record<string, ScriptValue> }
  | { kind: "array"; items: ScriptValue[] }
  /** `() => import('@/views/x')` or `import('...')`. */
  | { kind: "dynamic-import"; source: string }
  /** `resolve => require(['@/views/x'], resolve)` (Vue 2 style lazy component). */
  | { kind: "require"; source: string }
  /** Functions keep the value they return when it is a literal (e.g. `defineConfig(({ mode }) => ({ ... }))`). */
  | { kind: "function"; text: string; returns?: ScriptValue }
  | { kind: "call"; callee: string; args: ScriptValue[] }
  | { kind: "expr"; text: string };

export interface ScriptImport {
  source: string;
  default?: string;
  namespace?: string;
  named: { imported: string; local: string }[];
  line: number;
}

export interface ScriptCall {
  /** Callee text, e.g. `request`, `axios.get`, `service.post`, `this.$http.get`. */
  callee: string;
  args: ScriptValue[];
  line: number;
}

export interface ScriptFunction {
  name: string;
  exported: boolean;
  params: string[];
  calls: ScriptCall[];
  line: number;
}

export interface ScriptVariable {
  name: string;
  exported: boolean;
  value: ScriptValue;
  line: number;
}

export interface ScriptFileFacts {
  lang: "javascript" | "typescript" | "vue";
  imports: ScriptImport[];
  functions: ScriptFunction[];
  variables: ScriptVariable[];
  /** `export default` value (Vue options object, config objects, etc.). */
  defaultExport?: ScriptValue;
  /** Calls not inside a named function (module level, Vue methods, arrow callbacks). */
  calls: ScriptCall[];
  hasErrors: boolean;
}

export type FileFacts = JavaFileFacts | ScriptFileFacts;
