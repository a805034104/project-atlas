// E2E: launch a real VS Code with the built extension on a copy of the RuoYi
// fixtures (multi-root) and run e2e/suite.cjs inside the extension host.
//   npm run build -w @project-atlas/webview && npm run build -w projectatlas && node packages/vscode/e2e/run.mjs
import { runTests } from "@vscode/test-electron";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const work = mkdtempSync(path.join(tmpdir(), "atlas-e2e-"));
for (const name of ["ruoyi-vue", "ruoyi-vue3"]) {
  cpSync(path.join(repo, "fixtures/repos", name), path.join(work, name), { recursive: true, filter: (src) => !src.includes(`${path.sep}.git${path.sep}`) && !src.endsWith(`${path.sep}.git`) });
}
const workspaceFile = path.join(work, "ruoyi.code-workspace");
writeFileSync(workspaceFile, JSON.stringify({ folders: [{ path: "ruoyi-vue" }, { path: "ruoyi-vue3" }], settings: { "atlas.llm.provider": "none", "atlas.analysis.history": false } }, null, 2));

// Trusted workspace (runtime tracing is disabled in Restricted Mode) and the locally cached
// pinned javaagent, so the runtime part runs offline.
const agent = path.join(homedir(), ".project-atlas", "agents", "opentelemetry-javaagent-2.31.1.jar");
mkdirSync(path.join(work, ".user", "User"), { recursive: true });
writeFileSync(
  path.join(work, ".user", "User", "settings.json"),
  JSON.stringify({ "security.workspace.trust.enabled": false, ...(existsSync(agent) ? { "atlas.runtime.javaagentPath": agent } : {}) }, null, 2),
);

try {
  await runTests({
    extensionDevelopmentPath: path.resolve(here, ".."),
    extensionTestsPath: path.join(here, "suite.cjs"),
    launchArgs: [workspaceFile, "--disable-extensions", "--skip-welcome", "--skip-release-notes", `--user-data-dir=${path.join(work, ".user")}`],
    extensionTestsEnv: {
      ATLAS_E2E_CORE: path.join(repo, "packages/core/dist/index.js"),
      ATLAS_E2E_GOLDEN: path.join(repo, "fixtures/runtime/ruoyi-vue-2.31.1/raw"),
      ATLAS_E2E_AGENT: existsSync(agent) ? agent : "",
      PROJECT_ATLAS_HOME: path.join(work, ".atlas-home"),
    },
  });
  console.log("E2E passed");
} finally {
  rmSync(work, { recursive: true, force: true });
}
