import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeLockedError, RuntimeSession, workspaceToken } from "../../src/runtime/session.js";

const GOLDEN = path.resolve(__dirname, "../../../../fixtures/runtime/ruoyi-vue-2.31.1/raw");
const payload = readFileSync(path.join(GOLDEN, readdirSync(GOLDEN).filter((f) => f.endsWith(".pb")).sort()[0] as string));

function post(port: number, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/v1/traces", method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/x-protobuf", "content-length": String(payload.length) } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

describe("RuntimeSession", () => {
  it("keeps one token per workspace outside the workspace", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "atlas-home-"));
    const ws = await mkdtemp(path.join(tmpdir(), "atlas-ws-"));
    const a = await workspaceToken(ws, home);
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(await workspaceToken(ws, home)).toBe(a);
    expect(await workspaceToken(`${ws}-other`, home)).not.toBe(a);
  });

  it("receives, stores and persists spans; releases its lock on stop", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "atlas-home-"));
    const ws = await mkdtemp(path.join(tmpdir(), "atlas-ws-"));
    let seen = 0;
    const session = await RuntimeSession.start({ workspaceDir: ws, homeDir: home, port: 0, saveDelayMs: 10, onSpans: (fresh) => (seen += fresh.length) });
    const lock = JSON.parse(await readFile(path.join(ws, ".atlas", "receiver.json"), "utf8")) as { pid: number; port: number };
    expect(lock).toMatchObject({ pid: process.pid, port: session.port });
    expect(await post(session.port, session.token)).toBe(200);
    for (let i = 0; i < 50 && seen === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(seen).toBeGreaterThan(0);
    expect(session.status().spans).toBe(seen);
    await session.stop();
    await expect(readFile(path.join(ws, ".atlas", "receiver.json"), "utf8")).rejects.toThrow();
    const aggregates = JSON.parse(await readFile(path.join(ws, ".atlas", "traces", "aggregates.json"), "utf8")) as { total: number };
    expect(aggregates.total).toBe(seen);
  });

  it("refuses to start while another live process owns the workspace (ATLAS-E074)", async () => {
    const ws = await mkdtemp(path.join(tmpdir(), "atlas-ws-"));
    await mkdir(path.join(ws, ".atlas"), { recursive: true });
    await writeFile(path.join(ws, ".atlas", "receiver.json"), JSON.stringify({ pid: process.ppid, port: 43199, startedAt: "x" }));
    const error = await RuntimeSession.start({ workspaceDir: ws, homeDir: await mkdtemp(path.join(tmpdir(), "atlas-home-")), port: 0 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RuntimeLockedError);
    expect((error as RuntimeLockedError).port).toBe(43199);
  });
});
