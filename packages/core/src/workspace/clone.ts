import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { UserFacingError } from "../protocol.js";

/**
 * Shallow clone of services declared in atlas.yaml (`services[].git`).
 *
 *   url ─▶ allow-list (https:// | git@host:) ─▶ dir = <atlasDir>/clones/sha1(url+ref)
 *       ─▶ git -c protocol.ext.allow=never clone --depth 1 --no-recurse-submodules [--branch ref] -- url dir
 *          (env GIT_ALLOW_PROTOCOL=https:ssh, GIT_TERMINAL_PROMPT=0)
 *
 * Callers must only invoke this in a trusted workspace and after user confirmation.
 * Credentials are whatever the user's git credential helper provides.
 */

const ALLOWED = /^(https:\/\/[^\s]+|git@[\w.-]+:[^\s]+)$/;

export class CloneError extends Error {
  readonly code = "ATLAS-E030";
  constructor(
    readonly url: string,
    readonly cause_: string,
  ) {
    super(`clone failed for ${url}: ${cause_}`);
  }
  toUserFacing(): UserFacingError {
    return {
      code: this.code,
      problem: `Cannot clone ${this.url}`,
      cause: this.cause_,
      fix: "Check the URL, ref and your git credentials (only https:// and git@ URLs are allowed).",
      docsUrl: "https://github.com/a805034104/project-atlas/blob/main/docs/errors.md#atlas-e030",
    };
  }
}

export function isAllowedGitUrl(url: string): boolean {
  if (!ALLOWED.test(url) || url.startsWith("-")) return false;
  // Credentials must come from the git credential helper, never from atlas.yaml (they would be logged/persisted).
  return !/^https:\/\/[^/@]*@/.test(url);
}

export function cloneDirFor(atlasDir: string, url: string, ref?: string): string {
  return path.join(atlasDir, "clones", createHash("sha1").update(`${url}#${ref ?? ""}`).digest("hex").slice(0, 16));
}

export async function shallowClone(options: { atlasDir: string; url: string; ref?: string; gitPath?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<string> {
  const { url, ref } = options;
  if (!isAllowedGitUrl(url)) throw new CloneError(url.replace(/\/\/[^/@]*@/, "//«redacted»@"), "only https:// and git@host:path URLs without embedded credentials are allowed");
  if (ref && (ref.startsWith("-") || /[\s~^:?*[\\]/.test(ref))) throw new CloneError(url, `invalid ref "${ref}"`);
  const dir = cloneDirFor(options.atlasDir, url, ref);
  if (existsSync(path.join(dir, ".git"))) return dir; // already cloned: reuse (user can clear the cache)
  await mkdir(path.dirname(dir), { recursive: true });
  const args = ["-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=never", "clone", "--depth", "1", "--no-recurse-submodules", "--quiet", ...(ref ? ["--branch", ref] : []), "--", url, dir];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(options.gitPath ?? "git", args, {
      env: { ...process.env, GIT_ALLOW_PROTOCOL: "https:ssh", GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "ignore", "pipe"],
      ...(options.signal ? { signal: options.signal } : {}),
      timeout: options.timeoutMs ?? 300_000,
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    child.on("error", (error) => reject(new CloneError(url, error.message)));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new CloneError(url, stderr.trim() || `git exited with ${code}`))));
  });
  return dir;
}
