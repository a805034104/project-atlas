import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * One local web app per user.
 *
 *   web.lock   created with "wx" by the starting process (atomic); removed on exit
 *   web.json   { pid, port, nonce, secret } (0600) once the server listens
 *
 * A second launch finds a live instance (GET /healthz answers with the same nonce — a pid alone
 * can be reused by another program), asks it for a fresh one-time code with the secret, opens the
 * browser there and exits. A lock or web.json left by a dead process is taken over.
 */

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
    const health = (await (await fetchImpl(`http://127.0.0.1:${info.port}/healthz`, { signal: AbortSignal.timeout(1500) })).json()) as { nonce?: string };
    if (health.nonce !== info.nonce) return undefined;
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
  await mkdir(home, { recursive: true });
  const lockFile = path.join(home, "web.lock");
  const nonce = randomBytes(16).toString("hex");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(lockFile, String(process.pid), { flag: "wx" });
      return {
        nonce,
        publish: async (port, secret) => {
          await writeFile(path.join(home, "web.json"), JSON.stringify({ pid: process.pid, port, nonce, secret } satisfies InstanceInfo), { mode: 0o600 });
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
