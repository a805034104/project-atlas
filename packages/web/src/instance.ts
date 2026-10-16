import { createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { secretEquals } from "@project-atlas/core";
import { writeJsonAtomic } from "./store.js";

/**
 * One local web app per user.
 *
 *   web.lock   created with "wx" by the starting process (atomic); removed on exit
 *   web.json   { pid, port, nonce, secret } (0600) once the server listens
 *
 * A second launch finds a live instance and proves it is the real one before trusting it: it sends
 * a random challenge to GET /healthz and expects HMAC(secret, challenge) back. Only then does it
 * send the secret to ask for a fresh one-time code, open the browser there and exit. Whatever
 * else may listen on a port left in a stale web.json (a pid or port can be reused by another
 * program) learns nothing. A lock or web.json left by a dead process is taken over.
 */

export function healthProof(secret: string, challenge: string): string {
  return createHmac("sha256", secret).update(`atlas-healthz:${challenge}`).digest("hex");
}

export interface InstanceInfo {
  pid: number;
  port: number;
  nonce: string;
  secret: string;
}

export interface LiveInstance {
  info: InstanceInfo;
  /** One-time code for the browser. */
  code: string;
}

async function readInfo(home: string): Promise<InstanceInfo | undefined> {
  try {
    const info = JSON.parse(await readFile(path.join(home, "web.json"), "utf8")) as InstanceInfo;
    return Number.isInteger(info.port) && typeof info.nonce === "string" && typeof info.secret === "string" ? info : undefined;
  } catch {
    return undefined;
  }
}

/** The running instance, verified over HTTP, with a fresh launch code. */
export async function findLiveInstance(home: string, fetchImpl: typeof fetch = fetch): Promise<LiveInstance | undefined> {
  const info = await readInfo(home);
  if (!info) return undefined;
  try {
    const challenge = randomBytes(16).toString("hex");
    const health = (await (await fetchImpl(`http://127.0.0.1:${info.port}/healthz?challenge=${challenge}`, { signal: AbortSignal.timeout(1500) })).json()) as { proof?: string };
    if (typeof health.proof !== "string" || !secretEquals(health.proof, healthProof(info.secret, challenge))) return undefined;
    const res = await fetchImpl(`http://127.0.0.1:${info.port}/api/launch-code`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${info.port}`, "x-atlas-secret": info.secret },
      body: "{}",
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return undefined;
    const { code } = (await res.json()) as { code?: string };
    return code ? { info, code } : undefined;
  } catch {
    return undefined;
  }
}

export interface InstanceLock {
  nonce: string;
  /** Record the listening server (call once the port is known). */
  publish(port: number, secret: string): Promise<void>;
  release(): Promise<void>;
}

/**
 * Take the instance lock. Resolves undefined when another live instance holds it (the caller
 * then hands over to it); throws only on unexpected file-system errors.
 */
export async function acquireInstanceLock(home: string, fetchImpl: typeof fetch = fetch): Promise<InstanceLock | undefined> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const lockFile = path.join(home, "web.lock");
  const nonce = randomBytes(16).toString("hex");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(lockFile, String(process.pid), { flag: "wx" });
      return {
        nonce,
        publish: async (port, secret) => {
          await writeJsonAtomic(path.join(home, "web.json"), { pid: process.pid, port, nonce, secret } satisfies InstanceInfo, 0o600);
        },
        release: async () => {
          const info = await readInfo(home);
          if (info?.nonce === nonce) await rm(path.join(home, "web.json"), { force: true });
          await rm(lockFile, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Someone holds the lock: is it really alive? Give a starting instance up to 3 s to publish.
      for (let wait = 0; wait < 6; wait++) {
        if (await findLiveInstance(home, fetchImpl)) return undefined;
        await new Promise((r) => setTimeout(r, 500));
      }
      await rm(lockFile, { force: true }); // stale: its owner died
    }
  }
  return undefined;
}
