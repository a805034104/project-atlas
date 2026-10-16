// AC-W2 / AC-W4 end to end: the local web app in a real (headless) Chrome, driven over the
// DevTools protocol with Node's built-in WebSocket — no Playwright.
//
//   start the app (source build, or --exe <single-file build>) ─▶ "#code=…" URL from its output
//   ─▶ Chrome opens it ─▶ import fixtures/repos/ruoyi-vue (trusted) ─▶ analysis finishes
//   ─▶ Flow tab ─▶ GET /system/user/list drawn as a pyramid (entry on top, rows downward)
//   ─▶ the source panel opens on a node click ─▶ a second launch reuses the instance
//
//   node scripts/web-e2e.mjs [--exe dist-release/project-atlas-win-x64.exe]
// Env: CHROME (browser path), RUOYI_VUE (default fixtures/repos/ruoyi-vue)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = path.resolve(repo, process.env.RUOYI_VUE ?? "fixtures/repos/ruoyi-vue");
const exeArg = process.argv.indexOf("--exe");
const exe = exeArg > 0 ? path.resolve(process.argv[exeArg + 1]) : undefined;
const chrome = [process.env.CHROME, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((c) => c && existsSync(c));
if (!chrome) {
  console.log("web E2E skipped: no Chrome (set CHROME)");
  process.exit(0);
}
if (!existsSync(project)) {
  console.log(`web E2E skipped: ${project} missing (npm run fixtures)`);
  process.exit(0);
}

const check = (ok, message) => {
  if (!ok) throw new Error(`web E2E failed: ${message}`);
  console.log(`  ✓ ${message}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, label) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // not yet
    }
    await sleep(300);
  }
  throw new Error(`timeout: ${label}`);
}

const home = mkdtempSync(path.join(tmpdir(), "atlas-web-e2e-"));
const launch = () => {
  const [cmd, args] = exe ? [exe, []] : [process.execPath, [path.join(repo, "packages/web/dist/main.js")]];
  const child = spawn(cmd, [...args, "--no-open", "--home", home], { stdio: ["ignore", "pipe", "pipe"] });
  const out = { text: "", child };
  child.stdout.on("data", (d) => (out.text += d));
  child.stderr.on("data", (d) => (out.text += d));
  return out;
};

const app = launch();
const profile = mkdtempSync(path.join(tmpdir(), "atlas-chrome-"));
let browser;
try {
  const url = await until(() => /(http:\/\/127\.0\.0\.1:\d+\/#code=[\w-]+)/.exec(app.text)?.[1], 60_000, "app URL");
  const port = Number(/:(\d+)\//.exec(url)[1]);
  check(true, `app listening on 127.0.0.1:${port}${exe ? ` (${path.basename(exe)})` : ""}`);

  browser = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
  const devtools = await until(() => {
    const f = path.join(profile, "DevToolsActivePort");
    return existsSync(f) ? readFileSync(f, "utf8").split("\n") : undefined;
  }, 30_000, "DevToolsActivePort");
  const targets = await (await fetch(`http://127.0.0.1:${devtools[0]}/json/list`)).json();
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };

  await cdp("Page.navigate", { url });
  await until(() => evaluate("location.hash === '#/' && !!document.querySelector('.web-import input')"), 30_000, "home page");
  check(await evaluate("!location.href.includes('code=')"), "signed in; the one-time code is gone from the address bar");
  check(await evaluate("fetch('/api/state').then(r => r.status === 200)"), "session cookie works");

  // Import: React reads the value through its own setter, so set it the way a keystroke would.
  await evaluate(`(() => {
    const input = document.querySelector('.web-import input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(`"${project}"`)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.web-trust input').click();
    return true;
  })()`);
  const started = Date.now();
  await evaluate("document.querySelector('.web-import button.primary').click(), true");
  await until(() => evaluate("/^#\\/p\\/[0-9a-f]{16}/.test(location.hash)"), 30_000, "project page");
  await until(() => evaluate("/\\d+ (个入口|entrypoints)/.test(document.querySelector('.tabpanel')?.textContent ?? '')"), 180_000, "analysis done");
  check(true, `imported and analyzed RuoYi-Vue in ${Math.round((Date.now() - started) / 1000)} s (overview shows entrypoints)`);

  await evaluate("[...document.querySelectorAll('[role=tab]')].find(t => t.id === 'tab-flow').click(), true");
  await until(() => evaluate("!!document.querySelector('.flow input[type=search], .flow [data-search]')"), 20_000, "flow tab");
  await evaluate(`(() => {
    const search = document.querySelector('.flow [data-search]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(search, '/system/user/list');
    search.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await until(() => evaluate("!![...document.querySelectorAll('[role=option]')].find(o => o.textContent.includes('/system/user/list'))"), 20_000, "entrypoint in list");
  await evaluate("[...document.querySelectorAll('[role=option]')].find(o => o.textContent.includes('/system/user/list') && o.textContent.includes('GET')).click(), true");
  const layout = await until(
    () =>
      evaluate(`(() => {
        const nodes = [...document.querySelectorAll('.pyramid .pyr-node')];
        if (nodes.length < 5) return undefined;
        const top = (re) => { const n = nodes.find(x => re.test(x.getAttribute('aria-label') || '')); return n ? parseFloat(n.style.top) : undefined; };
        return { nodes: nodes.length, filter: top(/filter|过滤器/), controller: top(/^SysUserController\\.list/), service: top(/^SysUserServiceImpl\\.selectUserList/) };
      })()`),
    20_000,
    "pyramid",
  );
  check(layout.filter < layout.controller && layout.controller < layout.service, `pyramid: ${layout.nodes} nodes, filter above controller above service`);

  await evaluate("document.querySelector('.pyramid .pyr-node[aria-label^=\"SysUserController.list\"]').click(), true");
  const drawer = await until(() => evaluate("document.querySelector('.web-drawer .web-code li.target')?.textContent"), 15_000, "source panel");
  check(/list|public/.test(drawer), `source panel opened on the controller (${drawer.trim().slice(0, 40)}…)`);

  const second = launch();
  await until(() => second.child.exitCode !== null, 30_000, "second launch exits");
  check(/already running|已在运行/.test(second.text) && second.child.exitCode === 0, "a second launch hands over to the running instance (AC-W4)");

  ws.close();
  console.log("web E2E passed");
} catch (error) {
  console.error(app.text.split("\n").slice(-20).join("\n"));
  throw error;
} finally {
  browser?.kill();
  app.child.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
