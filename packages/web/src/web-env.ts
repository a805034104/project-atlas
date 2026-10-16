import type { HostEnv, ViewId } from "@project-atlas/core";
import type { EventHub, PromptBroker } from "./sse.js";
import type { SettingsStore } from "./store.js";

/**
 * HostEnv for one imported project in the web app. Dialogs become prompts answered in the
 * browser; progress shows through analysisState (the page renders phases); the clipboard is
 * written by the page; trust is the flag ticked at import.
 */
export interface WebEnvOptions {
  settings: SettingsStore;
  hub: EventHub;
  prompts: PromptBroker;
  trusted: () => boolean;
  memento: { get<T>(key: string, fallback: T): T; update(key: string, value: unknown): Promise<void> };
  assets: { wasmDir?: string; workerPath?: string };
  log: (line: string) => void;
}

export function webEnv(o: WebEnvOptions): HostEnv {
  return {
    locale: () => o.settings.get().locale,
    settings: () => o.settings.hostSettings(),
    providerConfig: () => Promise.resolve(o.settings.providerConfig()),
    trusted: o.trusted,
    assets: o.assets,
    log: o.log,
    // The page shows phases from analysisState; cancellation arrives as the atlas.cancel command.
    progress: (_title, fn) => fn({ report: () => {}, onCancel: () => {} }),
    choose: async ({ title, items, many }) => (await o.prompts.ask({ kind: "choose", title, items, many })) ?? undefined,
    confirm: async ({ message, detail, action }) => (await o.prompts.ask({ kind: "confirm", message, ...(detail ? { detail } : {}), action }))?.[0] === action,
    input: async ({ prompt, value }) => (await o.prompts.ask({ kind: "input", prompt, ...(value !== undefined ? { value } : {}) }))?.[0],
    notify: async (level, message, actions = []) => {
      // A notice without actions never blocks its caller.
      if (actions.length === 0) return void o.prompts.notice(level, message);
      return (await o.prompts.ask({ kind: "notify", level, message, actions }))?.[0];
    },
    clipboard: async (text) => o.hub.broadcast({ type: "clipboard", text }),
    memento: o.memento,
    reveal: (view: ViewId, nodeId?: string) => o.hub.broadcast({ type: "reveal", view, ...(nodeId ? { nodeId } : {}) }),
  };
}
