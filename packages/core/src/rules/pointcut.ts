/**
 * AspectJ pointcut subset (spec ENG-A14): `execution`, `within`, `@annotation`,
 * `@within` / `@target`, `bean`, combined with `||`, `&&`, `!` and parentheses,
 * plus references to named `@Pointcut` methods. Anything else is unsupported
 * and the advice is skipped with a diagnostic rather than guessed.
 */

export interface JoinPoint {
  /** Declaring type FQCN. */
  fqcn: string;
  method: string;
  /** Simple names of annotations on the method. */
  methodAnnotations: string[];
  /** Simple names of annotations on the declaring type. */
  typeAnnotations: string[];
  beanName: string;
}

export type Pointcut = (jp: JoinPoint) => boolean;

export class UnsupportedPointcut extends Error {}

export interface PointcutContext {
  /** Advice parameter name → simple type name (for `@annotation(controllerLog)`). */
  paramTypes: Record<string, string>;
  /** Named pointcut method → its expression. */
  named: Record<string, string>;
}

function simple(name: string): string {
  return name.slice(name.lastIndexOf(".") + 1);
}

/** AspectJ type pattern → regex over FQCN (`..` any packages, `*` any chars except dot, `+` subtypes ignored). */
function typePattern(pattern: string): RegExp {
  const p = pattern.replace(/\+$/, "");
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i] as string;
    if (ch === "." && p[i + 1] === ".") {
      re += "(\\.[\\w$]+)*\\.";
      i++;
    } else if (ch === "*") re += "[\\w$]*";
    else if (ch === ".") re += "\\.";
    else re += ch.replace(/[$]/g, "\\$");
  }
  return new RegExp(`^${re}$`);
}

function execution(spec: string): Pointcut {
  // [modifiers] returnType declaringType.method(params) [throws ...]
  const m = /^(?:(?:public|protected|private|static|final)\s+)*(\S+)\s+([\w$.*]+)\((.*)\)\s*(?:throws.*)?$/.exec(spec.trim());
  if (!m) throw new UnsupportedPointcut(`execution(${spec})`);
  const full = m[2] ?? "";
  const lastDot = full.lastIndexOf(".");
  const typePart = lastDot < 0 ? "*" : full.slice(0, lastDot).replace(/\.$/, "..");
  const methodRe = typePattern(lastDot < 0 ? full : full.slice(lastDot + 1));
  const typeRe = typePattern(typePart.endsWith("..") ? `${typePart}*` : typePart);
  return (jp) => typeRe.test(jp.fqcn) && methodRe.test(jp.method);
}

export function compilePointcut(expression: string, ctx: PointcutContext, depth = 0): Pointcut {
  if (depth > 8) throw new UnsupportedPointcut("pointcut reference too deep");
  const expr = expression.trim();
  if (!expr) throw new UnsupportedPointcut("empty pointcut");

  const orParts = splitTop(expr, "||");
  if (orParts.length > 1) {
    const parts = orParts.map((p) => compilePointcut(p, ctx, depth + 1));
    return (jp) => parts.some((p) => p(jp));
  }
  const andParts = splitTop(expr, "&&");
  if (andParts.length > 1) {
    const parts = andParts.map((p) => compilePointcut(p, ctx, depth + 1));
    return (jp) => parts.every((p) => p(jp));
  }
  if (expr.startsWith("!")) {
    const inner = compilePointcut(expr.slice(1), ctx, depth + 1);
    return (jp) => !inner(jp);
  }
  if (expr.startsWith("(") && expr.endsWith(")") && matchingParen(expr, 0) === expr.length - 1) {
    return compilePointcut(expr.slice(1, -1), ctx, depth + 1);
  }

  const call = /^(@?[\w]+)\((.*)\)$/s.exec(expr);
  if (!call) throw new UnsupportedPointcut(expr);
  const [, designator = "", argRaw = ""] = call;
  const arg = argRaw.trim();
  switch (designator) {
    case "execution":
      return execution(arg);
    case "within": {
      const re = typePattern(arg);
      return (jp) => re.test(jp.fqcn);
    }
    case "@annotation": {
      const name = simple(ctx.paramTypes[arg] ?? arg);
      return (jp) => jp.methodAnnotations.includes(name);
    }
    case "@within":
    case "@target": {
      const name = simple(ctx.paramTypes[arg] ?? arg);
      return (jp) => jp.typeAnnotations.includes(name);
    }
    case "bean": {
      const re = new RegExp(`^${arg.replace(/\*/g, ".*")}$`);
      return (jp) => re.test(jp.beanName);
    }
    default: {
      const named = ctx.named[designator];
      if (named !== undefined && arg === "") return compilePointcut(named, ctx, depth + 1);
      throw new UnsupportedPointcut(expr);
    }
  }
}

function matchingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

function splitTop(expr: string, op: "||" | "&&"): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && expr.startsWith(op, i)) {
      parts.push(expr.slice(start, i));
      start = i + op.length;
      i += op.length - 1;
    }
  }
  parts.push(expr.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}
