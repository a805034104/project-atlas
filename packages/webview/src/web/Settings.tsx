import { useState } from "react";
import { ApiError, postJson } from "./api.js";
import type { WebT } from "./strings.js";
import { Dialog, type WebSettingsView } from "./WebApp.js";

/** Language + optional AI provider. The key is write-only: the page only learns whether one is stored. */
export function SettingsDialog({ t, settings, dataDir, onClose, onSaved }: { t: WebT; settings: WebSettingsView; dataDir: string; onClose: () => void; onSaved: (s: WebSettingsView) => void }) {
  const [locale, setLocale] = useState(settings.locale.startsWith("zh") ? "zh-cn" : "en");
  const [provider, setProvider] = useState(settings.provider);
  const [model, setModel] = useState(settings.model);
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<string | undefined>();
  const needsKey = provider === "anthropic" || provider === "openai-compatible";

  const save = async (): Promise<WebSettingsView | undefined> => {
    try {
      const next = await postJson<WebSettingsView>("/api/settings", { locale, provider, model, baseUrl, ...(apiKey ? { apiKey } : {}) });
      setApiKey("");
      onSaved(next);
      setStatus(t("settings.saved"));
      return next;
    } catch (e) {
      setStatus((e as Error).message);
      return undefined;
    }
  };

  const test = async () => {
    if (!(await save())) return;
    setStatus(t("settings.testing"));
    try {
      const r = await postJson<{ ok: boolean; model?: string; error?: { code?: string; problem?: string; cause?: string; message?: string } }>("/api/settings/test", {});
      setStatus(r.ok ? t("settings.testOk", { model: r.model ?? "" }) : `${r.error?.code ?? ""} ${r.error?.problem ?? r.error?.message ?? ""} ${r.error?.cause ?? ""}`.trim());
    } catch (e) {
      setStatus(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <Dialog title={t("settings.title")} onClose={onClose} wide>
      <form
        className="web-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label>
          <span>{t("settings.language")}</span>
          <select value={locale} onChange={(e) => setLocale(e.target.value)}>
            <option value="zh-cn">中文</option>
            <option value="en">English</option>
          </select>
        </label>
        <fieldset>
          <legend>{t("settings.ai")}</legend>
          <label>
            <span>{t("settings.provider")}</span>
            <select value={provider} onChange={(e) => setProvider(e.target.value as WebSettingsView["provider"])}>
              <option value="none">{t("settings.none")}</option>
              <option value="anthropic">{t("settings.anthropic")}</option>
              <option value="openai-compatible">{t("settings.openai")}</option>
              <option value="ollama">{t("settings.ollama")}</option>
            </select>
          </label>
          {provider !== "none" ? (
            <>
              <label>
                <span>{t("settings.model")}</span>
                <input className="web-input" value={model} onChange={(e) => setModel(e.target.value)} placeholder={provider === "anthropic" ? "claude-sonnet-5-5" : provider === "ollama" ? "qwen2.5-coder:7b" : "deepseek-chat"} />
              </label>
              {provider !== "anthropic" ? (
                <label>
                  <span>{t("settings.baseUrl")}</span>
                  <input className="web-input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={provider === "ollama" ? "http://localhost:11434" : "https://api.deepseek.com/v1"} />
                </label>
              ) : null}
              {needsKey ? (
                <label>
                  <span>{t("settings.apiKey")}</span>
                  <input className="web-input" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={settings.keyStored[provider] ? t("settings.keyStored") : ""} />
                  <small className="muted">{t("settings.keyNote", { dir: dataDir })}</small>
                </label>
              ) : null}
            </>
          ) : null}
        </fieldset>
        {status ? (
          <p className="muted" role="status">
            {status}
          </p>
        ) : null}
        <div className="web-actions">
          {provider !== "none" ? (
            <button type="button" className="secondary" onClick={() => void test()}>
              {t("settings.test")}
            </button>
          ) : null}
          <button type="button" className="secondary" onClick={onClose}>
            {t("settings.close")}
          </button>
          <button type="submit" className="primary">
            {t("settings.save")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
