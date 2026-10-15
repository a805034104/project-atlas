import { describe, expect, it } from "vitest";
import { parseGitLog } from "../../src/git/parse.js";
import { buildLogArgs, normalizeModulePath } from "../../src/git/history.js";

const RS = "\x1e";
const N = "\0";
const SHA1 = "a".repeat(40);
const SHA2 = "b".repeat(40);
const SHA3 = "c".repeat(40);

function header(sha: string, iso: string, author: string, msg: string): string {
  // LOG_FORMAT fields + the -z commit terminator.
  return `${RS}${sha}${N}${iso}${N}${author}${N}${msg}\n${N}${N}`;
}

describe("parseGitLog", () => {
  it("parses plain, binary and rename entries", () => {
    const out =
      header(SHA1, "2024-03-01T12:00:00+08:00", "张三", "feat: rename\n\nbody") +
      "\n" +
      `3\t1\tsrc/中文 文件.java${N}` +
      `-\t-\tassets/logo.png${N}` +
      `0\t0\t${N}old dir/A.java${N}new dir/A.java${N}`;
    const { commits, incomplete } = parseGitLog(out);
    expect(incomplete).toBe(false);
    expect(commits).toEqual([
      {
        sha: SHA1,
        authorTime: "2024-03-01T04:00:00.000Z",
        author: "张三",
        message: "feat: rename\n\nbody",
        added: 3,
        deleted: 1,
        files: ["src/中文 文件.java", "assets/logo.png", "old dir/A.java", "new dir/A.java"],
      },
    ]);
  });

  it("handles empty commits and merges without numstat between other commits", () => {
    const out =
      header(SHA1, "2024-03-03T00:00:00Z", "a", "Merge branch 'f'") +
      header(SHA2, "2024-03-02T00:00:00Z", "a", "empty") +
      header(SHA3, "2024-03-01T00:00:00-05:00", "a", "real") +
      `\n10\t0\tx.txt${N}`;
    const { commits } = parseGitLog(out);
    expect(commits.map((c) => [c.sha, c.files.length, c.added])).toEqual([
      [SHA1, 0, 0],
      [SHA2, 0, 0],
      [SHA3, 1, 10],
    ]);
    expect(commits[2]?.authorTime).toBe("2024-03-01T05:00:00.000Z");
  });

  it("is not confused by RS or tabs inside messages and paths", () => {
    const out =
      header(SHA1, "2024-01-01T00:00:00Z", "a", `weird ${RS} message\twith tab`) +
      `\n1\t2\tdir/${RS}odd\tname${N}` +
      header(SHA2, "2024-01-01T00:00:00Z", "a", "next");
    const { commits } = parseGitLog(out);
    expect(commits).toHaveLength(2);
    expect(commits[0]?.message).toBe(`weird ${RS} message\twith tab`);
    expect(commits[0]?.files).toEqual([`dir/${RS}odd\tname`]);
  });

  it("returns nothing for empty output", () => {
    expect(parseGitLog("")).toEqual({ commits: [], incomplete: false });
  });

  it("flags and drops a record cut mid-entry", () => {
    const full = header(SHA1, "2024-01-01T00:00:00Z", "a", "one") + `\n1\t0\ta.txt${N}`;
    const cut = full + header(SHA2, "2024-01-01T00:00:00Z", "a", "two") + "\n4\t0\tb.t";
    const { commits, incomplete } = parseGitLog(cut);
    expect(incomplete).toBe(true);
    expect(commits.map((c) => c.sha)).toEqual([SHA1]);
  });

  it("rejects garbage instead of silently skipping it", () => {
    expect(() => parseGitLog("fatal: something")).toThrow(/unexpected git log output/);
    expect(() => parseGitLog(header("nothex", "2024-01-01T00:00:00Z", "a", "m"))).toThrow(/sha/);
    expect(() => parseGitLog(header(SHA1, "2024-01-01T00:00:00Z", "a", "m") + `\nx\t0\tf${N}`)).toThrow(
      /numstat/,
    );
  });
});

describe("buildLogArgs / normalizeModulePath", () => {
  it("normalizes module paths", () => {
    expect(normalizeModulePath("")).toBe("");
    expect(normalizeModulePath(".")).toBe("");
    expect(normalizeModulePath("./a/b/")).toBe("a/b");
    expect(normalizeModulePath("a\\b")).toBe("a/b");
  });

  it("omits the pathspec for the whole repo and adds it after --", () => {
    const whole = buildLogArgs("", 500, undefined);
    expect(whole).not.toContain("--");
    expect(whole).toContain("--max-count=500");
    expect(whole).toContain("core.quotepath=off");
    const mod = buildLogArgs("svc/a/", 10, new Date("2024-01-01T00:00:00Z"));
    expect(mod.slice(-2)).toEqual(["--", "svc/a"]);
    expect(mod).toContain("--since=2024-01-01T00:00:00.000Z");
  });
});
