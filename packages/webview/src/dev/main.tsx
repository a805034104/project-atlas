// Dev entry (index.dev.html): emulated VS Code theme + mock host, then the real webview entry.
import "./dev-theme.css";
import { installMockHost } from "./mockHost.js";

// The body classes VS Code sets per theme kind.
const THEMES: Record<string, string> = { light: "vscode-light", "hc-dark": "vscode-high-contrast", "hc-light": "vscode-high-contrast-light vscode-high-contrast" };
const theme = THEMES[new URLSearchParams(location.search).get("theme") ?? ""];
if (theme) document.body.className = theme;
// ?bare=1: no scenario bar (screenshots, scripts/theme-shots.mjs).
if (new URLSearchParams(location.search).get("bare") === "1") document.querySelector(".dev-scenarios")?.remove();
installMockHost();
await import("../main.js");
