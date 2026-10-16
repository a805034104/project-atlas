import { spawn } from "node:child_process";

/**
 * Open the default browser on a 127.0.0.1 URL. No shell: the URL is one argument
 * (Windows: rundll32 url.dll,FileProtocolHandler; macOS: open; Linux: xdg-open).
 */
export function openBrowser(url: string): boolean {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/[\w\-./#=&?%]*$/.test(url)) return false;
  const [command, args] =
    process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    const child = spawn(command as string, args as string[], { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
