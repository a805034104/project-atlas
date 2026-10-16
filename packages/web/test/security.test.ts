import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { healthProof } from "../src/instance.js";
import { ProjectRegistry } from "../src/projects.js";
import { startServer, type AtlasServer } from "../src/server.js";
import { SettingsStore } from "../src/store.js";

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(port: number, method: string, pathname: string, headers: Record<string, string>, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path: pathname, headers }, (res) => {
      let data = "";
      res.on("data", (c: Buffer) => (data += c.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

let server: AtlasServer;
let home: string;
let project: string;
let session = "";
const origin = () => `http://127.0.0.1:${server.port}`;
const host = () => `127.0.0.1:${server.port}`;
const post = (pathname: string, body: unknown, extra: Record<string, string> = {}) =>
  send(server.port, "POST", pathname, { host: host(), origin: origin(), "content-type": "application/json", ...(session ? { "x-atlas-session": session } : {}), ...extra }, JSON.stringify(body));
const get = (pathname: string, extra: Record<string, string> = {}) => send(server.port, "GET", pathname, { host: host(), ...(session ? { "x-atlas-session": session } : {}), ...extra });

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), "atlas-web-home-"));
  project = await mkdtemp(path.join(tmpdir(), "atlas-web-proj-"));
  await mkdir(path.join(project, "src"), { recursive: true });
  await writeFile(path.join(project, "src", "A.java"), "class A {}\n");
  await writeFile(path.join(home, "credentials.json"), '{"anthropic":"secret-key"}');
  const assetsDir = path.join(home, "assets");
  await mkdir(assetsDir, { recursive: true });
  for (const f of ["webview.js", "webview.css", "web-theme.css", "favicon.svg"]) await writeFile(path.join(assetsDir, f), "/* asset */");
  const settings = await SettingsStore.open(home, "en");
  const registry = await ProjectRegistry.open({ home, settings, assets: {}, log: () => {} });
  server = await startServer({ registry, settings, assetsDir, version: "test", nonce: "n0nce", dataDir: home, log: () => {}, port: 0 });
});

afterAll(async () => {
  await server?.close();
});

describe("local web server: transport guards (AC-W3)", () => {
  it("answers /healthz with a proof of the secret for a challenge, and gives nothing reusable away", async () => {
    const challenge = "ab".repeat(16);
    const r = await get(`/healthz?challenge=${challenge}`);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).proof).toBe(healthProof(server.auth.secret, challenge));
    expect(r.body).not.toContain("n0nce");
    expect(r.body).not.toContain(server.auth.secret);
    expect(JSON.parse((await get("/healthz")).body).proof).toBeUndefined();
  });

  it("rejects a foreign Host (DNS rebinding) on every route", async () => {
    expect((await send(server.port, "GET", "/healthz", { host: "evil.example" })).status).toBe(421);
    expect((await send(server.port, "GET", "/", { host: `evil.example:${server.port}` })).status).toBe(421);
  });

  it("serves the page with a nonce CSP and no-referrer, framing denied", async () => {
    const r = await get("/");
    expect(r.status).toBe(200);
    const csp = String(r.headers["content-security-policy"]);
    expect(csp).toMatch(/script-src 'nonce-[^']+'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    expect(r.body).toContain('data-atlas-host="web"');
  });

  it("serves only allow-listed assets", async () => {
    expect((await get("/assets/webview.js")).status).toBe(200);
    expect((await get("/assets/../credentials.json")).status).toBe(404);
    expect((await get("/assets/credentials.json")).status).toBe(404);
  });

  it("refuses API calls without the session header", async () => {
    expect((await get("/api/state")).status).toBe(401);
    expect((await post("/api/projects", { input: project })).status).toBe(401);
  });

  it("refuses state-changing requests from another origin, cross-site fetches and form posts", async () => {
    expect((await post("/api/session", { code: "x" }, { origin: "http://127.0.0.1:1" })).status).toBe(403); // another local port
    expect((await post("/api/session", { code: "x" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post("/api/session", { code: "x" }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await send(server.port, "POST", "/api/session", { host: host(), origin: origin(), "content-type": "application/x-www-form-urlencoded" }, "code=x")).status).toBe(415);
    expect((await get("/api/state", { "sec-fetch-site": "cross-site" })).status).toBe(403);
  });

  it("launch codes are one-time; the session travels in a header, never a cookie (cookies reach every local port)", async () => {
    expect((await post("/api/session", { code: "not-issued" })).status).toBe(401);
    const code = server.auth.issueCode();
    const ok = await post("/api/session", { code });
    expect(ok.status).toBe(200);
    expect(ok.headers["set-cookie"]).toBeUndefined();
    session = JSON.parse(ok.body).session as string;
    expect((await get("/api/state")).status).toBe(200);
    // the same token as a cookie is not accepted
    expect((await send(server.port, "GET", "/api/state", { host: host(), cookie: `atlas_${server.port}=${session}` })).status).toBe(401);
  });

  it("a replayed launch code signs everyone out (someone else saw it)", async () => {
    const code = server.auth.issueCode();
    const first = JSON.parse((await post("/api/session", { code })).body).session as string;
    expect((await get("/api/state", { "x-atlas-session": first })).status).toBe(200);
    expect((await post("/api/session", { code })).status).toBe(401);
    expect((await get("/api/state", { "x-atlas-session": first })).status).toBe(401);
    session = JSON.parse((await post("/api/session", { code: server.auth.issueCode() })).body).session as string;
    expect((await get("/api/state")).status).toBe(200);
  });

  it("tickets for EventSource / downloads are single-use", async () => {
    const { ticket } = JSON.parse((await post("/api/ticket", {})).body) as { ticket: string };
    const bare = (q: string) => send(server.port, "GET", `/api/state?ticket=${q}`, { host: host() });
    expect((await bare(ticket)).status).toBe(200);
    expect((await bare(ticket)).status).toBe(401);
    expect((await bare("made-up")).status).toBe(401);
  });

  it("a second launch gets a fresh code only with the instance secret", async () => {
    expect((await post("/api/launch-code", {}, { "x-atlas-secret": "wrong" })).status).toBe(401);
    const r = await post("/api/launch-code", {}, { "x-atlas-secret": server.auth.secret });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).code).toMatch(/^[\w-]{20,}$/);
  });

  it("never returns stored API keys", async () => {
    const state = await get("/api/state");
    expect(state.body).not.toContain("secret-key");
    expect(JSON.parse(state.body).settings.keyStored.anthropic).toBe(true);
  });

  it("imports a project and reads its sources, but nothing outside it", async () => {
    const imported = await post("/api/projects", { input: `"${project}${path.sep}"`, trusted: false });
    expect(imported.status).toBe(200);
    const { record } = JSON.parse(imported.body) as { record: { id: string; storage: string } };
    expect(record.storage).toBe("repo");
    const msg = (m: unknown) => post(`/api/p/${record.id}/msg`, m);
    const graphless = await msg({ type: "readSource", ref: { rootId: "r", file: "src/A.java", line: 1 } });
    expect(graphless.status).toBe(200);
    // no analysis yet: no roots → nothing can be read
    expect(JSON.parse(graphless.body)[0].data.error).toBe("not-found");
  });

  it("rejects UNC paths and relative paths at import", async () => {
    const unc = await post("/api/projects", { input: "\\\\attacker\\share\\repo" });
    expect(unc.status).toBe(400);
    expect(JSON.parse(unc.body).error.code).toBe("ATLAS-E082");
    const relative = await post("/api/projects", { input: "some/relative" });
    expect(JSON.parse(relative.body).error.code).toBe("ATLAS-E082");
  });

  it("a stored key is only sent to the endpoint it was entered for", async () => {
    expect(JSON.parse((await get("/api/state")).body).settings.keyStored.anthropic).toBe(true);
    expect((await post("/api/settings", { provider: "anthropic", baseUrl: "https://attacker.example" })).status).toBe(200);
    const moved = JSON.parse((await get("/api/state")).body).settings;
    expect(moved.keyStored.anthropic).toBe(false);
    // and back to the original endpoint: the key applies again
    await post("/api/settings", { baseUrl: "" });
    expect(JSON.parse((await get("/api/state")).body).settings.keyStored.anthropic).toBe(true);
  });

  it("rejects oversized bodies", async () => {
    const big = await post("/api/settings", { model: "x".repeat(2 * 1024 * 1024) });
    expect(big.status).toBe(413);
  });
});
