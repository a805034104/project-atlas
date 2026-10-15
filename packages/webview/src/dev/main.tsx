// Dev entry (index.dev.html): emulated VS Code theme + mock host, then the real webview entry.
import "./dev-theme.css";
import { installMockHost } from "./mockHost.js";

if (new URLSearchParams(location.search).get("theme") === "light") document.body.className = "vscode-light";
installMockHost();
await import("../main.js");
