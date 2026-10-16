import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { createProvider, renderAtlasMarkdown, renderStaticHtml, secretEquals, toUserFacing, type WebviewToHost } from "@project-atlas/core";
import { listDirs } from "./fs-api.js";
import { ImportError, type ProjectRegistry } from "./projects.js";
import { healthProof } from "./instance.js";
import { baseHeaders, checkRequest, contentSecurityPolicy, createAuth, type Auth } from "./security.js";
import type { SettingsInput, SettingsStore } from "./store.js";

/**
 * Local HTTP server (127.0.0.1 only).
 *
 *   GET  /healthz?challenge=<hex>      { proof }            unauthenticated; proof = HMAC(secret, challenge),
 *                                                           so a second launch knows it talks to the real instance
 *   GET  /                             page shell (CSP nonce, data-atlas-host="web")
 *   GET  /assets/<file>                webview bundle + web theme (allow-list)
 *   POST /api/session      {code}      one-time launch code ─▶ session token (kept in the page, sent as X-Atlas-Session)
 *   POST /api/launch-code              x-atlas-secret (web.json) ─▶ fresh code for a second launch
 *   ── X-Atlas-Session (or a single-use ?ticket= for EventSource / downloads) required below ──
 *   POST /api/ticket                   single-use ticket
 *   GET  /api/state                    version, projects, settings (no keys)
 *   POST /api/projects     {input, trusted}          import a folder / git URL
 *   POST /api/projects/:id/remove | /trust {trusted}
 *   GET  /api/fs/dirs?path=            folder picker (directory names only)
 *   POST /api/settings  · POST /api/settings/test
 *   POST /api/p/:id/msg    WebviewToHost ─▶ HostToWebview[] (replies inline)
 *   GET  /api/p/:id/events             SSE: snapshot, then pushes
 *   GET  /api/p/:id/export?format=html|md|diagnostics
 */

const BODY_LIMIT = 1024 * 1024;

export interface ServerOptions {
  registry: ProjectRegistry;
  settings: SettingsStore;
  assetsDir: string;
  version: string;
  nonce: string;
  dataDir: string;
  log: (line: string) => void;
  /** Port to listen on (0 = any). */
  port: number;
}

export interface AtlasServer {
  server: Server;
  port: number;
  auth: Auth;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const ASSETS: Record<string, string> = {
  "webview.js": "text/javascript; charset=utf-8",
  "webview.css": "text/css; charset=utf-8",
  "web-theme.css": "text/css; charset=utf-8",
  "favicon.svg": "image/svg+xml",
};

export async function startServer(options: ServerOptions): Promise<AtlasServer> {
  let auth: Auth | undefined;
  const server = createServer((req, res) => {
    baseHeaders(res);
    handle(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : error instanceof ImportError ? 400 : 500;
      if (status === 500) options.log(`request failed: ${req.method} ${req.url}: ${(error as Error).stack ?? error}`);
      if (!res.headersSent) json(res, status, { error: error instanceof ImportError ? error.userFacing : { message: (error as Error).message } });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!auth) throw new HttpError(503, "starting");
    const a = auth;
    const rejected = checkRequest(req, a.port);
    if (rejected) throw new HttpError(rejected.status, `rejected: ${rejected.reason}`);
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${a.port}`);
    const route = `${req.method} ${url.pathname}`;

    if (route === "GET /healthz") {
      const challenge = url.searchParams.get("challenge") ?? "";
      if (!/^[0-9a-f]{32,128}$/.test(challenge)) return json(res, 200, { version: options.version });
      return json(res, 200, { version: options.version, proof: healthProof(a.secret, challenge) });
    }
    if (route === "GET /") return page(res);
    if (req.method === "GET" && url.pathname.startsWith("/assets/")) return asset(res, url.pathname.slice("/assets/".length));
    if (route === "POST /api/session") {
      const body = await readJson<{ code?: string }>(req);
      const session = typeof body.code === "string" ? a.redeem(body.code) : undefined;
      if (!session) throw new HttpError(401, "invalid or expired launch code");
      return json(res, 200, { session });
    }
    if (route === "POST /api/launch-code") {
      const presented = req.headers["x-atlas-secret"];
      if (typeof presented !== "string" || !secretEquals(presented, a.secret)) throw new HttpError(401, "bad secret");
      return json(res, 200, { code: a.issueCode() });
    }
    if (!url.pathname.startsWith("/api/")) throw new HttpError(404, "not found");
    if (!a.authenticated(req, url)) throw new HttpError(401, "not signed in");
    options.registry.touch();
    if (route === "POST /api/ticket") return json(res, 200, { ticket: a.issueTicket() });

    if (route === "GET /api/state") return json(res, 200, { version: options.version, dataDir: options.dataDir, projects: options.registry.list(), settings: options.settings.publicView() });
    if (route === "POST /api/projects") {
      const body = await readJson<{ input?: unknown; trusted?: unknown }>(req);
      if (typeof body.input !== "string") throw new HttpError(400, "input required");
      const result = await options.registry.import(body.input, body.trusted === true);
      return json(res, 200, result);
    }
    const projectAction = /^\/api\/projects\/([0-9a-f]{16})\/(remove|trust)$/.exec(url.pathname);
    if (projectAction && req.method === "POST") {
      const [, id, action] = projectAction as unknown as [string, string, string];
      if (action === "remove") await options.registry.remove(id);
      else await options.registry.setTrusted(id, (await readJson<{ trusted?: unknown }>(req)).trusted === true);
      return json(res, 200, { ok: true });
    }
    if (route === "GET /api/fs/dirs") return json(res, 200, await listDirs(url.searchParams.get("path") ?? undefined));
    if (route === "POST /api/settings") {
      await options.settings.update(await readJson<SettingsInput>(req));
      return json(res, 200, options.settings.publicView());
    }
    if (route === "POST /api/settings/test") return json(res, 200, await testConnection(options.settings));

    const projectRoute = /^\/api\/p\/([0-9a-f]{16})\/(msg|events|export)$/.exec(url.pathname);
    if (projectRoute) {
      const [, id, kind] = projectRoute as unknown as [string, string, string];
      const project = await options.registry.session(id);
      if (!project) throw new HttpError(404, "unknown project");
      if (kind === "events" && req.method === "GET") {
        const snapshot = [...project.session.snapshot(), { type: "analysisState" as const, state: project.controller.state }, ...project.prompts.pending()];
        project.hub.connect(res, snapshot);
        return;
      }
      if (kind === "msg" && req.method === "POST") {
        const message = await readJson<WebviewToHost>(req);
        if (!message || typeof message !== "object" || typeof (message as { type?: unknown }).type !== "string") throw new HttpError(400, "bad message");
        if (message.type === "promptAnswer") {
          project.prompts.answer(String(message.id), message.answer);
          return json(res, 200, []);
        }
        return json(res, 200, await project.session.handle(message));
      }
      if (kind === "export" && req.method === "GET") return exportProject(res, project.controller.graph, url.searchParams.get("format"), project.record.name);
    }
    throw new HttpError(404, "not found");
  }

  async function page(res: ServerResponse): Promise<void> {
    const nonce = randomBytes(16).toString("base64");
    res.setHeader("Content-Security-Policy", contentSecurityPolicy(nonce));
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const locale = options.settings.get().locale;
    res.end(`<!doctype html>
<html lang="${locale.toLowerCase().startsWith("zh") ? "zh-CN" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>ProjectAtlas</title>
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/web-theme.css">
<link rel="stylesheet" href="/assets/webview.css">
</head>
<body data-atlas-host="web" data-atlas-version="${options.version}">
<div id="root"></div>
<script nonce="${nonce}" src="/assets/webview.js"></script>
</body>
</html>`);
  }

  async function asset(res: ServerResponse, name: string): Promise<void> {
    const type = ASSETS[name];
    if (!type) throw new HttpError(404, "not found");
    const body = await readFile(path.join(options.assetsDir, name)).catch(() => undefined);
    if (!body) throw new HttpError(404, "not found");
    res.setHeader("Content-Type", type);
    res.end(body);
  }

  async function exportProject(res: ServerResponse, graph: Parameters<typeof renderAtlasMarkdown>[0] | undefined, format: string | null, name: string): Promise<void> {
    if (!graph) throw new HttpError(409, "analyze the project first");
    const safe = name.replace(/[^\w.-]+/g, "_") || "project";
    if (format === "md") {
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${safe}-ATLAS.md"`);
      res.end(renderAtlasMarkdown(graph, { language: options.settings.get().locale.toLowerCase().startsWith("zh") ? "zh-cn" : "en" }));
      return;
    }
    if (format === "html") {
      const [js, css] = await Promise.all([readFile(path.join(options.assetsDir, "webview.js"), "utf8"), readFile(path.join(options.assetsDir, "webview.css"), "utf8")]);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${safe}-atlas.html"`);
      res.end(renderStaticHtml(graph, { js, css }, options.settings.get().locale));
      return;
    }
    if (format === "diagnostics") {
      const report = {
        generatedAt: new Date().toISOString(),
        version: options.version,
        platform: `${process.platform}-${process.arch}`,
        node: process.version,
        graph: { analyzerVersion: graph.analyzerVersion, services: graph.services.length, entrypoints: graph.entrypoints.length, steps: graph.steps.length, edges: graph.edges.length, unresolved: graph.unresolvedCalls.length, diagnostics: graph.diagnostics.map((d) => ({ code: d.code, severity: d.severity })) },
      };
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${safe}-diagnostics.json"`);
      res.end(JSON.stringify(report, null, 2));
      return;
    }
    throw new HttpError(400, "format must be html, md or diagnostics");
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  auth = createAuth(port);
  auth.onReplay = () => options.log("warning: a launch code was used twice, so someone else saw it; every page was signed out. Start ProjectAtlas again to get a new link.");
  return {
    server,
    port,
    auth,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function testConnection(settings: SettingsStore): Promise<{ ok: boolean; model?: string; error?: unknown }> {
  const config = settings.providerConfig();
  if (!config) return { ok: false, error: { message: "AI is off" } };
  try {
    const provider = createProvider({ ...config, timeoutMs: 30_000 });
    await provider.complete({ system: 'Reply with the JSON object {"ok": true} and nothing else.', user: "ping", maxOutputTokens: 16 });
    return { ok: true, model: provider.model };
  } catch (error) {
    return { ok: false, error: toUserFacing(error) };
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function readJson<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        // Keep reading (and discarding) so the 413 reaches the client before the socket closes.
        if (!tooLarge) reject(new HttpError(413, "body too large"));
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return;
      try {
        resolve((chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}) as T);
      } catch {
        reject(new HttpError(400, "invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}
