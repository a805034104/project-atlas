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
 *   /api/*: X-Atlas-Session header matches              (constant time)
 *           or, for EventSource / downloads, a single-use 60 s ticket in the query
 *
 * No cookie: browsers send cookies to every port of 127.0.0.1, so any other local server
 * could collect one. The session token lives in the page's own storage (origin = this port)
 * and travels in a header. It comes from a one-time launch code in the URL fragment; a
 * replayed (already spent) code rotates the session, logging everyone out, because it means
 * someone else saw the code (on Linux/macOS a browser's command line is readable by other users).
 */

const CODE_TTL_MS = 60_000;
const TICKET_TTL_MS = 60_000;

export interface Auth {
  readonly port: number;
  /** New one-time code for a browser launch. */
  issueCode(): string;
  /** Spend a code; returns the session token, or undefined. */
  redeem(code: string): string | undefined;
  /** The request carries the session token (header) or a valid ticket (query). */
  authenticated(req: IncomingMessage, url: URL): boolean;
  /** Single-use ticket for one EventSource connection or one download. */
  issueTicket(): string;
  /** Long-lived secret (web.json, 0600) another launch uses to ask for a fresh code. */
  readonly secret: string;
  /** Called when a spent code is presented again (the session was rotated). */
  onReplay?: () => void;
}

export function createAuth(port: number, now: () => number = Date.now): Auth {
  let session = randomBytes(32).toString("hex");
  const secret = randomBytes(32).toString("hex");
  const codes = new Map<string, number>();
  const spent = new Set<string>();
  const tickets = new Map<string, number>();
  const auth: Auth = {
    port,
    secret,
    issueCode() {
      for (const [c, exp] of codes) if (exp < now()) codes.delete(c);
      const code = randomBytes(18).toString("base64url");
      codes.set(code, now() + CODE_TTL_MS);
      return code;
    },
    redeem(code) {
      if (spent.has(code)) {
        // Someone else had this code: nobody keeps the session obtained with it.
        session = randomBytes(32).toString("hex");
        tickets.clear();
        auth.onReplay?.();
        return undefined;
      }
      const exp = codes.get(code);
      if (exp === undefined) return undefined;
      codes.delete(code); // one-time, even when expired
      spent.add(code);
      return exp >= now() ? session : undefined;
    },
    issueTicket() {
      for (const [t, exp] of tickets) if (exp < now()) tickets.delete(t);
      const ticket = randomBytes(18).toString("base64url");
      tickets.set(ticket, now() + TICKET_TTL_MS);
      return ticket;
    },
    authenticated(req, url) {
      const header = req.headers["x-atlas-session"];
      if (typeof header === "string") return secretEquals(header, session);
      const ticket = url.searchParams.get("ticket");
      if (ticket === null) return false;
      const exp = tickets.get(ticket);
      if (exp === undefined) return false;
      tickets.delete(ticket);
      return exp >= now();
    },
  };
  return auth;
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
