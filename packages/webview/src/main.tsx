import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { createBridge } from "./bridge.js";
import { getVsCodeApi } from "./vscode.js";
import "./styles.css";

export function mount(container: HTMLElement): void {
  const vscode = getVsCodeApi();
  createRoot(container).render(
    <StrictMode>
      <App bridge={createBridge(vscode)} vscode={vscode} />
    </StrictMode>,
  );
}

const root = document.getElementById("root");
if (root && document.body.dataset.atlasHost === "web") {
  // Local web app: home page + one map per imported project over HTTP/SSE.
  void import("./web/WebApp.js").then(({ WebApp }) =>
    createRoot(root).render(
      <StrictMode>
        <WebApp />
      </StrictMode>,
    ),
  );
} else if (root) mount(root);
