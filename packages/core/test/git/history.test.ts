import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectModuleHistory, GitNotFoundError } from "../../src/git/index.js";

const gitAvailable = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;
if (!gitAvailable) {
  console.warn("[git/history.test] `git` not found on PATH — skipping git integration tests.");
}

let scratch = "";
// Keep temp dirs from discovering an enclosing repository.
const prevCeiling = process.env.GIT_CEILING_DIRECTORIES;

let clock = Date.parse("2024-01-01T00:00:00Z");
function gitEnv(): NodeJS.ProcessEnv {
  clock += 3600_000;
  // +08:00 offset on purpose: authorTime must come back as UTC.
  const d = new Date(clock + 8 * 3600_000).toISOString().replace("Z", "+08:00");
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "测试者",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "测试者",
    GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_AUTHOR_DATE: d,
    GIT_COMMITTER_DATE: d,
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv(), encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function write(repo: string, rel: string, content: string | Buffer): void {
  const p = join(repo, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

function commitAll(repo: string, msg: string): void {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", msg);
}

function initRepo(name: string): string {
  const repo = join(scratch, name);
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "symbolic-ref", "HEAD", "refs/heads/main");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "commit.gpgsign", "false");
  return repo;
}

const CN_DIR = "中文 模块";
const MODULES = [
  { id: "root", path: "" },
  { id: "a", path: "svc-a" },
  { id: "a-sub", path: "svc-a/sub" },
  { id: "b", path: "svc-b" },
  { id: "cn", path: CN_DIR },
  { id: "docs", path: "docs" },
  { id: "none", path: "does-not-exist" },
];

/**
 * History exercising every AC#6 edge case:
 *   - cross-module rename (svc-a/A.java → svc-b/A.java)
 *   - binary file, Chinese + space paths, empty commit
 *   - plain --no-ff merge (TREESAME per path → hidden by `git log -- <path>`)
 *   - `-s ours` merge (side-branch commit hidden by history simplification)
 *   - evil merge editing docs/ (shown by `git log -- docs` with no numstat)
 */
function buildFixture(): string {
  const repo = initRepo("main-repo");
  write(repo, "svc-a/A.java", "class A {}\n");
  write(repo, "svc-b/B.java", "class B {}\n");
  write(repo, `${CN_DIR}/说明 文件.md`, "# 说明\n");
  write(repo, "docs/readme.md", "v1\n");
  commitAll(repo, "init");

  write(repo, "svc-a/sub/X.java", "class X {}\n");
  commitAll(repo, "add nested");

  write(repo, "svc-b/logo.png", Buffer.from([0, 1, 2, 0, 255, 0]));
  commitAll(repo, "binary");

  git(repo, "checkout", "-q", "-b", "feat");
  write(repo, "svc-a/A.java", "class A { int x; }\n");
  commitAll(repo, "feat a");
  write(repo, "svc-b/B.java", "class B { int y; }\n");
  commitAll(repo, "feat b");
  git(repo, "checkout", "-q", "main");
  write(repo, "docs/readme.md", "v2\n");
  commitAll(repo, "docs v2");
  git(repo, "merge", "-q", "--no-ff", "-m", "merge feat", "feat");

  git(repo, "checkout", "-q", "-b", "side");
  write(repo, "svc-b/B.java", "class B { discarded; }\n");
  commitAll(repo, "side discarded");
  git(repo, "checkout", "-q", "main");
  git(repo, "merge", "-q", "-s", "ours", "-m", "merge side (ours)", "side");

  git(repo, "checkout", "-q", "-b", "evil");
  write(repo, `${CN_DIR}/另一个.md`, "x\n");
  commitAll(repo, "evil branch");
  git(repo, "checkout", "-q", "main");
  git(repo, "merge", "-q", "--no-ff", "--no-commit", "evil");
  write(repo, "docs/readme.md", "edited inside merge\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "evil merge");

  git(repo, "mv", "svc-a/A.java", "svc-b/A.java");
  git(repo, "commit", "-q", "-m", "move A across modules");

  git(repo, "commit", "-q", "--allow-empty", "-m", "empty");
  return repo;
}

function expectedShas(repo: string, path: string): string[] {
  const args = ["-c", "core.quotepath=off", "log", "--format=%H"];
  if (path !== "") args.push("--", path);
  return git(repo, ...args).split("\n").filter(Boolean);
}

function onelineCount(repo: string, path: string): number {
  const args = ["log", "--oneline"];
  if (path !== "") args.push("--", path);
  return git(repo, ...args).split("\n").filter(Boolean).length;
}

describe.skipIf(!gitAvailable)("collectModuleHistory (real git)", () => {
  let repo = "";
  beforeAll(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "atlas-git-")));
    process.env.GIT_CEILING_DIRECTORIES = scratch;
    repo = buildFixture();
  });
  afterAll(() => {
    if (prevCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = prevCeiling;
    rmSync(scratch, { recursive: true, force: true });
  });

  it("AC#6: per-module commit count equals `git log --oneline -- <path> | wc -l`", async () => {
    const res = await collectModuleHistory({ cwd: repo, modules: MODULES });
    expect(res.diagnostics).toEqual([]);
    expect(res.shallow).toBe(false);
    expect(res.head).toBe(git(repo, "rev-parse", "HEAD").trim());
    for (const m of MODULES) {
      const h = res.history.find((x) => x.moduleId === m.id);
      expect(h, m.id).toBeDefined();
      expect(h?.degraded, m.id).toBeUndefined();
      expect(h?.commits.length, m.id).toBe(onelineCount(repo, m.path));
      expect(new Set(h?.commits.map((c) => c.sha)), m.id).toEqual(new Set(expectedShas(repo, m.path)));
    }
  });

  it("captures the semantics the single-pass approach would get wrong", async () => {
    const res = await collectModuleHistory({ cwd: repo, modules: MODULES });
    const msgs = (id: string) => res.history.find((h) => h.moduleId === id)?.commits.map((c) => c.message) ?? [];
    // history simplification hides the side commit discarded by `-s ours`
    expect(msgs("b")).not.toContain("side discarded");
    expect(msgs("root")).toContain("side discarded");
    // evil merge is shown for docs (no numstat), TREESAME merges are not
    expect(msgs("docs")).toContain("evil merge");
    expect(msgs("docs")).not.toContain("merge feat");
    // nested module commits count for the parent too (pathspec semantics)
    expect(msgs("a")).toContain("add nested");
    expect(msgs("a-sub")).toEqual(["add nested"]);
    // cross-module rename appears on both sides
    expect(msgs("a")).toContain("move A across modules");
    expect(msgs("b")).toContain("move A across modules");
    expect(msgs("none")).toEqual([]);
  });

  it("reports files, line counts, binary and UTC author times correctly", async () => {
    const res = await collectModuleHistory({ cwd: repo, modules: MODULES });
    const root = res.history.find((h) => h.moduleId === "root")?.commits ?? [];
    const byMsg = (m: string) => root.find((c) => c.message === m);

    expect(byMsg("binary")).toMatchObject({ added: 0, deleted: 0, files: ["svc-b/logo.png"] });
    expect(byMsg("init")?.files).toContain(`${CN_DIR}/说明 文件.md`);
    expect(byMsg("init")).toMatchObject({ added: 4, deleted: 0, author: "测试者" });
    expect(byMsg("move A across modules")?.files).toEqual(["svc-a/A.java", "svc-b/A.java"]);
    expect(byMsg("empty")).toMatchObject({ files: [], added: 0, deleted: 0 });
    expect(byMsg("merge feat")).toMatchObject({ files: [], added: 0 });

    for (const c of root) expect(c.authorTime).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/);
    const init = byMsg("init");
    const epoch = Number(git(repo, "log", "-1", "--format=%at", init?.sha ?? "HEAD").trim());
    expect(init?.authorTime).toBe(new Date(epoch * 1000).toISOString());
    const times = root.map((c) => Date.parse(c.authorTime));
    expect([...times].sort((x, y) => y - x)).toEqual(times);
    expect(root[0]?.message).toBe("empty");
  });

  it("honours maxCommitsPerModule and since", async () => {
    const all = await collectModuleHistory({ cwd: repo, modules: [{ id: "root", path: "" }] });
    const commits = all.history[0]?.commits ?? [];
    const capped = await collectModuleHistory({ cwd: repo, modules: [{ id: "root", path: "" }], maxCommitsPerModule: 3 });
    expect(capped.history[0]?.commits.map((c) => c.sha)).toEqual(commits.slice(0, 3).map((c) => c.sha));

    const pivot = commits[4];
    expect(pivot).toBeDefined();
    const since = new Date(pivot?.authorTime ?? 0);
    const recent = await collectModuleHistory({ cwd: repo, modules: [{ id: "root", path: "" }], since });
    expect(recent.history[0]?.commits.map((c) => c.sha)).toEqual(commits.slice(0, 5).map((c) => c.sha));
  });

  it("degrades shallow clones", async () => {
    const clone = join(scratch, "shallow");
    git(scratch, "clone", "-q", "--depth", "2", pathToFileURL(repo).href, clone);
    const res = await collectModuleHistory({ cwd: clone, modules: MODULES });
    expect(res.shallow).toBe(true);
    expect(res.history.every((h) => h.degraded === "shallow")).toBe(true);
    expect(res.history.find((h) => h.moduleId === "root")?.commits.length).toBeLessThanOrEqual(2);
    expect(res.diagnostics.map((d) => d.code)).toEqual(["ATLAS-I002"]);
  });

  it("returns empty histories for a repo without commits", async () => {
    const empty = initRepo("empty-repo");
    const res = await collectModuleHistory({ cwd: empty, modules: MODULES });
    expect(res.head).toBeUndefined();
    expect(res.history.every((h) => h.commits.length === 0 && h.degraded === undefined)).toBe(true);
  });

  it("degrades with ATLAS-I001 outside a repository", async () => {
    const plain = join(scratch, "not-a-repo");
    mkdirSync(plain);
    const res = await collectModuleHistory({ cwd: plain, modules: MODULES });
    expect(res.history).toHaveLength(MODULES.length);
    expect(res.history.every((h) => h.degraded === "no-git" && h.commits.length === 0)).toBe(true);
    expect(res.diagnostics).toEqual([expect.objectContaining({ code: "ATLAS-I001", severity: "info" })]);
  });

  it("aborts via AbortSignal", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("stop"));
    await expect(collectModuleHistory({ cwd: repo, modules: MODULES, signal: ctrl.signal })).rejects.toThrow("stop");
  });

  it("emits ATLAS-W001 when output exceeds the cap", async () => {
    const res = await collectModuleHistory({ cwd: repo, modules: [{ id: "root", path: "" }], maxOutputBytes: 400 });
    expect(res.diagnostics.map((d) => d.code)).toEqual(["ATLAS-W001"]);
    const full = expectedShas(repo, "");
    const got = res.history[0]?.commits.map((c) => c.sha) ?? [];
    expect(got.length).toBeLessThan(full.length);
    for (const sha of got) expect(full).toContain(sha);
  });
});

describe("collectModuleHistory (git binary missing)", () => {
  it("degrades with ATLAS-E001", async () => {
    const res = await collectModuleHistory({
      cwd: tmpdir(),
      modules: [{ id: "m", path: "" }],
      gitPath: "atlas-definitely-not-git-binary",
    });
    expect(res.history).toEqual([{ moduleId: "m", commits: [], degraded: "no-git" }]);
    expect(res.diagnostics).toEqual([expect.objectContaining({ code: "ATLAS-E001", severity: "error" })]);
    expect(GitNotFoundError).toBeTypeOf("function");
  });
});
