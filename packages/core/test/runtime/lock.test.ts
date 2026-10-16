import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeLockedError, RuntimeSession } from "../../src/runtime/session.js";

describe("receiver lock", () => {
  it("concurrent starts in one process do not crash, and stop releases the lock (cross-process exclusion: next test)", async () => {
    const ws = await mkdtemp(path.join(tmpdir(), "atlas-lock-"));
    const home = await mkdtemp(path.join(tmpdir(), "atlas-home-"));
    const results = await Promise.allSettled([RuntimeSession.start({ workspaceDir: ws, homeDir: home, port: 0 }), RuntimeSession.start({ workspaceDir: ws, homeDir: home, port: 0 })]);
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of ok) await (r as PromiseFulfilledResult<RuntimeSession>).value.stop();
    const lock = await readFile(path.join(ws, ".atlas", "receiver.json"), "utf8").catch(() => "");
    expect(lock).toBe(""); // released on stop
  });

  it("replaces a lock left by a dead process and honours a custom atlasDir", async () => {
    const ws = await mkdtemp(path.join(tmpdir(), "atlas-lock-"));
    const home = await mkdtemp(path.join(tmpdir(), "atlas-home-"));
    const atlasDir = path.join(home, "projects", "x");
    await mkdir(atlasDir, { recursive: true });
    await writeFile(path.join(atlasDir, "receiver.json"), JSON.stringify({ pid: 999_999_9, port: 43999, startedAt: "x" }));
    const session = await RuntimeSession.start({ workspaceDir: ws, atlasDir, homeDir: home, port: 0 });
    expect(JSON.parse(await readFile(path.join(atlasDir, "receiver.json"), "utf8")).pid).toBe(process.pid);
    await session.stop();
  });

  it("a live foreign owner blocks the start", async () => {
    const ws = await mkdtemp(path.join(tmpdir(), "atlas-lock-"));
    const home = await mkdtemp(path.join(tmpdir(), "atlas-home-"));
    await mkdir(path.join(ws, ".atlas"), { recursive: true });
    // the parent process (vitest's) is alive and not us
    await writeFile(path.join(ws, ".atlas", "receiver.json"), JSON.stringify({ pid: process.ppid, port: 43998, startedAt: "x" }));
    await expect(RuntimeSession.start({ workspaceDir: ws, homeDir: home, port: 0 })).rejects.toBeInstanceOf(RuntimeLockedError);
  });
});
