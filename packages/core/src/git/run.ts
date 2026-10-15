import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/**
 * Minimal git process runner: args array only (never a shell string),
 * streamed stdout with a hard byte cap, AbortSignal support.
 *
 *   spawn(gitPath, args) ──stdout──▶ StringDecoder ──▶ chunks (≤ maxBytes)
 *            │                                           │ exceeded
 *            └──stderr──▶ tail buffer (diagnostics)      ▼
 *                                                  kill + truncated=true
 */

export const DEFAULT_MAX_OUTPUT_BYTES = 200 * 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;

export interface GitRunOptions {
  gitPath: string;
  cwd: string;
  args: string[];
  signal?: AbortSignal | undefined;
  maxBytes?: number | undefined;
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
  /** Process exit code; null when killed (abort or output cap). */
  code: number | null;
  /** True when stdout exceeded `maxBytes` and the process was killed. */
  truncated: boolean;
}

/** git binary could not be started (ENOENT / EACCES on the executable). */
export class GitNotFoundError extends Error {
  constructor(
    readonly gitPath: string,
    options: { cause: unknown },
  ) {
    super(`git executable not found: ${gitPath}`, options);
    this.name = "GitNotFoundError";
  }
}

/** git ran but exited with an unexpected status. */
export class GitCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} failed (exit ${code ?? "killed"}): ${stderr.trim()}`);
    this.name = "GitCommandError";
  }
}

export function runGit(opts: GitRunOptions): Promise<GitRunResult> {
  const { signal } = opts;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (signal?.aborted) return Promise.reject(signal.reason);

  return new Promise<GitRunResult>((resolve, reject) => {
    const child = spawn(opts.gitPath, opts.args, {
      cwd: opts.cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      // LANGUAGE=en keeps stderr untranslated so callers can classify it.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LANGUAGE: "en" },
    });

    const decoder = new StringDecoder("utf8");
    const chunks: string[] = [];
    let bytes = 0;
    let truncated = false;
    let stderr = "";
    let settled = false;

    const onAbort = (): void => {
      child.kill();
      finish(() => reject(signal?.reason));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    function finish(fn: () => void): void {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      fn();
    }

    child.stdout.on("data", (buf: Buffer) => {
      if (truncated) return;
      const room = maxBytes - bytes;
      if (buf.length > room) {
        chunks.push(decoder.write(buf.subarray(0, room)));
        bytes = maxBytes;
        truncated = true;
        child.kill();
        return;
      }
      bytes += buf.length;
      chunks.push(decoder.write(buf));
    });

    child.stderr.on("data", (buf: Buffer) => {
      if (stderr.length < STDERR_LIMIT) stderr += buf.toString("utf8");
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" || err.code === "EACCES") {
        finish(() => reject(new GitNotFoundError(opts.gitPath, { cause: err })));
      } else {
        finish(() => reject(err));
      }
    });

    child.on("close", (code) => {
      chunks.push(decoder.end());
      finish(() => resolve({ stdout: chunks.join(""), stderr, code, truncated }));
    });
  });
}
