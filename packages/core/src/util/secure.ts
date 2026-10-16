import { timingSafeEqual } from "node:crypto";

/** Constant-time string comparison that does not leak the expected length either. */
export function secretEquals(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  const same = a.length === b.length;
  return timingSafeEqual(same ? a : b, b) && same;
}

/** `Authorization: Bearer <token>` matches `token` (constant time). */
export function bearerMatches(header: string | undefined, token: string): boolean {
  return secretEquals(/^Bearer\s+(.+)$/i.exec(header ?? "")?.[1]?.trim() ?? "", token);
}

/** A loopback `Host` header for this port (DNS-rebinding guard). */
export function loopbackHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}
