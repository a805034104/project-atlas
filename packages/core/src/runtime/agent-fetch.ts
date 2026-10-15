import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { docsUrlFor } from "../llm/errors.js";
import type { UserFacingError } from "../protocol.js";
import { JAVAAGENT_FILE, JAVAAGENT_SHA256, JAVAAGENT_URLS, JAVAAGENT_VERSION } from "./agent-config.js";
import { atlasHome } from "./session.js";

/**
 * The pinned OpenTelemetry javaagent on disk (V3).
 *
 *   explicit path (machine setting) ──┐
 *   ~/.project-atlas/agents/<jar> ─────┼─▶ sha256 == pinned? ─▶ ASCII-safe copy if the path has
 *   download Maven Central → Aliyun ──┘    (re-checked on every   non-ASCII characters (S0: JDK 21
 *     (size cap, temp file, rename)         call)                fails on them under GBK)
 */

const MAX_AGENT_BYTES = 64 * 1024 * 1024;

export class AgentDownloadError extends Error {
  readonly code = "ATLAS-E070";
  constructor(readonly attempts: { url: string; error: string }[]) {
    super(`Could not download the OpenTelemetry javaagent ${JAVAAGENT_VERSION}: ${attempts.map((a) => `${a.url}: ${a.error}`).join("; ")}`);
  }
  toUserFacing(): UserFacingError {
    return {
      code: this.code,
      problem: `Downloading the OpenTelemetry javaagent ${JAVAAGENT_VERSION} failed from every source.`,
      cause: this.attempts.map((a) => `${new URL(a.url).host}: ${a.error}`).join("; "),
      fix: `Download it manually and point atlas.runtime.javaagentPath (or --agent) at it:\n  curl -L -o ${JAVAAGENT_FILE} ${JAVAAGENT_URLS[1]}\n  Invoke-WebRequest -OutFile ${JAVAAGENT_FILE} ${JAVAAGENT_URLS[1]}\nsha256 ${JAVAAGENT_SHA256}`,
      docsUrl: docsUrlFor(this.code),
    };
  }
}

export class AgentIntegrityError extends Error {
  readonly code = "ATLAS-E071";
  constructor(
    readonly file: string,
    readonly actual: string,
    readonly bytes: number,
    readonly contentType?: string,
  ) {
    super(`sha256 of ${file} is ${actual}, expected ${JAVAAGENT_SHA256}`);
  }
  toUserFacing(): UserFacingError {
    const html = this.contentType?.includes("html") ? " The server returned an HTML page (a proxy login or captive portal?)." : "";
    return {
      code: this.code,
      problem: `The javaagent file does not match the pinned ${JAVAAGENT_VERSION} release, so it was not used.`,
      cause: `${this.bytes} bytes, sha256 ${this.actual}${this.contentType ? `, content-type ${this.contentType}` : ""}.${html}`,
      fix: `Delete it and retry, or download opentelemetry-javaagent ${JAVAAGENT_VERSION} yourself (sha256 ${JAVAAGENT_SHA256}).`,
      docsUrl: docsUrlFor(this.code),
    };
  }
}

export interface EnsureAgentOptions {
  /** atlas.runtime.javaagentPath / --agent */
  explicitPath?: string;
  homeDir?: string;
  fetch?: typeof globalThis.fetch;
  urls?: readonly string[];
  onProgress?(p: { url: string; received: number; total?: number }): void;
  signal?: AbortSignal;
  /** Where to copy the jar when its path is not ASCII (default: %ProgramData% / /tmp). */
  asciiDir?: string;
}

async function sha256File(file: string): Promise<{ hash: string; bytes: number }> {
  const data = await readFile(file);
  return { hash: createHash("sha256").update(data).digest("hex"), bytes: data.length };
}

const isAscii = (p: string) => /^[\x20-\x7e]*$/.test(p);

function defaultAsciiDir(): string {
  if (process.platform === "win32") return path.join(process.env["ProgramData"] && isAscii(process.env["ProgramData"]) ? process.env["ProgramData"] : "C:\\ProgramData", "project-atlas", "agents");
  return "/tmp/project-atlas-agents";
}

/** Copy to an ASCII-only directory when needed; the copy is verified too. */
async function asciiSafe(file: string, options: EnsureAgentOptions): Promise<string> {
  if (isAscii(file)) return file;
  const dir = options.asciiDir ?? defaultAsciiDir();
  const target = path.join(dir, JAVAAGENT_FILE);
  const existing = await sha256File(target).catch(() => undefined);
  if (existing?.hash !== JAVAAGENT_SHA256) {
    await mkdir(dir, { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    await copyFile(file, tmp);
    await rename(tmp, target);
  }
  return target;
}

async function verified(file: string, contentType?: string): Promise<boolean> {
  const { hash, bytes } = await sha256File(file);
  if (hash === JAVAAGENT_SHA256) return true;
  throw new AgentIntegrityError(file, hash, bytes, contentType);
}

/** Path of a verified javaagent jar usable on the command line. */
export async function ensureJavaAgent(options: EnsureAgentOptions = {}): Promise<string> {
  if (options.explicitPath) {
    await verified(options.explicitPath);
    return asciiSafe(options.explicitPath, options);
  }
  const dir = path.join(atlasHome(options.homeDir), "agents");
  const target = path.join(dir, JAVAAGENT_FILE);
  if (await stat(target).then(() => true, () => false)) {
    try {
      await verified(target);
      return await asciiSafe(target, options);
    } catch (error) {
      if (!(error instanceof AgentIntegrityError)) throw error;
      await rm(target, { force: true }); // corrupt or tampered cache: download again
    }
  }
  await mkdir(dir, { recursive: true });
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const attempts: { url: string; error: string }[] = [];
  for (const url of options.urls ?? JAVAAGENT_URLS) {
    const tmp = `${target}.${process.pid}.${Date.now()}.download`;
    try {
      const res = await fetchImpl(url, { ...(options.signal ? { signal: options.signal } : {}), redirect: "follow" });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get("content-length") ?? "") || undefined;
      if (total && total > MAX_AGENT_BYTES) throw new Error(`refusing ${total} bytes`);
      const chunks: Uint8Array[] = [];
      let received = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        received += chunk.length;
        if (received > MAX_AGENT_BYTES) throw new Error(`more than ${MAX_AGENT_BYTES} bytes`);
        chunks.push(chunk);
        options.onProgress?.({ url, received, ...(total ? { total } : {}) });
      }
      await writeFile(tmp, Buffer.concat(chunks));
      await verified(tmp, res.headers.get("content-type") ?? undefined);
      await rename(tmp, target);
      return await asciiSafe(target, options);
    } catch (error) {
      await rm(tmp, { force: true });
      if (options.signal?.aborted) throw error;
      if (error instanceof AgentIntegrityError) attempts.push({ url, error: `sha256 mismatch (${error.bytes} bytes${error.contentType ? `, ${error.contentType}` : ""})` });
      else attempts.push({ url, error: (error as Error).message });
    }
  }
  throw new AgentDownloadError(attempts);
}
