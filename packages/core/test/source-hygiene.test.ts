import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** Guards against invisible control characters (e.g. a literal backspace instead of `\b`) sneaking into sources. */
function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* sources(full);
    else if (/\.(ts|tsx|mts|cjs|mjs|json|css)$/.test(name)) yield full;
  }
}

describe("source hygiene", () => {
  it("has no control characters other than tab/newline/carriage return", () => {
    const offenders: string[] = [];
    for (const pkg of ["core", "vscode", "webview", "cli", "mcp"]) {
      for (const file of sources(path.resolve("packages", pkg, "src"))) {
        const text = readFileSync(file, "utf8");
        // eslint-disable-next-line no-control-regex
        const m = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.exec(text);
        if (m) offenders.push(`${file}: U+${m[0].charCodeAt(0).toString(16).padStart(4, "0")} at offset ${m.index}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
