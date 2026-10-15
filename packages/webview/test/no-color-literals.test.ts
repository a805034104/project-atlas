/**
 * Spec Pass 5: colours come ONLY from --vscode-* tokens. Fails on any hex /
 * rgb() / hsl() literal in the webview sources and in the built stylesheet.
 * The dev-only theme emulation (src/dev/dev-theme.css) is the single exception:
 * it stands in for the variables VS Code injects and is never shipped.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEV_THEME = join(pkg, "src", "dev", "dev-theme.css");
const COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\s*\(/g;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function offenders(files: string[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(COLOR)) out.push(`${relative(pkg, f)}: ${m[0]}`);
  }
  return out;
}

describe("no colour literals", () => {
  it("src/**/*.{ts,tsx,css} use only --vscode-* variables", () => {
    const files = walk(join(pkg, "src")).filter((f) => /\.(tsx?|css)$/.test(f) && f !== DEV_THEME);
    expect(files.length).toBeGreaterThan(10);
    expect(offenders(files)).toEqual([]);
  });

  it("built dist/webview.css (when built) has no colour literals", () => {
    const css = join(pkg, "dist", "webview.css");
    if (!existsSync(css)) return;
    expect(offenders([css])).toEqual([]);
  });

  it("the detector itself catches literals", () => {
    expect("color: #fff; background: rgb(0 0 0)".match(COLOR)).toHaveLength(2);
    expect("color: var(--vscode-foreground)".match(COLOR)).toBeNull();
  });
});
