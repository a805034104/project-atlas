import type { HostToWebview, UserFacingError, WebviewToHost } from "@project-atlas/core";
import type { VsCodeApi } from "../vscode.js";

/**
 * Browser side of the local web app.
 *
 *   #code=<one-time> ─POST /api/session▶ HttpOnly cookie, fragment removed from history
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

async function call<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) } : {}),
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

/** Exchange a launch code from the URL fragment for a session cookie. */
export async function signIn(): Promise<"ok" | "failed" | "none"> {
  const match = /(?:^#|&)code=([\w-]+)/.exec(window.location.hash);
  if (!match) return "none";
  // Remove the code from the address bar and history before anything else.
  window.history.replaceState(null, "", `${window.location.pathname}#/`);
  try {
    await postJson("/api/session", { code: match[1] });
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

  const deliver = (message: HostToWebview) => {
    if (SHELL_TYPES.has(message.type)) hooks.onShellMessage(message);
    else window.dispatchEvent(new MessageEvent("message", { data: message }));
  };

  const open = () => {
    if (source) return;
    source = new EventSource(`${base}/events`);
    source.onopen = () => hooks.onConnection(true);
    source.onerror = () => hooks.onConnection(false);
    source.onmessage = (event: MessageEvent<string>) => {
      try {
        deliver(JSON.parse(event.data) as HostToWebview);
      } catch {
        // malformed event: ignore
      }
    };
  };
  const shut = () => {
    source?.close();
    source = undefined;
  };
  // Browsers allow ~6 connections per host and each SSE stream holds one: hidden tabs let go of theirs.
  const onVisibility = () => (document.visibilityState === "hidden" ? shut() : open());

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
      shut();
    },
  };
}

/** Answer a prompt (any open tab may answer; the others close it on promptClosed). */
export function answerPrompt(projectId: string, id: string, answer: string[] | null): Promise<unknown> {
  return postJson(`/api/p/${projectId}/msg`, { type: "promptAnswer", id, answer });
}
