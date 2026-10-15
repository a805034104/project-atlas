// Clone the pinned upstream fixtures listed in fixtures/fixtures.json into fixtures/repos.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const manifest = JSON.parse(readFileSync("fixtures/fixtures.json", "utf8"));
mkdirSync("fixtures/repos", { recursive: true });
for (const [name, spec] of Object.entries(manifest)) {
  if (name.startsWith("_")) continue;
  const dir = path.join("fixtures/repos", name);
  if (!existsSync(dir)) execFileSync("git", ["clone", "--branch", spec.branch, "--", spec.url, dir], { stdio: "inherit" });
  execFileSync("git", ["-C", dir, "fetch", "--depth", "1", "origin", spec.commit], { stdio: "inherit" });
  execFileSync("git", ["-C", dir, "checkout", "--quiet", spec.commit], { stdio: "inherit" });
}
