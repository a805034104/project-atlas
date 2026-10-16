import type { HostToWebview, UserFacingError, WebviewToHost } from "@project-atlas/core";
import type { VsCodeApi } from "../vscode.js";

/**
 * Browser side of the local web app.
 *
 *   #code=<one-time> ─POST /api/session▶ session token in localStorage (this origin = this port only),
 *                    sent as X-Atlas-Session; fragment removed from history. No cookie: browsers send
 *                    cookies to every port of 127.0.0.1.
 *   EventSource / downloads cannot set headers: they use a single-use ticket (POST /api/ticket).
 *   per project: postMessage ─POST /api/p/:id/msg▶ replies ─┐
 *                EventSource /api/p/:id/events ─────────────┴▶ window "message" events
 *   (the existing bridge listens to window messages, so the map views are unchanged)
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly userFacing: UserFacingError | undefined,
    message: string,
  ) {
    super(message);
  }
}

const SESSION_KEY = "atlas.session";

function sessionToken(): string | undefined {
  try {
    return window.localStorage.getItem(SESSION_KEY) ?? undefined;
  } catch {
    return memorySession;
  }
}
let memorySession: string | undefined;
function storeSession(token: string): void {
  memorySession = token;
  try {
    window.localStorage.setItem(SESSION_KEY, token);
  } catch {
    // storage blocked: this tab keeps the token in memory
  }
}

async function call<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
  const token = sessionToken() ?? memorySession;
  const headers: Record<string, string> = token ? { "x-atlas-session": token } : {};
  if (method === "POST") headers["content-type"] = "application/json";
  const res = await fetch(url, {
    method,
    credentials: "omit",
    headers,
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const err = (data as { error?: UserFacingError & { message?: string } } | undefined)?.error;
    throw new ApiError(res.status, err && "code" in err ? err : undefined, err?.problem ?? err?.message ?? `HTTP ${res.status}`);
  }
  return data as T;
}

export const getJson = <T>(url: string) => call<T>("GET", url);
export const postJson = <T>(url: string, body?: unknown) => call<T>("POST", url, body);

/** URL with a single-use ticket, for EventSource and downloads (they cannot send headers). */
export async function withTicket(url: string): Promise<string> {
  const { ticket } = await postJson<{ ticket: string }>("/api/ticket");
  return `${url}${url.includes("?") ? "&" : "?"}ticket=${encodeURIComponent(ticket)}`;
}

/** Exchange a launch code from the URL fragment for a session token. */
export async function signIn(): Promise<"ok" | "failed" | "none"> {
  const match = /(?:^#|&)code=([\w-]+)/.exec(window.location.hash);
  if (!match) return "none";
  // Remove the code from the address bar and history before anything else.
  window.history.replaceState(null, "", `${window.location.pathname}#/`);
  try {
    const { session } = await postJson<{ session: string }>("/api/session", { code: match[1] });
    storeSession(session);
    return "ok";
  } catch {
    return "failed";
  }
}

export interface WebApiHooks {
  /** Messages the shell handles itself (prompt, clipboard, source snippets…). */
  onShellMessage(message: HostToWebview): void;
  /** Page-side commands: settings dialog, downloads. */
  onLocalCommand(command: string): boolean;
  onConnection(connected: boolean): void;
}

const SHELL_TYPES = new Set(["prompt", "promptClosed", "clipboard", "sourceSnippet"]);

export interface ProjectConnection {
  api: VsCodeApi;
  /** Open the event stream (and follow tab visibility). */
  start(): void;
  close(): void;
}

/** VsCodeApi for one project over HTTP + SSE. */
export function connectProject(projectId: string, hooks: WebApiHooks): ProjectConnection {
  const base = `/api/p/${projectId}`;
  const stateKey = `atlas.state.${projectId}`;
  let source: EventSource | undefined;
  let wanted = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const deliver = (message: HostToWebview) => {
    if (SHELL_TYPES.has(message.type)) hooks.onShellMessage(message);
    else window.dispatchEvent(new MessageEvent("message", { data: message }));
  };

  const open = () => {
    wanted = true;
    if (source || retry) return;
    void withTicket(`${base}/events`)
      .then((url) => {
        if (!wanted || source) return;
        connect(url);
      })
      .catch(() => {
        hooks.onConnection(false);
        scheduleRetry();
      });
  };
  // The ticket is single-use, so the browser's own reconnect would fail: reconnect with a new one.
  const scheduleRetry = () => {
    if (!wanted || retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      open();
    }, 2000);
  };
  const connect = (url: string) => {
    source = new EventSource(url);
    source.onopen = () => hooks.onConnection(true);
    source.onerror = () => {
      hooks.onConnection(false);
      source?.close();
      source = undefined;
      scheduleRetry();
    };
    source.onmessage = (event: MessageEvent<string>) => {
      try {
        deliver(JSON.parse(event.data) as HostToWebview);
      } catch {
        // malformed event: ignore
      }
    };
  };
  const shut = () => {
    wanted = false;
    if (retry) clearTimeout(retry);
    retry = undefined;
    source?.close();
    source = undefined;
  };
  // Browsers allow ~6 connections per host and each SSE stream holds one: hidden tabs let go of
  // theirs, and ping every 5 minutes instead so the server does not take them for closed.
  let ping: ReturnType<typeof setInterval> | undefined;
  const onVisibility = () => {
    if (document.visibilityState === "hidden") {
      shut();
      ping ??= setInterval(() => void getJson("/api/state").catch(() => undefined), 5 * 60_000);
    } else {
      if (ping) clearInterval(ping);
      ping = undefined;
      open();
    }
  };

  const api: VsCodeApi = {
    postMessage(raw) {
      let message = raw as WebviewToHost;
      if (message.type === "runCommand" && hooks.onLocalCommand(message.command)) return;
      if (message.type === "copyText") {
        hooks.onShellMessage({ type: "clipboard", text: message.text });
        return;
      }
      // No editor in the browser: show the source panel instead.
      if (message.type === "openSource") message = { type: "readSource", ref: message.ref };
      void postJson<HostToWebview[]>(`${base}/msg`, message)
        .then((replies) => {
          for (const r of replies) deliver(r);
        })
        .catch((error: unknown) => {
          const uf = error instanceof ApiError ? error.userFacing : undefined;
          if (uf) deliver({ type: "error", error: uf });
          else if (!(error instanceof ApiError && error.status === 401)) {
            // No structured error (a 500, a dropped connection): still tell the user something failed.
            const zh = document.documentElement.lang.toLowerCase().startsWith("zh");
            deliver({ type: "error", error: { code: "ATLAS-E000", problem: zh ? "操作失败" : "The action failed", cause: error instanceof Error ? error.message : String(error), fix: zh ? "重试一次；仍然失败请查看 ~/.project-atlas/logs 里的日志" : "Try again; if it keeps failing, see the log in ~/.project-atlas/logs", docsUrl: "https://github.com/a805034104/project-atlas/blob/main/docs/errors.md" } });
          }
        });
    },
    getState() {
      try {
        const raw = window.localStorage.getItem(stateKey);
        return raw ? (JSON.parse(raw) as unknown) : undefined;
      } catch {
        return undefined;
      }
    },
    setState(state) {
      try {
        window.localStorage.setItem(stateKey, JSON.stringify(state));
      } catch {
        // storage unavailable: state is just not persisted
      }
    },
  };

  return {
    api,
    start() {
      document.addEventListener("visibilitychange", onVisibility);
      if (document.visibilityState !== "hidden") open();
    },
    close() {
      document.removeEventListener("visibilitychange", onVisibility);
      if (ping) clearInterval(ping);
      ping = undefined;
      shut();
    },
  };
}

/** Answer a prompt (any open tab may answer; the others close it on promptClosed). */
export function answerPrompt(projectId: string, id: string, answer: string[] | null): Promise<unknown> {
  return postJson(`/api/p/${projectId}/msg`, { type: "promptAnswer", id, answer });
}
