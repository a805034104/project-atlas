import { createHash } from "node:crypto";

/**
 * Stable node IDs (spec 评审修订 v1.1 / ENG-A3).
 *
 *   id = base32(sha1(kind \0 serviceName \0 canonicalKey))[0..16]
 *
 * Line numbers are never part of the key, so editing a file does not orphan
 * cache entries or runtime stats attached to its symbols.
 */

export type IdKind =
  | "root"
  | "service"
  | "module"
  | "entrypoint"
  | "step"
  | "edge"
  | "link"
  | "feature";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const ID_LENGTH = 16;

function base32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

export function stableId(kind: IdKind, serviceName: string, canonicalKey: string): string {
  if (canonicalKey.length === 0) throw new Error(`stableId: empty canonical key for ${kind}`);
  const digest = createHash("sha1").update(`${kind}\0${serviceName}\0${canonicalKey}`).digest();
  return base32(digest).slice(0, ID_LENGTH);
}

/** `com.acme.Foo#bar(String,int)` — parameter types keep overloads distinct. */
export function javaMethodKey(fqcn: string, method: string, paramTypes: readonly string[]): string {
  return `${fqcn}#${method}(${paramTypes.map((t) => t.replace(/\s+/g, "")).join(",")})`;
}

/** `GET /system/user/{}` — method upper-cased, path normalized. */
export function httpKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${normalizeHttpPath(path)}`;
}

/** `kafka:order-created` */
export function mqKey(broker: string, destination: string): string {
  return `${broker.toLowerCase()}:${destination}`;
}

/** Edge key: endpoints plus discriminator so parallel edges (branches) stay distinct. */
export function edgeKey(fromId: string, toId: string, discriminator = ""): string {
  return `${fromId}->${toId}${discriminator ? `#${discriminator}` : ""}`;
}

/**
 * Normalize route templates from different frameworks to one shape so that
 * frontend calls, gateway rewrites and backend entrypoints can be matched:
 *
 *   /user/{id}  /user/:id  /user/<int:id>  /user/${id}  → /user/{}
 *
 * Also collapses duplicate slashes, drops trailing slashes and query strings.
 * Wildcards (`*`, `**`) are preserved because Ant matching depends on them.
 */
export function normalizeHttpPath(path: string): string {
  let p = path.trim();
  const query = p.indexOf("?");
  if (query >= 0) p = p.slice(0, query);
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/{2,}/g, "/");
  p = p
    .split("/")
    .map((segment) => {
      if (/^\{[^}]*\}$/.test(segment)) return "{}"; // Spring / FastAPI / OpenAPI
      if (/^\$\{[^}]*\}$/.test(segment)) return "{}"; // JS template literal
      if (/^:[A-Za-z_][\w]*\??$/.test(segment)) return "{}"; // Vue Router / gin / express
      if (/^<(?:[A-Za-z_]\w*:)?[A-Za-z_]\w*>$/.test(segment)) return "{}"; // Django / Flask
      return segment;
    })
    .join("/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}
