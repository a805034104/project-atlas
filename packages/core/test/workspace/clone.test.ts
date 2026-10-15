import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloneError, cloneDirFor, isAllowedGitUrl, shallowClone } from "../../src/workspace/clone.js";

describe("clone allow-list", () => {
  it.each([
    ["https://github.com/yangzongzhuan/RuoYi-Cloud.git", true],
    ["git@gitee.com:y_project/RuoYi-Cloud.git", true],
    ["ext::sh -c touch% /tmp/pwned", false],
    ["file:///etc", false],
    ["/local/path", false],
    ["--upload-pack=evil", false],
    ["http://insecure.example/repo.git", false],
    ["https://host/repo.git --config core.sshCommand=x", false],
    ["https://user:ghp_secret@github.com/a/b.git", false],
    ["https://token@github.com/a/b.git", false],
  ])("%s → %s", (url, ok) => {
    expect(isAllowedGitUrl(url)).toBe(ok);
  });

  it("derives a stable, path-safe clone directory", () => {
    const a = cloneDirFor("/x/.atlas", "https://github.com/a/b.git", "main");
    expect(a).toBe(cloneDirFor("/x/.atlas", "https://github.com/a/b.git", "main"));
    expect(path.basename(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(cloneDirFor("/x/.atlas", "https://github.com/a/b.git", "dev"));
  });
});

describe("shallowClone", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("refuses disallowed URLs and refs before running git", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "atlas-clone-"));
    await expect(shallowClone({ atlasDir: dir, url: "file:///etc" })).rejects.toBeInstanceOf(CloneError);
    await expect(shallowClone({ atlasDir: dir, url: "https://github.com/a/b.git", ref: "--upload-pack=x" })).rejects.toThrow(/invalid ref/);
    expect(existsSync(path.join(dir, "clones"))).toBe(false);
  });

  it("reports a clear error when the repository does not exist", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "atlas-clone-"));
    const error = await shallowClone({ atlasDir: dir, url: "https://127.0.0.1:9/nope.git", timeoutMs: 20_000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloneError);
    expect((error as CloneError).toUserFacing().code).toBe("ATLAS-E030");
  });

  it("does not clone local file repositories even when wrapped in an allowed-looking URL", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "atlas-clone-"));
    const source = path.join(dir, "src");
    execFileSync("git", ["init", "-q", source]);
    writeFileSync(path.join(source, "a.txt"), "x");
    await expect(shallowClone({ atlasDir: dir, url: source })).rejects.toBeInstanceOf(CloneError);
  });
});
