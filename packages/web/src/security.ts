import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loopbackHost, secretEquals } from "@project-atlas/core";

/**
 * Every request to the local server passes these checks before routing:
 *
 *   Host is 127.0.0.1:<port> / localhost:<port>        (DNS rebinding)
 *   non-GET: Origin is exactly http://127.0.0.1:<port>  (SameSite ignores ports: any local page is "same-site")
 *            Sec-Fetch-Site is same-origin / none / absent
 *            Content-Type is application/json           (no simple-form CSRF)
 *   /api/*: session cookie atlas_<port> matches         (constant time)
 *
 * Session cookies come from one-time launch codes (60 s) put in the URL fragment, never the
 * long-lived secret: browser history and process lists only ever see a spent code.
 */

const CODE_TTL_MS = 60_000;

export interface Auth {
  readonly port: number;
  readonly cookieName: string;
  /** New one-time code for a browser launch. */
  issueCode(): string;
  /** Spend a code; returns the session value to set as cookie, or undefined. */
  redeem(code: string): string | undefined;
  /** The request carries a valid session cookie. */
  authenticated(req: IncomingMessage): boolean;
  /** Long-lived secret (web.json, 0600) another launch uses to ask for a fresh code. */
  readonly secret: string;
}

export function createAuth(port: number, now: () => number = Date.now): Auth {
  const session = randomBytes(32).toString("hex");
  const secret = randomBytes(32).toString("hex");
  const codes = new Map<string, number>();
  const cookieName = `atlas_${port}`;
  return {
    port,
    cookieName,
    secret,
    issueCode() {
      for (const [c, exp] of codes) if (exp < now()) codes.delete(c);
      const code = randomBytes(18).toString("base64url");
      codes.set(code, now() + CODE_TTL_MS);
      return code;
    },
    redeem(code) {
      const exp = codes.get(code);
      if (exp === undefined) return undefined;
      codes.delete(code); // one-time, even when expired
      return exp >= now() ? session : undefined;
    },
    authenticated(req) {
      const value = parseCookies(req.headers.cookie)[cookieName];
      return value !== undefined && secretEquals(value, session);
    },
  };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

export type Rejection = { status: number; reason: string };

/** Transport-level checks shared by every route; undefined = allowed. */
export function checkRequest(req: IncomingMessage, port: number): Rejection | undefined {
  if (!loopbackHost(req.headers.host, port)) return { status: 421, reason: "host" };
  const method = req.method ?? "GET";
  const site = req.headers["sec-fetch-site"];
  if (method !== "GET" && method !== "HEAD") {
    const origin = req.headers.origin;
    if (origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return { status: 403, reason: "origin" };
    if (site !== undefined && site !== "same-origin" && site !== "none") return { status: 403, reason: "fetch-site" };
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return { status: 415, reason: "content-type" };
  } else if (site === "cross-site" && (req.url ?? "").startsWith("/api/")) {
    return { status: 403, reason: "fetch-site" };
  }
  return undefined;
}

/** Headers on every response. */
export function baseHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Frame-Options", "DENY");
}

export function contentSecurityPolicy(nonce: string): string {
  return ["default-src 'none'", `script-src 'nonce-${nonce}'`, "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'", "connect-src 'self'", "worker-src blob:", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"].join("; ");
}
