import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HostPrompt, HostToWebview, SourceSnippet } from "@project-atlas/core";
import { App } from "../App.js";
import { createBridge } from "../bridge.js";
import { answerPrompt, connectProject, getJson, postJson, signIn, withTicket, type ProjectConnection } from "./api.js";
import { Home } from "./Home.js";
import { SettingsDialog } from "./Settings.js";
import { webT, type WebT } from "./strings.js";
import "./web.css";

/**
 * The local web app shell.
 *
 *   #/            home: import a project, recent projects
 *   #/p/<id>      the map (the same <App> as in VS Code) over HTTP + SSE
 *   overlays      prompts (AI cost, clone confirmation, service pick), notices, source drawer,
 *                 clipboard fallback, settings
 */

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  storage: "repo" | "home";
  source: "local" | "git";
  gitUrl?: string;
  trusted: boolean;
  addedAt: string;
  openedAt: string;
}

export interface WebSettingsView {
  locale: string;
  provider: "none" | "anthropic" | "openai-compatible" | "ollama";
  model: string;
  baseUrl: string;
  keyStored: Record<string, boolean>;
  [key: string]: unknown;
}

export interface AppStateResponse {
  version: string;
  dataDir: string;
  projects: ProjectRecord[];
  settings: WebSettingsView;
}

type Theme = "system" | "light" | "dark";

function readTheme(): Theme {
  try {
    const t = window.localStorage.getItem("atlas.theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

function applyTheme(theme: Theme): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem("atlas.theme", theme);
  } catch {
    // not persisted
  }
}

function route(): { page: "home" } | { page: "project"; id: string; analyze: boolean } {
  const m = /^#\/p\/([0-9a-f]{16})(\?analyze)?/.exec(window.location.hash);
  return m ? { page: "project", id: m[1] as string, analyze: Boolean(m[2]) } : { page: "home" };
}

export function WebApp() {
  const [signedIn, setSignedIn] = useState<"pending" | "ok" | "failed">("pending");
  const [app, setApp] = useState<AppStateResponse | undefined>();
  const [where, setWhere] = useState(route);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const t = useMemo(() => webT(app?.settings.locale ?? navigator.language), [app?.settings.locale]);

  useEffect(() => applyTheme(theme), [theme]);

  const refresh = useCallback(async () => {
    try {
      setApp(await getJson<AppStateResponse>("/api/state"));
      setSignedIn("ok");
    } catch {
      setSignedIn("failed");
    }
  }, []);

  useEffect(() => {
    void signIn().then(() => refresh());
    const onHash = () => {
      // A newer launch (second double-click) can hand this tab a fresh code.
      if (/(?:^#|&)code=/.test(window.location.hash)) void signIn().then(() => refresh());
      setWhere(route());
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [refresh]);

  useEffect(() => {
    document.documentElement.lang = (app?.settings.locale ?? "en").startsWith("zh") ? "zh-CN" : "en";
  }, [app?.settings.locale]);

  if (signedIn === "pending") return <div className="web-loading" aria-busy="true" />;
  if (signedIn === "failed" || !app) {
    return (
      <div className="web-center">
        <div className="web-card" role="alert">
          <p>{t("signin.failed")}</p>
        </div>
      </div>
    );
  }

  const project = where.page === "project" ? app.projects.find((p) => p.id === where.id) : undefined;
  const header = (
    <header className="web-header">
      <a className="web-brand" href="#/" aria-label={t("nav.home")}>
        <span className="web-logo" aria-hidden="true">▲</span> ProjectAtlas
      </a>
      {project ? (
        <span className="web-crumb" title={project.path}>
          / {project.name}
        </span>
      ) : null}
      <span className="web-spacer" />
      <label className="web-theme">
        <span className="visually-hidden">{t("nav.theme")}</span>
        <select value={theme} onChange={(e) => setTheme(e.target.value as Theme)} aria-label={t("nav.theme")}>
          <option value="system">{t("theme.system")}</option>
          <option value="light">{t("theme.light")}</option>
          <option value="dark">{t("theme.dark")}</option>
        </select>
      </label>
      <button type="button" className="secondary small" onClick={() => setSettingsOpen(true)}>
        {t("nav.settings")}
      </button>
    </header>
  );

  return (
    <div className="web-app">
      {header}
      {where.page === "project" && project ? (
        <ProjectPage key={project.id} project={project} autoAnalyze={where.analyze} t={t} openSettings={() => setSettingsOpen(true)} onSignedOut={() => setSignedIn("failed")} />
      ) : (
        <Home app={app} t={t} onChanged={refresh} />
      )}
      {settingsOpen ? (
        <SettingsDialog
          t={t}
          settings={app.settings}
          dataDir={app.dataDir}
          onClose={() => setSettingsOpen(false)}
          onSaved={(settings) => setApp({ ...app, settings })}
        />
      ) : null}
    </div>
  );
}

function ProjectPage({ project, autoAnalyze, t, openSettings, onSignedOut }: { project: ProjectRecord; autoAnalyze: boolean; t: WebT; openSettings: () => void; onSignedOut: () => void }) {
  const [prompts, setPrompts] = useState<HostPrompt[]>(() => {
    try {
      const notice = window.sessionStorage.getItem("atlas.notice");
      window.sessionStorage.removeItem("atlas.notice");
      return notice ? [{ id: "notice", kind: "notify", level: "warning", message: notice, actions: [] }] : [];
    } catch {
      return [];
    }
  });
  const [snippet, setSnippet] = useState<SourceSnippet | "loading" | undefined>();
  const [clip, setClip] = useState<string | undefined>();
  const [connected, setConnected] = useState(true);
  const connection = useRef<ProjectConnection | undefined>(undefined);
  const askedAnalyze = useRef(false);

  if (!connection.current) {
    connection.current = connectProject(project.id, {
      onShellMessage: (m: HostToWebview) => {
        if (m.type === "prompt") setPrompts((list) => (list.some((p) => p.id === m.prompt.id) ? list : [...list, m.prompt]));
        else if (m.type === "promptClosed") setPrompts((list) => list.filter((p) => p.id !== m.id));
        else if (m.type === "sourceSnippet") setSnippet(m.data);
        else if (m.type === "clipboard") {
          const text = m.text;
          navigator.clipboard?.writeText(text).then(
            () => setPrompts((list) => [...list, { id: `copied-${Date.now()}`, kind: "notify", level: "info", message: t("clipboard.copied"), actions: [] }]),
            () => setClip(text),
          ) ?? setClip(text);
        }
      },
      onLocalCommand: (command) => {
        if (command === "atlas.configureProvider") {
          openSettings();
          return true;
        }
        const format = command === "atlas.exportHtml" ? "html" : command === "atlas.exportMarkdown" ? "md" : command === "atlas.diagnose" ? "diagnostics" : undefined;
        if (format) {
          void withTicket(`/api/p/${project.id}/export?format=${format}`).then((url) => window.location.assign(url));
          return true;
        }
        return false;
      },
      onConnection: (up) => {
        setConnected(up);
        // The snapshot that follows a (re)connect lists every open prompt: drop ones that closed meanwhile.
        if (up) setPrompts([]);
        // EventSource hides the status: ask whether the session itself is gone (server restarted).
        if (!up) void getJson("/api/state").catch((e: unknown) => (e as { status?: number }).status === 401 && onSignedOut());
      },
    });
  }
  const conn = connection.current;
  const bridge = useMemo(() => createBridge(conn.api), [conn]);

  useEffect(() => {
    conn.start();
    return () => conn.close();
  }, [conn]);

  // Just imported: start the analysis as soon as the host says it has never run.
  useEffect(() => {
    if (!autoAnalyze) return;
    const onMessage = (e: MessageEvent<unknown>) => {
      const m = e.data as HostToWebview;
      if (askedAnalyze.current || m?.type !== "init" || m.state.status !== "never") return;
      askedAnalyze.current = true;
      conn.api.postMessage({ type: "runCommand", command: "atlas.analyze" });
      window.history.replaceState(null, "", `#/p/${project.id}`);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [autoAnalyze, conn, project.id]);

  // Toasts without actions disappear after a while.
  useEffect(() => {
    const quiet = prompts.filter((p) => p.kind === "notify" && p.actions.length === 0);
    if (quiet.length === 0) return;
    const timer = setTimeout(() => setPrompts((list) => list.filter((p) => !quiet.includes(p))), 6000);
    return () => clearTimeout(timer);
  }, [prompts]);

  const answer = (prompt: HostPrompt, value: string[] | null) => {
    setPrompts((list) => list.filter((p) => p.id !== prompt.id));
    if (!(prompt.kind === "notify" && prompt.actions.length === 0)) void answerPrompt(project.id, prompt.id, value);
  };

  const modal = prompts.find((p) => p.kind !== "notify");
  const toasts = prompts.filter((p) => p.kind === "notify");

  return (
    <div className={`web-project${snippet ? " with-drawer" : ""}`}>
      {!connected ? (
        <div className="web-offline" role="status">
          {t("conn.lost")}
        </div>
      ) : null}
      <div className="web-map">
        <App bridge={bridge} vscode={conn.api} />
      </div>
      {snippet ? <SourceDrawer snippet={snippet} t={t} onClose={() => setSnippet(undefined)} /> : null}
      {modal ? <PromptDialog key={modal.id} prompt={modal} t={t} onAnswer={(v) => answer(modal, v)} /> : null}
      {toasts.length > 0 ? (
        <div className="web-toasts" role="status" aria-live="polite">
          {toasts.map((p) =>
            p.kind === "notify" ? (
              <div key={p.id} className={`web-toast ${p.level}`}>
                <span>{p.message}</span>
                {p.actions.map((a) => (
                  <button key={a} type="button" className="secondary small" onClick={() => answer(p, [a])}>
                    {a}
                  </button>
                ))}
                <button type="button" className="link" aria-label={t("prompt.dismiss")} onClick={() => answer(p, null)}>
                  ✕
                </button>
              </div>
            ) : null,
          )}
        </div>
      ) : null}
      {clip !== undefined ? <ClipboardDialog text={clip} t={t} onClose={() => setClip(undefined)} /> : null}
    </div>
  );
}

function Dialog({ title, children, onClose, wide = false }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  // onClose is a new closure on every render: keep the latest in a ref so focus is set once, on open.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, []);
  return (
    <div className="web-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`web-dialog${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export { Dialog };

function PromptDialog({ prompt, t, onAnswer }: { prompt: HostPrompt; t: WebT; onAnswer: (value: string[] | null) => void }) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(prompt.kind === "choose" ? prompt.items.filter((i) => i.picked).map((i) => i.id) : []));
  const [text, setText] = useState(prompt.kind === "input" ? (prompt.value ?? "") : "");
  const cancel = () => onAnswer(null);
  if (prompt.kind === "choose") {
    return (
      <Dialog title={prompt.title} onClose={cancel} wide>
        <ul className="web-choices">
          {prompt.items.map((item) => (
            <li key={item.id}>
              {prompt.many ? (
                <label>
                  <input
                    type="checkbox"
                    checked={picked.has(item.id)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(item.id);
                      else next.delete(item.id);
                      setPicked(next);
                    }}
                  />
                  <span className="web-choice-label">{item.label}</span>
                  {item.description ? <span className="muted"> {item.description}</span> : null}
                </label>
              ) : (
                <button type="button" className="web-choice" onClick={() => onAnswer([item.id])}>
                  <span className="web-choice-label">{item.label}</span>
                  {item.description ? <span className="muted"> {item.description}</span> : null}
                </button>
              )}
            </li>
          ))}
        </ul>
        <div className="web-actions">
          <button type="button" className="secondary" onClick={cancel}>
            {t("prompt.cancel")}
          </button>
          {prompt.many ? (
            <button type="button" className="primary" onClick={() => onAnswer([...picked])}>
              {t("prompt.ok")}
            </button>
          ) : null}
        </div>
      </Dialog>
    );
  }
  if (prompt.kind === "confirm") {
    return (
      <Dialog title={prompt.message} onClose={cancel}>
        {prompt.detail ? <pre className="web-detail">{prompt.detail}</pre> : null}
        <div className="web-actions">
          <button type="button" className="secondary" onClick={cancel}>
            {t("prompt.cancel")}
          </button>
          <button type="button" className="primary" onClick={() => onAnswer([prompt.action])}>
            {prompt.action}
          </button>
        </div>
      </Dialog>
    );
  }
  if (prompt.kind === "input") {
    return (
      <Dialog title={prompt.prompt} onClose={cancel}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onAnswer([text]);
          }}
        >
          <input className="web-input" value={text} onChange={(e) => setText(e.target.value)} aria-label={prompt.prompt} />
          <div className="web-actions">
            <button type="button" className="secondary" onClick={cancel}>
              {t("prompt.cancel")}
            </button>
            <button type="submit" className="primary">
              {t("prompt.ok")}
            </button>
          </div>
        </form>
      </Dialog>
    );
  }
  return null;
}

function SourceDrawer({ snippet, t, onClose }: { snippet: SourceSnippet | "loading"; t: WebT; onClose: () => void }) {
  const target = useRef<HTMLLIElement>(null);
  useEffect(() => {
    target.current?.scrollIntoView({ block: "center" });
  }, [snippet]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (snippet === "loading") return <aside className="web-drawer">{t("source.loading")}</aside>;
  const line = snippet.ref.line ?? 1;
  const abs = snippet.absolutePath;
  const message = snippet.error === "outside-project" ? t("source.outside") : snippet.error === "not-found" ? t("source.notFound") : snippet.error === "too-large" ? t("source.tooLarge") : snippet.error === "binary" ? t("source.binary") : undefined;
  return (
    <aside className="web-drawer" aria-label={t("source.title")}>
      <div className="web-drawer-head">
        <code title={abs}>
          {snippet.ref.file}
          {snippet.ref.line ? `:${snippet.ref.line}` : ""}
        </code>
        <span className="web-spacer" />
        {abs ? (
          <>
            <a href={`vscode://file/${encodeURI(abs.replace(/\\/g, "/"))}:${line}`}>{t("source.openVscode")}</a>
            <a href={`idea://open?file=${encodeURIComponent(abs)}&line=${line}`}>{t("source.openIdea")}</a>
          </>
        ) : null}
        <button type="button" className="secondary small" onClick={onClose} aria-label={t("source.close")}>
          ✕
        </button>
      </div>
      {message ? (
        <p className="muted web-drawer-msg">{message}</p>
      ) : (
        <ol className="web-code" start={snippet.startLine}>
          {snippet.lines.map((text, i) => {
            const n = snippet.startLine + i;
            return (
              <li key={n} ref={n === line ? target : undefined} className={n === line ? "target" : undefined}>
                <code>{text || " "}</code>
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}

function ClipboardDialog({ text, t, onClose }: { text: string; t: WebT; onClose: () => void }) {
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => area.current?.select(), []);
  return (
    <Dialog title={t("clipboard.title")} onClose={onClose} wide>
      <p className="muted">{t("clipboard.note")}</p>
      <textarea ref={area} className="web-input web-textarea" readOnly value={text} />
      <div className="web-actions">
        <button
          type="button"
          className="primary"
          onClick={() => {
            area.current?.select();
            void navigator.clipboard?.writeText(text).then(onClose, () => document.execCommand("copy"));
          }}
        >
          {t("clipboard.copy")}
        </button>
        <button type="button" className="secondary" onClick={onClose}>
          {t("settings.close")}
        </button>
      </div>
    </Dialog>
  );
}

export async function importProject(input: string, trusted: boolean): Promise<{ record: ProjectRecord; warning?: string }> {
  return postJson("/api/projects", { input, trusted });
}
