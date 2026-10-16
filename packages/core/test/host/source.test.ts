import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSnippet, resolveInRoot } from "../../src/host/source.js";

async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), "atlas-src-"));
  const root = path.join(base, "repo");
  const outside = path.join(base, "secret");
  const home = path.join(base, "home");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(path.join(root, "src", "A.java"), Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n"));
  await writeFile(path.join(root, "..foo"), "dots are a valid name");
  await writeFile(path.join(outside, "id_rsa"), "PRIVATE");
  await writeFile(path.join(home, "credentials.json"), "{}");
  return { base, root, outside, home, roots: [{ id: "r1", path: root }] };
}

describe("source access stays inside the analyzed roots", () => {
  it("reads lines around the target", async () => {
    const f = await fixture();
    const s = await readSnippet(f.roots, { rootId: "r1", file: "src/A.java", line: 50 }, 3, f.home);
    expect(s.error).toBeUndefined();
    expect(s.startLine).toBe(47);
    expect(s.lines).toEqual(["line 47", "line 48", "line 49", "line 50", "line 51", "line 52", "line 53"]);
  });

  it("refuses ../ traversal and absolute paths, but accepts a file named ..foo", async () => {
    const f = await fixture();
    expect(await resolveInRoot(f.roots, { rootId: "r1", file: "../secret/id_rsa" }, f.home)).toBeUndefined();
    expect(await resolveInRoot(f.roots, { rootId: "r1", file: path.join(f.outside, "id_rsa") }, f.home)).toBeUndefined();
    // same answer as a missing file: the page cannot probe which paths exist
    expect((await readSnippet(f.roots, { rootId: "r1", file: "../secret/id_rsa" }, 20, f.home)).error).toBe("not-found");
    expect(await resolveInRoot(f.roots, { rootId: "r1", file: "..foo" }, f.home)).toBe(path.join(f.root, "..foo"));
  });

  it.skipIf(process.platform === "win32")("refuses a symlink that points outside the root", async () => {
    const f = await fixture();
    await symlink(path.join(f.outside, "id_rsa"), path.join(f.root, "src", "link"));
    expect(await resolveInRoot(f.roots, { rootId: "r1", file: "src/link" }, f.home)).toBeUndefined();
  });

  it("never serves files under the ProjectAtlas home, even when a root contains it", async () => {
    const f = await fixture();
    const roots = [{ id: "all", path: f.base }]; // the user imported a parent folder
    expect(await resolveInRoot(roots, { rootId: "all", file: "home/credentials.json" }, f.home)).toBeUndefined();
    expect(await resolveInRoot(roots, { rootId: "all", file: "repo/src/A.java" }, f.home)).toBe(path.join(f.root, "src", "A.java"));
  });

  it("unknown root and NUL bytes are refused", async () => {
    const f = await fixture();
    expect(await resolveInRoot(f.roots, { rootId: "nope", file: "src/A.java" }, f.home)).toBeUndefined();
    expect(await resolveInRoot(f.roots, { rootId: "r1", file: "src/A.java\0.txt" }, f.home)).toBeUndefined();
  });

  it("with host bounds, a root named by a stored graph outside the imported folder is ignored", async () => {
    const f = await fixture();
    // a repository ships .atlas/graph.json whose root is the parent folder (or "/")
    const forged = [{ id: "evil", path: f.base }];
    expect(await resolveInRoot(forged, { rootId: "evil", file: "secret/id_rsa" }, f.home, [f.root])).toBeUndefined();
    expect(await resolveInRoot(f.roots, { rootId: "r1", file: "src/A.java" }, f.home, [f.root])).toBe(path.join(f.root, "src", "A.java"));
  });

  it("with host bounds, a git checkout under the ProjectAtlas home is readable, the rest of the home is not", async () => {
    const f = await fixture();
    const checkout = path.join(f.home, "projects", "abc", ".atlas", "clones", "x");
    await mkdir(path.join(checkout, "src"), { recursive: true });
    await writeFile(path.join(checkout, "src", "B.java"), "class B {}");
    const roots = [{ id: "g", path: checkout }, { id: "h", path: f.home }];
    expect(await resolveInRoot(roots, { rootId: "g", file: "src/B.java" }, f.home, [checkout])).toBe(path.join(checkout, "src", "B.java"));
    expect(await resolveInRoot(roots, { rootId: "h", file: "credentials.json" }, f.home, [checkout])).toBeUndefined();
  });
});
