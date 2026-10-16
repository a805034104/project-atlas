import { useEffect, useState } from "react";
import { ApiError, getJson, postJson } from "./api.js";
import type { WebT } from "./strings.js";
import { Dialog, importProject, type AppStateResponse, type ProjectRecord } from "./WebApp.js";

/**
 * Home: import a folder (path box is the main control: Windows users paste from Explorer),
 * a folder picker, the trust checkbox, and recent projects (newest first, at most 8).
 */

interface DirListing {
  path: string;
  parent?: string;
  dirs: { name: string; path: string; project: boolean }[];
  roots: { label: string; path: string }[];
}

function middleTruncate(text: string, max = 64): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 1) / 2);
  return `${text.slice(0, half)}…${text.slice(-half)}`;
}

function formatTime(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(locale.startsWith("zh") ? "zh-CN" : "en-CA", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function Home({ app, t, onChanged }: { app: AppStateResponse; t: WebT; onChanged: () => Promise<void> }) {
  const [input, setInput] = useState("");
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState<"" | "import" | "clone">("");
  const [error, setError] = useState<string | undefined>();
  const [picker, setPicker] = useState(false);
  const recent = app.projects.slice(0, 8);

  const submit = async (value: string) => {
    if (!value.trim()) return;
    setError(undefined);
    setBusy(/^(https:\/\/|git@)/.test(value.trim()) ? "clone" : "import");
    try {
      const { record, warning } = await importProject(value, trusted);
      if (warning === "broad-root") {
        try {
          window.sessionStorage.setItem("atlas.notice", t("home.broad"));
        } catch {
          // no storage: skip the notice
        }
      }
      await onChanged();
      window.location.hash = `#/p/${record.id}?analyze`;
    } catch (e) {
      const uf = e instanceof ApiError ? e.userFacing : undefined;
      setError(uf ? `${uf.code} ${uf.cause}` : (e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const remove = async (p: ProjectRecord) => {
    await postJson(`/api/projects/${p.id}/remove`, {});
    await onChanged();
  };

  return (
    <main className="web-home">
      <section className="web-card web-import" aria-labelledby="import-title">
        <h1 id="import-title">{t("home.title")}</h1>
        <p className="muted">{t("home.subtitle")}</p>
        <form
          className="web-import-row"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(input);
          }}
        >
          <input
            className="web-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t("home.input")}
            aria-label={t("home.input")}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "import-error" : undefined}
            spellCheck={false}
            autoFocus
          />
          <button type="button" className="secondary" onClick={() => setPicker(true)}>
            {t("home.browse")}
          </button>
          <button type="submit" className="primary" disabled={busy !== "" || !input.trim()}>
            {busy === "clone" ? t("home.cloning") : busy === "import" ? t("home.importing") : t("home.import")}
          </button>
        </form>
        {error ? (
          <p id="import-error" className="web-error" role="alert">
            {error}
          </p>
        ) : null}
        <label className="web-trust">
          <input type="checkbox" checked={trusted} onChange={(e) => setTrusted(e.target.checked)} />
          <span>{t("home.trust")}</span>
        </label>
        <p className="muted small">{t("home.trustNote")}</p>
      </section>

      <section className="web-card" aria-labelledby="recent-title">
        <h2 id="recent-title">{t("home.recent")}</h2>
        {recent.length === 0 ? (
          <p className="muted">{t("home.empty")}</p>
        ) : (
          <ul className="web-recent">
            {recent.map((p) => (
              <li key={p.id}>
                <a className="web-recent-main" href={`#/p/${p.id}`}>
                  <span className="web-recent-name">{p.name}</span>
                  <span className="muted web-recent-path" title={p.path}>
                    {p.gitUrl ?? middleTruncate(p.path)}
                  </span>
                </a>
                <span className="muted small">{formatTime(p.openedAt, app.settings.locale)}</span>
                {p.storage === "home" ? (
                  <span className="web-badge" title={t("home.storageHome")}>
                    ~/.project-atlas
                  </span>
                ) : null}
                <a className="secondary small web-button-link" href={`#/p/${p.id}`}>
                  {t("home.open")}
                </a>
                <button type="button" className="link small" onClick={() => void remove(p)}>
                  {t("home.remove")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="web-footer muted small">{t("home.footer", { version: app.version, dir: app.dataDir })}</footer>

      {picker ? (
        <FolderPicker
          t={t}
          onClose={() => setPicker(false)}
          onChoose={(dir) => {
            setPicker(false);
            setInput(dir);
          }}
        />
      ) : null}
    </main>
  );
}

function FolderPicker({ t, onClose, onChoose }: { t: WebT; onClose: () => void; onChoose: (dir: string) => void }) {
  const [listing, setListing] = useState<DirListing | undefined>();
  const load = (dir?: string) => void getJson<DirListing>(`/api/fs/dirs${dir ? `?path=${encodeURIComponent(dir)}` : ""}`).then(setListing, () => undefined);
  useEffect(() => load(), []);
  return (
    <Dialog title={t("picker.title")} onClose={onClose} wide>
      {listing ? (
        <>
          <div className="web-picker-roots">
            {listing.roots.map((r) => (
              <button key={r.path} type="button" className="secondary small" onClick={() => load(r.path)}>
                {r.label}
              </button>
            ))}
            {listing.parent ? (
              <button type="button" className="secondary small" onClick={() => load(listing.parent)}>
                ↑ {t("picker.up")}
              </button>
            ) : null}
          </div>
          <code className="web-picker-path">{listing.path}</code>
          <ul className="web-picker-list">
            {listing.dirs.length === 0 ? <li className="muted">{t("picker.empty")}</li> : null}
            {listing.dirs.map((d) => (
              <li key={d.path}>
                <button type="button" className="web-choice" onDoubleClick={() => onChoose(d.path)} onClick={() => load(d.path)}>
                  📁 {d.name}
                  {d.project ? <span className="web-badge">{t("picker.project")}</span> : null}
                </button>
              </li>
            ))}
          </ul>
          <div className="web-actions">
            <button type="button" className="secondary" onClick={onClose}>
              {t("prompt.cancel")}
            </button>
            <button type="button" className="primary" onClick={() => onChoose(listing.path)}>
              {t("picker.choose")}
            </button>
          </div>
        </>
      ) : (
        <p className="muted">{t("source.loading")}</p>
      )}
    </Dialog>
  );
}
