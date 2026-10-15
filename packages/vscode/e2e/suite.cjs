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

  // ── v0.2 runtime: copy VM options → receiver → real agent payloads (S0) → observed flow ──
  for (const id of ["atlas.runtime.copyVmOptions", "atlas.runtime.launch", "atlas.runtime.stop", "atlas.runtime.clear"]) {
    assert(commands.includes(id), `command ${id} registered`);
  }
  if (!process.env.ATLAS_E2E_AGENT) {
    console.log("  - runtime E2E skipped: no cached opentelemetry-javaagent-2.31.1.jar");
  } else {
    const api = ext.exports;
    // Not awaited: the command ends on an information message the test cannot click.
    void vscode.commands.executeCommand("atlas.runtime.copyVmOptions");
    const lock = path.join(backend, ".atlas", "receiver.json");
    await waitFor(() => existsSync(lock), 30_000, ".atlas/receiver.json");
    await waitFor(async () => /-javaagent:\S*opentelemetry-javaagent-2\.31\.1\.jar/.test(await vscode.env.clipboard.readText()), 30_000, "VM options on the clipboard");
    const vm = await vscode.env.clipboard.readText();
    assert(/-Dotel\.javaagent\.configuration-file=/.test(vm), "VM options copied (agent + configuration file)");
    const state = api.runtimeState();
    assert(state && state.status === "waiting" && state.port > 0, `receiver waiting on 127.0.0.1:${state && state.port}`);

    const { readdirSync, readFileSync } = require("node:fs");
    const token = await core.workspaceToken(backend);
    const golden = process.env.ATLAS_E2E_GOLDEN;
    const startedPost = Date.now();
    for (const f of readdirSync(golden).filter((n) => n.endsWith(".pb")).sort()) {
      const res = await fetch(`http://127.0.0.1:${state.port}/v1/traces`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/x-protobuf" }, body: readFileSync(path.join(golden, f)) });
      if (res.status !== 200) throw new Error(`receiver answered ${res.status}`);
    }
    const rejected = await fetch(`http://127.0.0.1:${state.port}/v1/traces`, { method: "POST", headers: { authorization: "Bearer wrong", "content-type": "application/x-protobuf" }, body: new Uint8Array(0) });
    assert(rejected.status === 401, "receiver rejects a wrong token (AC#24)");

    let observed = [];
    await waitFor(() => {
      const d = api.flowDetail(userList.id);
      observed = d ? d.steps.filter((s) => s.observed).map((s) => s.layer) : [];
      return ["filter", "interceptor", "controller", "aspect", "service", "repository", "sql"].every((l) => observed.includes(l));
    }, 10_000, "observed steps on GET /system/user/list");
    assert(true, `AC#19: every layer of GET /system/user/list observed within ${Date.now() - startedPost} ms (${observed.length} steps)`);
    assert(api.flowDetail(userList.id).entrypoint.observed.count >= 1, "entrypoint carries request count and latency");
    const runtimeEdges = graph.edges.length; // static store is untouched by the overlay
    const restored = await core.loadStoredGraph(path.join(backend, ".atlas"));
    assert(restored.graph.edges.length === runtimeEdges && !restored.graph.steps.some((s) => s.observed), "the saved analysis is not modified by runtime data");

    await vscode.commands.executeCommand("atlas.runtime.stop");
    await waitFor(() => !existsSync(lock), 10_000, "receiver lock released");
    assert(existsSync(path.join(backend, ".atlas", "traces", "aggregates.json")), "aggregates persisted for the next session");
  }
  console.log("E2E suite finished");
};
