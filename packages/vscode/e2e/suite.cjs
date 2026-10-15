// Runs inside the VS Code extension host (see e2e/run.mjs). Plain assertions, no test framework.
const vscode = require("vscode");
const path = require("node:path");
const { existsSync } = require("node:fs");
const { pathToFileURL } = require("node:url");

function assert(condition, message) {
  if (!condition) throw new Error(`E2E assertion failed: ${message}`);
  console.log(`  ✓ ${message}`);
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout waiting for ${label}`);
}

exports.run = async function run() {
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === "projectatlas");
  assert(ext, "extension is installed");
  await ext.activate();
  assert(ext.isActive, "extension activates");

  const commands = await vscode.commands.getCommands(true);
  for (const id of ["atlas.analyze", "atlas.openPanel", "atlas.configureProvider", "atlas.exportHtml", "atlas.exportMarkdown", "atlas.diagnose", "atlas.revealInAtlas"]) {
    assert(commands.includes(id), `command ${id} registered`);
  }

  const backend = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const started = Date.now();
  await vscode.commands.executeCommand("atlas.analyze");
  const meta = path.join(backend, ".atlas", "graph", "meta.json");
  await waitFor(() => existsSync(meta), 60_000, ".atlas/graph/meta.json");
  const elapsed = Date.now() - started;
  assert(elapsed < 60_000, `no-key analysis finished in ${elapsed} ms (AC-DX1 < 60 s)`);

  const core = await import(pathToFileURL(process.env.ATLAS_E2E_CORE).href);
  const stored = await core.loadStoredGraph(path.join(backend, ".atlas"));
  assert(stored.status === "ok", "stored graph loads");
  const graph = stored.graph;
  const http = graph.entrypoints.filter((e) => e.kind === "http");
  assert(http.length === 148, `148 HTTP entrypoints (got ${http.length})`);
  assert(graph.services.length === 2, "backend + frontend services");
  assert(graph.llmUsage.length === 0, "no AI usage without a provider");
  const userList = http.find((e) => e.method === "GET" && e.path === "/system/user/list");
  const view = new core.GraphView(graph);
  const detail = view.flowDetail(userList.id);
  const layers = detail.steps.map((s) => s.layer);
  assert(layers[0] === "frontend" && layers.includes("filter") && layers.includes("controller") && layers.includes("sql"), "GET /system/user/list flow spans frontend → filter → controller → sql");

  const controller = vscode.Uri.file(path.join(backend, "ruoyi-admin/src/main/java/com/ruoyi/web/controller/system/SysUserController.java"));
  await vscode.window.showTextDocument(controller);
  let lenses = [];
  await waitFor(async () => {
    lenses = (await vscode.commands.executeCommand("vscode.executeCodeLensProvider", controller)) ?? [];
    return lenses.some((l) => l.command && /\/system\/user\/list/.test(l.command.title));
  }, 15_000, "CodeLens on SysUserController");
  assert(true, `CodeLens shows request flows (${lenses.length} lenses)`);

  await vscode.commands.executeCommand("atlas.revealInAtlas", controller);
  await vscode.commands.executeCommand("atlas.openPanel", { view: "flow", nodeId: userList.id });
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
  assert(tabs.some((t) => t.label === "Atlas"), "Atlas panel opens");
  console.log("E2E suite finished");
};
