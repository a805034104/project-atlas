import { GraphView, type AtlasGraph, type FlowDetailData, type ViewId, type ViewPayload } from "@project-atlas/core";

/**
 * Single-file HTML export (E1): the webview bundle inlined together with every
 * view payload and every flow detail, plus an `acquireVsCodeApi` shim that
 * answers the webview's requests from the embedded data. Opens offline in any
 * browser; nothing is fetched.
 */

const VIEWS: readonly ViewId[] = ["overview", "topology", "modules", "features", "startup", "flow", "history"];

function safeJson(value: unknown): string {
  // Embedded in <script>: neutralize "</script>" and U+2028/2029.
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  return JSON.stringify(value).replace(/</g, "\\u003c").split(LS).join("\\u2028").split(PS).join("\\u2029");
}

export function renderStaticHtml(graph: AtlasGraph, assets: { js: string; css: string }, locale: string): string {
  const view = new GraphView(graph);
  const payloads: Partial<Record<ViewId, ViewPayload>> = {};
  for (const v of VIEWS) payloads[v] = view.view(v);
  const flows: Record<string, FlowDetailData> = {};
  for (const e of graph.entrypoints) {
    const detail = view.flowDetail(e.id);
    if (detail) flows[e.id] = detail;
  }
  const data = {
    locale,
    showTopology: graph.services.length > 1,
    state: { status: "done", completedPhases: ["parse", "rules", "cross-service", "history", "ai"], staleFiles: 0, ai: graph.llmUsage.length > 0 ? "done" : "none" },
    payloads,
    flows,
  };
  const shim = `
(function () {
  var data = window.__ATLAS_STATIC__;
  var state;
  function send(message) { setTimeout(function () { window.dispatchEvent(new MessageEvent("message", { data: message })); }, 0); }
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (msg) {
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "ready") send({ type: "init", locale: data.locale, state: data.state, showTopology: data.showTopology });
        else if (msg.type === "requestView" && data.payloads[msg.view]) send({ type: "viewData", payload: data.payloads[msg.view] });
        else if (msg.type === "requestFlow" && data.flows[msg.entrypointId]) send({ type: "flowDetail", data: data.flows[msg.entrypointId] });
        else if (msg.type === "copyText" && navigator.clipboard) navigator.clipboard.writeText(msg.text);
      },
      getState: function () { return state; },
      setState: function (s) { state = s; }
    };
  };
})();`;
  return `<!doctype html>
<html lang="${locale.startsWith("zh") ? "zh-CN" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(graph.project.name)} · ProjectAtlas</title>
<style>
:root{--vscode-font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;--vscode-editor-font-family:ui-monospace,Consolas,monospace;--vscode-font-size:13px;--vscode-editor-background:#1e1e1e;--vscode-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-focusBorder:#0078d4;--vscode-contrastBorder:transparent;--vscode-textLink-foreground:#4daafc;--vscode-button-background:#0078d4;--vscode-button-foreground:#ffffff;--vscode-button-hoverBackground:#026ec1;--vscode-button-secondaryBackground:#313131;--vscode-button-secondaryForeground:#cccccc;--vscode-input-background:#313131;--vscode-input-foreground:#cccccc;--vscode-input-border:#3c3c3c;--vscode-list-hoverBackground:#2a2d2e;--vscode-list-activeSelectionBackground:#04395e;--vscode-list-activeSelectionForeground:#ffffff;--vscode-panel-border:#2b2b2b;--vscode-editorWidget-background:#202020;--vscode-editorWarning-foreground:#cca700;--vscode-editorError-foreground:#f85149;--vscode-charts-blue:#3794ff;--vscode-charts-green:#89d185;--vscode-charts-yellow:#cca700;--vscode-charts-orange:#d18616;--vscode-charts-red:#f14c4c;--vscode-charts-purple:#b180d7}
@media (prefers-color-scheme: light){:root{--vscode-editor-background:#ffffff;--vscode-foreground:#3b3b3b;--vscode-descriptionForeground:#717171;--vscode-input-background:#ffffff;--vscode-input-foreground:#3b3b3b;--vscode-input-border:#cecece;--vscode-list-hoverBackground:#f2f2f2;--vscode-list-activeSelectionBackground:#e8e8e8;--vscode-list-activeSelectionForeground:#000000;--vscode-panel-border:#e5e5e5;--vscode-editorWidget-background:#f8f8f8;--vscode-button-secondaryBackground:#e5e5e5;--vscode-button-secondaryForeground:#3b3b3b}}
body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}
</style>
<style>${assets.css}</style>
</head>
<body>
<div id="root"></div>
<script>window.__ATLAS_STATIC__ = ${safeJson(data)};</script>
<script>${shim}</script>
<script>${assets.js.replace(/<\/script/gi, "<\\/script")}</script>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
