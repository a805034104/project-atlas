// AC-RT-WIN — Windows launch and shutdown, end to end with a real JVM and a real Ctrl-C:
//   new hidden console ─▶ wrapper (ignores Ctrl-C, records the exit code)
//     ─▶ project-atlas trace --agent "<中文 和 空格>/agent.jar" -- mvn -o -q spring-boot:run   (mvn.cmd)
//   ─▶ request ─▶ CTRL_C_EVENT to that console (AttachConsole + GenerateConsoleCtrlEvent), as a terminal would
//   ─▶ cmd.exe "Terminate batch job (Y/N)?" waits on the console ─▶ the CLI ends the tree after its grace period
//   ─▶ exit code 130, no process of the tree left, summary printed.
//
//   node scripts/runtime-win.mjs
// Env: MAVEN_HOME (default E:/tools/maven), AGENT_DIR (default E:/tools/测试 目录; the pinned jar is copied there).
import { execFileSync, spawn } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);

if (process.argv[2] === "--wrapped") {
  // Runs inside the new console. Ctrl-C reaches this process too; ignore it and wait for the CLI.
  const dir = process.argv[3];
  const { args, env } = JSON.parse(readFileSync(path.join(dir, "args.json"), "utf8"));
  process.on("SIGINT", () => {});
  writeFileSync(path.join(dir, "wrapper.pid"), String(process.pid));
  const out = openSync(path.join(dir, "stdout.txt"), "w");
  const err = openSync(path.join(dir, "stderr.txt"), "w");
  const cli = spawn(process.execPath, args, { stdio: ["inherit", out, err], env: { ...process.env, ...env } });
  writeFileSync(path.join(dir, "cli.pid"), String(cli.pid));
  cli.on("exit", (code) => {
    closeSync(out);
    closeSync(err);
    writeFileSync(path.join(dir, "code.txt"), String(code));
    process.exit(0);
  });
} else {
  await main();
}

function check(ok, message) {
  if (!ok) throw new Error(`AC-RT-WIN failed: ${message}`);
  console.log(`  ✓ ${message}`);
}

async function until(fn, ms, label) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      if (await fn()) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting for ${label}`);
}

function powershell(dir, name, script) {
  const file = path.join(dir, name);
  writeFileSync(file, `\ufeff${script}`, "utf8");
  return execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file]).toString().trim();
}

/** Every process started under `root` (cmd.exe, mvn's JVM, the app's JVM), as "pid name". */
function descendants(dir, root) {
  const out = powershell(
    dir,
    "tree.ps1",
    `$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
$todo = New-Object System.Collections.Queue
$todo.Enqueue([uint32]${root})
while ($todo.Count -gt 0) {
  $p = $todo.Dequeue()
  foreach ($c in ($all | Where-Object { $_.ParentProcessId -eq $p })) { "$($c.ProcessId) $($c.Name)"; $todo.Enqueue($c.ProcessId) }
}`,
  );
  return out.split(/\r?\n/).filter(Boolean);
}

/** The subset of "pid name" entries still alive. */
function alive(dir, entries) {
  if (entries.length === 0) return [];
  const ids = entries.map((e) => e.split(" ")[0]).join(",");
  const out = powershell(dir, "alive.ps1", `Get-Process -Id ${ids} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.ProcessName)" }`);
  return out.split(/\r?\n/).filter(Boolean);
}

/** A real console Ctrl-C, delivered to every process attached to the console of `pid`. */
function sendCtrlC(dir, pid) {
  powershell(
    dir,
    "ctrlc.ps1",
    `Add-Type -Namespace W -Name K -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern bool FreeConsole();
[DllImport("kernel32.dll")] public static extern bool AttachConsole(uint p);
[DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(System.IntPtr h, bool add);
[DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint e, uint g);
'@
[W.K]::FreeConsole() | Out-Null
if (-not [W.K]::AttachConsole(${pid})) { throw "AttachConsole failed" }
[W.K]::SetConsoleCtrlHandler([System.IntPtr]::Zero, $true) | Out-Null
if (-not [W.K]::GenerateConsoleCtrlEvent(0, 0)) { throw "GenerateConsoleCtrlEvent failed" }
Start-Sleep -Milliseconds 300
[W.K]::FreeConsole() | Out-Null`,
  );
}

async function main() {
  if (process.platform !== "win32") {
    console.log("AC-RT-WIN skipped: Windows only");
    return;
  }
  const repo = path.resolve(path.dirname(self), "..");
  const synth = path.join(repo, "fixtures/synthetic/reflection");
  const mavenBin = path.join(process.env.MAVEN_HOME ?? "E:/tools/maven", "bin");
  const agentDir = process.env.AGENT_DIR ?? "E:/tools/测试 目录";
  const agent = path.join(agentDir, "opentelemetry-javaagent-2.31.1.jar");
  const PORT = 18101;

  if (!existsSync(path.join(synth, "target/reflect-demo-1.0.0.jar"))) {
    console.log("AC-RT-WIN skipped: build fixtures/synthetic/reflection with `mvn -q -DskipTests package` first");
    return;
  }
  if (!existsSync(path.join(mavenBin, "mvn.cmd"))) {
    console.log(`AC-RT-WIN skipped: no mvn.cmd in ${mavenBin}`);
    return;
  }
  if (!existsSync(agent)) {
    const cached = path.join(homedir(), ".project-atlas", "agents", "opentelemetry-javaagent-2.31.1.jar");
    if (!existsSync(cached)) {
      console.log(`AC-RT-WIN skipped: no pinned agent in ${agentDir} or ${cached}`);
      return;
    }
    mkdirSync(agentDir, { recursive: true });
    copyFileSync(cached, agent);
  }
  check(!(await fetch(`http://127.0.0.1:${PORT}/report`).then(() => true, () => false)), `port ${PORT} free before the test`);
  rmSync(path.join(synth, ".atlas", "traces"), { recursive: true, force: true });

  console.log("AC-RT-WIN:");
  const dir = mkdtempSync(path.join(tmpdir(), "atlas-win-"));
  const args = [path.join(repo, "packages/cli/dist/bin.js"), "trace", "--dir", synth, "--agent", agent, "--json", "--", "mvn", "-o", "-q", "spring-boot:run"];
  writeFileSync(path.join(dir, "args.json"), JSON.stringify({ args, env: { PATH: `${mavenBin};${process.env.PATH}` } }));
  // A real terminal processes Ctrl-C; this harness may run under a parent that ignores it, and that
  // attribute is inherited. A small launcher clears it (SetConsoleCtrlHandler(NULL, FALSE)), survives
  // Ctrl-C itself, and starts the wrapper; `start` (without /B) gives it a console of its own, minimised.
  const launcher = path.join(dir, "ctrlc-on.exe");
  powershell(
    dir,
    "build.ps1",
    `Add-Type -OutputAssembly '${launcher}' -OutputType ConsoleApplication -TypeDefinition @'
using System; using System.Diagnostics; using System.Linq; using System.Runtime.InteropServices;
public static class Launcher {
  delegate bool Handler(uint e);
  [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(IntPtr h, bool add);
  [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(Handler h, bool add);
  static Handler keep = e => true;
  public static int Main(string[] a) {
    SetConsoleCtrlHandler(IntPtr.Zero, false);
    SetConsoleCtrlHandler(keep, true);
    var p = Process.Start(new ProcessStartInfo(a[0], string.Join(" ", a.Skip(1).Select(x => (char)34 + x + (char)34))) { UseShellExecute = false });
    p.WaitForExit();
    return p.ExitCode;
  }
}
'@`,
  );
  spawn("cmd.exe", ["/d", "/c", "start", '"atlas AC-RT-WIN"', "/min", "/d", synth, launcher, process.execPath, self, "--wrapped", dir], { windowsVerbatimArguments: true, stdio: "ignore", windowsHide: true });
  const read = (name) => (existsSync(path.join(dir, name)) ? readFileSync(path.join(dir, name), "utf8") : "");
  await until(() => read("wrapper.pid") !== "", 30_000, "wrapper console");
  const wrapperPid = Number(read("wrapper.pid"));
  let tree = [];
  try {
    await until(async () => (await fetch(`http://127.0.0.1:${PORT}/report`)).ok, 240_000, `reflect-demo on :${PORT} via mvn.cmd`);
    const stderr = read("stderr.txt");
    check(/maven-spring-boot → mvn/.test(stderr), "launched through mvn.cmd as maven-spring-boot (Maven's own JVM is not instrumented)");
    const agentArg = /-Dspring-boot\.run\.agents=(\S+)/.exec(stderr)?.[1] ?? "";
    check(/^[\x20-\x7e]+$/.test(agentArg) && agentArg.endsWith("opentelemetry-javaagent-2.31.1.jar"), `agent from "${agentDir}" handed to the JVM from an ASCII path (${agentArg})`);
    check((await (await fetch(`http://127.0.0.1:${PORT}/jobs/local`)).text()) === "audited", "GET /jobs/local");
    await new Promise((r) => setTimeout(r, 2000));
    const cliPid = Number(read("cli.pid"));
    tree = [`${cliPid} node.exe`, ...descendants(dir, cliPid)];
    const jvms = tree.filter((p) => /java/i.test(p));
    check(jvms.length === 2 && tree.some((p) => /cmd\.exe/i.test(p)), `process tree up: ${tree.map((p) => p.split(" ")[1]).join(", ")}`);
    const t0 = Date.now();
    sendCtrlC(dir, Number(wrapperPid));
    await until(() => read("code.txt") !== "", 45_000, "CLI exit after Ctrl-C");
    const code = Number(read("code.txt"));
    check(code === 130, `CLI exited with ${code} after Ctrl-C (${Math.round((Date.now() - t0) / 1000)} s)`);
    await new Promise((r) => setTimeout(r, 1000));
    const left = alive(dir, tree);
    check(left.length === 0, `Ctrl-C ended the whole tree${left.length ? ` (left: ${left.join(", ")})` : ""}`);
    check(!(await fetch(`http://127.0.0.1:${PORT}/report`).then(() => true, () => false)), `nothing listening on :${PORT}`);
    const summary = JSON.parse(read("stdout.txt"));
    check(summary.spans > 0 && summary.entrypoints.some((e) => e.label === "GET /jobs/local"), `summary printed after Ctrl-C (${summary.spans} spans, GET /jobs/local observed)`);
    console.log("AC-RT-WIN passed");
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    console.error(read("stderr.txt").split("\n").slice(-25).join("\n"));
    const leftovers = alive(dir, tree.length ? tree : []);
    for (const p of leftovers) {
      try {
        execFileSync("taskkill", ["/PID", p.split(" ")[0], "/T", "/F"], { stdio: "ignore" });
      } catch {
        // gone
      }
    }
    try {
      execFileSync("taskkill", ["/PID", String(wrapperPid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // gone
    }
    throw error;
  }
}
