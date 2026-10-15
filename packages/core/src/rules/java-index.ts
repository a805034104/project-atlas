import { javaStringLiteralText } from "./java-literals.js";
import type { JavaAnnotation, JavaFileFacts, JavaMethod, JavaType } from "../facts/types.js";
import { rawTypeName } from "../facts/java.js";
import type { LoadedFile } from "../workspace/load.js";

/**
 * Per-service Java symbol index.
 *
 *   facts (classpath files) ─▶ byFqcn / bySimpleName
 *        resolveType(text, ctx): imports → nested → same package → wildcard → unique simple name
 *        ancestors(t) / implementations(iface) / findMethods(t, name, argc)
 *        resolveConstant("ServiceNameConstants.SYSTEM_SERVICE") → "ruoyi-system"
 */

export interface TypeRef {
  type: JavaType;
  facts: JavaFileFacts;
  file: LoadedFile;
}

export interface MethodRef {
  owner: TypeRef;
  method: JavaMethod;
}

const BEAN_ANNOTATIONS = new Set(["Component", "Service", "Repository", "Controller", "RestController", "Configuration", "Mapper", "FeignClient"]);

export class JavaIndex {
  readonly types: TypeRef[] = [];
  private readonly byFqcn = new Map<string, TypeRef>();
  private readonly bySimple = new Map<string, TypeRef[]>();
  private readonly ancestorCache = new Map<TypeRef, TypeRef[]>();
  private implCache: Map<TypeRef, TypeRef[]> | undefined;
  private readonly supertypeNameCache = new Map<TypeRef, string[]>();
  private beansBySupertypeName: Map<string, TypeRef[]> | undefined;

  constructor(files: readonly LoadedFile[]) {
    for (const file of files) {
      const facts = file.facts;
      if (facts?.lang !== "java") continue;
      for (const type of facts.types) {
        const ref: TypeRef = { type, facts, file };
        if (this.byFqcn.has(type.fqcn)) continue; // duplicate class across modules: first wins
        this.byFqcn.set(type.fqcn, ref);
        this.types.push(ref);
        const simple = type.name.includes(".") ? type.name.slice(type.name.lastIndexOf(".") + 1) : type.name;
        const list = this.bySimple.get(simple) ?? [];
        list.push(ref);
        this.bySimple.set(simple, list);
      }
    }
  }

  get(fqcn: string): TypeRef | undefined {
    return this.byFqcn.get(fqcn);
  }

  /** Resolve a type mention (`ISysUserService`, `List<SysUser>`, `com.x.Y`, `Outer.Inner`) seen inside `ctx`. */
  resolveType(typeText: string, ctx: TypeRef): TypeRef | undefined {
    const raw = rawTypeName(typeText).replace(/\.\.\.$/, "");
    if (!raw) return undefined;
    const direct = this.byFqcn.get(raw);
    if (direct) return direct;
    const [head, ...rest] = raw.split(".");
    const tail = rest.length > 0 ? `.${rest.join(".")}` : "";
    const facts = ctx.facts;
    const imported = head ? facts.imports[head] : undefined;
    if (imported) return this.byFqcn.get(imported + tail);
    // Nested in the context type or its enclosing types.
    let outer: string | undefined = ctx.type.fqcn;
    while (outer) {
      const nested = this.byFqcn.get(`${outer}.${raw}`);
      if (nested) return nested;
      const dot = outer.lastIndexOf(".");
      outer = dot > 0 && outer.slice(0, dot) !== facts.package ? outer.slice(0, dot) : undefined;
    }
    const samePackage = this.byFqcn.get(facts.package ? `${facts.package}.${raw}` : raw);
    if (samePackage) return samePackage;
    for (const pkg of facts.wildcardImports) {
      const viaWildcard = this.byFqcn.get(`${pkg}.${raw}`);
      if (viaWildcard) return viaWildcard;
    }
    if (rest.length > 0) return undefined;
    // Last resort: a unique simple name in this service's classpath.
    const candidates = this.bySimple.get(raw);
    return candidates?.length === 1 ? candidates[0] : undefined;
  }

  /** Superclass chain and all implemented interfaces, nearest first. Unresolvable (library) types are skipped. */
  ancestors(ref: TypeRef): TypeRef[] {
    const cached = this.ancestorCache.get(ref);
    if (cached) return cached;
    const out: TypeRef[] = [];
    const seen = new Set<TypeRef>([ref]);
    const queue: TypeRef[] = [ref];
    while (queue.length > 0) {
      const current = queue.shift() as TypeRef;
      const parents = [...(current.type.superclass ? [current.type.superclass] : []), ...current.type.interfaces];
      for (const parent of parents) {
        const resolved = this.resolveType(parent, current);
        if (resolved && !seen.has(resolved)) {
          seen.add(resolved);
          out.push(resolved);
          queue.push(resolved);
        }
      }
    }
    this.ancestorCache.set(ref, out);
    return out;
  }

  /** Raw names of every supertype mention, including library types (`OncePerRequestFilter`, `BaseMapper<T>`). */
  supertypeNames(ref: TypeRef): string[] {
    const cached = this.supertypeNameCache.get(ref);
    if (cached) return cached;
    const names = this.computeSupertypeNames(ref);
    this.supertypeNameCache.set(ref, names);
    return names;
  }

  /** Concrete bean classes that declare (directly or via ancestors) a supertype with this simple name. */
  beansImplementing(simpleName: string): readonly TypeRef[] {
    if (!this.beansBySupertypeName) {
      this.beansBySupertypeName = new Map();
      for (const t of this.types) {
        if (t.type.kind !== "class" || !this.isBean(t)) continue;
        for (const name of new Set(this.supertypeNames(t))) {
          const list = this.beansBySupertypeName.get(name);
          if (list) list.push(t);
          else this.beansBySupertypeName.set(name, [t]);
        }
      }
    }
    return this.beansBySupertypeName.get(simpleName) ?? [];
  }

  private computeSupertypeNames(ref: TypeRef): string[] {
    const names: string[] = [];
    for (const t of [ref, ...this.ancestors(ref)]) {
      if (t.type.superclass) names.push(rawTypeName(t.type.superclass));
      names.push(...t.type.interfaces.map(rawTypeName));
    }
    return names.map((n) => n.slice(n.lastIndexOf(".") + 1));
  }

  /** Concrete (non-interface, non-abstract) types assignable to `ref`. */
  implementations(ref: TypeRef): TypeRef[] {
    if (!this.implCache) {
      this.implCache = new Map();
      for (const t of this.types) {
        if (t.type.kind !== "class" || t.type.modifiers.includes("abstract")) continue;
        for (const a of this.ancestors(t)) {
          const list = this.implCache.get(a) ?? [];
          list.push(t);
          this.implCache.set(a, list);
        }
      }
    }
    const concrete = ref.type.kind === "class" && !ref.type.modifiers.includes("abstract") ? [ref] : [];
    return [...concrete, ...(this.implCache.get(ref) ?? [])];
  }

  /** Methods named `name` accepting `argCount` args, searched in the type, then ancestors. */
  findMethods(ref: TypeRef, name: string, argCount: number): MethodRef[] {
    for (const owner of [ref, ...this.ancestors(ref)]) {
      const matches = owner.type.methods.filter((m) => m.name === name && !m.isConstructor && acceptsArgs(m, argCount));
      if (matches.length > 0) return matches.map((method) => ({ owner, method }));
    }
    return [];
  }

  isBean(ref: TypeRef): boolean {
    return ref.type.annotations.some((a) => BEAN_ANNOTATIONS.has(a.name));
  }

  beanName(ref: TypeRef): string {
    for (const a of ref.type.annotations) {
      if (!BEAN_ANNOTATIONS.has(a.name)) continue;
      const v = a.args["value"];
      if (v?.kind === "string" && v.value) return v.value;
    }
    const simple = ref.type.name.slice(ref.type.name.lastIndexOf(".") + 1);
    return simple.charAt(0).toLowerCase() + simple.slice(1);
  }

  /**
   * Fold a constant expression to a string: literals, `CONST`, `Type.CONST`,
   * `pkg.Type.CONST`, and `+` concatenations of those.
   */
  /**
   * Fold an expression to a string: literals, `+` concatenation and **final** fields (a mutable
   * field's initializer says nothing about its value at the call). `shadow` = parameter and local
   * names of the calling method: a bare identifier that names one of them is not the field.
   */
  resolveConstant(expr: string, ctx: TypeRef, depth = 0, shadow?: ReadonlySet<string>): string | undefined {
    if (depth > 8) return undefined;
    const literal = javaStringLiteralText(expr);
    if (literal !== undefined) return literal;
    const parts = splitTopLevelPlus(expr);
    if (parts.length > 1) {
      const folded = parts.map((p) => this.resolveConstant(p, ctx, depth + 1, shadow));
      return folded.every((p): p is string => p !== undefined) ? folded.join("") : undefined;
    }
    const text = expr.trim();
    if (!/^[\w.]+$/.test(text)) return undefined;
    const dot = text.lastIndexOf(".");
    const owner = dot < 0 ? ctx : this.resolveType(text.slice(0, dot), ctx);
    const fieldName = dot < 0 ? text : text.slice(dot + 1);
    if (!owner || (dot < 0 && shadow?.has(text))) return undefined;
    for (const t of [owner, ...this.ancestors(owner)]) {
      const field = t.type.fields.find((f) => f.name === fieldName);
      if (!field) continue;
      const constant = field.modifiers.includes("final") || t.type.kind === "interface" || t.type.kind === "annotation";
      return constant ? field.stringValue : undefined;
    }
    return undefined;
  }
}

function acceptsArgs(method: JavaMethod, argCount: number): boolean {
  const n = method.params.length;
  const varargs = n > 0 && method.params[n - 1]?.type.endsWith("...");
  return varargs ? argCount >= n - 1 : argCount === n;
}

function splitTopLevelPlus(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let current = "";
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i] as string;
    if (ch === '"' && expr[i - 1] !== "\\") inString = !inString;
    if (!inString) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "+" && depth === 0) {
        parts.push(current.trim());
        current = "";
        continue;
      }
    }
    current += ch;
  }
  parts.push(current.trim());
  return parts.filter(Boolean);
}

export function hasAnnotation(annotations: readonly JavaAnnotation[], ...names: string[]): JavaAnnotation | undefined {
  return annotations.find((a) => names.includes(a.name));
}

export function annotationStrings(annotation: JavaAnnotation | undefined, ...keys: string[]): string[] | undefined {
  if (!annotation) return undefined;
  for (const key of keys) {
    const v = annotation.args[key];
    if (!v) continue;
    if (v.kind === "string") return [v.value];
    if (v.kind === "strings") return v.values;
  }
  return undefined;
}

/** Annotation value as raw expression text (for constants), when not a plain literal. */
export function annotationExpr(annotation: JavaAnnotation | undefined, ...keys: string[]): string | undefined {
  if (!annotation) return undefined;
  for (const key of keys) {
    const v = annotation.args[key];
    if (v?.kind === "expr") return v.text;
  }
  return undefined;
}
