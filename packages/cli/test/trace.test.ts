import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JAVAAGENT_FILE } from "@project-atlas/core";
import { parseCliArgs } from "../src/args.js";
import { traceCommand } from "../src/commands/trace.js";
import { CliError } from "../src/errors.js";
import type { CliIo } from "../src/io.js";

const REAL_AGENT = path.join(homedir(), ".project-atlas", "agents", JAVAAGENT_FILE);

function io(cwd: string, env: Record<string, string> = {}): CliIo & { out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    env,
    cwd,
    interactive: false,
    ask: async () => "",
    fetch: (async () => {
      throw new Error("network access in a test");
    }) as typeof fetch,
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

/** A tiny Spring app: GET /hello → HelloController.hello → HelloService.greet. */
async function workspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "atlas-trace-"));
  const files: Record<string, string> = {
    "pom.xml": "<project><groupId>d</groupId><artifactId>hello</artifactId></project>",
    "src/main/resources/application.yml": "server:\n  port: 8080\nspring:\n  application:\n    name: hello\n",
    "src/main/java/app/App.java": "package app;\n@SpringBootApplication public class App {}\n",
    "src/main/java/app/HelloService.java": "package app;\n@Service public class HelloService { public String greet() { return \"hi\"; } }\n",
    "src/main/java/app/HelloController.java": 'package app;\n@RestController public class HelloController { @Autowired private HelloService helloService; @GetMapping("/hello") public String hello() { return helloService.greet(); } }\n',
  };
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  }
  return dir;
}

const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });
function helloRequestJson(): string {
  const t = "1".repeat(32);
  const span = (id: string, parent: string | undefined, name: string, kind: number, attrs: unknown[], startMs: number, durMs: number) => ({
    traceId: t,
    spanId: id.repeat(16),
    ...(parent ? { parentSpanId: parent.repeat(16) } : {}),
    name,
    kind,
    startTimeUnixNano: String(BigInt(startMs) * 1_000_000n),
    endTimeUnixNano: String(BigInt(startMs + durMs) * 1_000_000n),
    attributes: attrs,
  });
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [attr("service.name", "hello")] },
        scopeSpans: [
          {
            scope: { name: "io.opentelemetry.methods" },
            spans: [
              span("a", undefined, "GET /hello", 2, [attr("http.route", "/hello"), attr("http.request.method", "GET")], 1_760_000_000_000, 20),
              span("b", "a", "HelloController.hello", 1, [attr("code.namespace", "app.HelloController"), attr("code.function", "hello")], 1_760_000_000_001, 15),
              span("c", "b", "HelloService.greet", 1, [attr("code.namespace", "app.HelloService"), attr("code.function", "greet")], 1_760_000_000_002, 5),
            ],
          },
        ],
      },
    ],
  });
}

let savedHome: string | undefined;
beforeAll(async () => {
  savedHome = process.env["PROJECT_ATLAS_HOME"];
  process.env["PROJECT_ATLAS_HOME"] = await mkdtemp(path.join(tmpdir(), "atlas-home-"));
});
afterAll(() => {
  if (savedHome === undefined) delete process.env["PROJECT_ATLAS_HOME"];
  else process.env["PROJECT_ATLAS_HOME"] = savedHome;
});

describe("trace arguments", () => {
  it("splits the traced command at --", () => {
    expect(parseCliArgs(["trace", "--service", "hello", "--", "mvn", "-q", "spring-boot:run", "--json"])).toEqual({
      command: "trace",
      run: ["mvn", "-q", "spring-boot:run", "--json"],
      service: "hello",
      allowAgentConflict: false,
      printConfig: false,
      json: false,
    });
    expect(parseCliArgs(["trace", "import", "x.pb"])).toMatchObject({ command: "trace", importFile: "x.pb", run: [] });
  });

  it("rejects a command without -- and -- outside trace", () => {
    const code = (argv: string[]) => {
      try {
        parseCliArgs(argv);
      } catch (error) {
        return error instanceof CliError ? error.error.code : "other";
      }
      return undefined;
    };
    expect(code(["trace", "mvn", "spring-boot:run"])).toBe("ATLAS-E060");
    expect(code(["analyze", "--", "x"])).toBe("ATLAS-E060");
    expect(code(["trace", "--port", "70000"])).toBe("ATLAS-E060");
  });
});

describe("trace import", () => {
  it("analyzes when needed, folds an OTLP/JSON file in and reports observed flows", async () => {
    const ws = await workspace();
    await writeFile(path.join(ws, "spans.json"), helloRequestJson());
    const t = io(ws);
    const code = await traceCommand({ ...parseCliArgs(["trace", "import", "spans.json", "--json"]), command: "trace" } as never, t);
    expect(code).toBe(0);
    const report = JSON.parse(t.out()) as { spans: number; entrypoints: { label: string; count: number; coverage: { observed: number; instrumentable: number } }[] };
    expect(report.spans).toBe(3);
    expect(report.entrypoints).toEqual([expect.objectContaining({ label: "GET /hello", count: 1, coverage: { observed: 2, instrumentable: 2 } })]);
    expect(t.err()).toContain("running `analyze --no-ai` first");
    // idempotent: re-importing adds nothing
    const again = io(ws);
    await traceCommand(parseCliArgs(["trace", "import", "spans.json"]) as never, again);
    expect(again.err()).toContain("imported 0 new span(s) (3 already stored)");
  });
});

describe.skipIf(!existsSync(REAL_AGENT))("trace -- <command>", () => {
  it("starts a receiver, launches the command with the agent and summarises what was observed", async () => {
    const ws = await workspace();
    const t = io(ws, { ATLAS_JAVAAGENT_PATH: REAL_AGENT });
    let launched = "";
    const code = await traceCommand(parseCliArgs(["trace", "--json", "--", "java", "-jar", "target/hello.jar"]) as never, t, {
      settleMs: 50,
      run: async (command) => {
        launched = command;
        // Act as the instrumented JVM: read endpoint + token from the generated config, export spans.
        const configPath = /-Dotel\.javaagent\.configuration-file=("?)([^"\s]+)\1/.exec(command)?.[2] as string;
        const props = await readFile(configPath, "utf8");
        const endpoint = /traces\.endpoint=(.*)/.exec(props)?.[1]?.replace(/\\(.)/g, "$1") as string;
        const token = /Bearer (\w+)/.exec(props)?.[1] as string;
        expect(props).toContain("otel.instrumentation.methods.include=app.HelloController[hello];app.HelloService[greet]");
        const res = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: helloRequestJson() });
        expect(res.status).toBe(200);
        return 7;
      },
    });
    expect(code).toBe(7); // the command's exit code is passed through
    expect(launched).toMatch(/^java -javaagent:\S+ -Dotel\.javaagent\.configuration-file=\S+ -jar target\/hello\.jar$/);
    const report = JSON.parse(t.out()) as { entrypoints: { label: string }[] };
    expect(report.entrypoints.map((e) => e.label)).toEqual(["GET /hello"]);
    expect(existsSync(path.join(ws, ".atlas", "receiver.json"))).toBe(false); // lock released
    expect(existsSync(path.join(ws, ".atlas", "traces", "aggregates.json"))).toBe(true);
  });

  it("refuses a foreign javaagent unless allowed (ATLAS-E072)", async () => {
    const ws = await workspace();
    const t = io(ws, { ATLAS_JAVAAGENT_PATH: REAL_AGENT });
    const error = await traceCommand(parseCliArgs(["trace", "--", "java", "-javaagent:/opt/sw/skywalking-agent.jar", "-jar", "a.jar"]) as never, t, { run: async () => 0 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).error.code).toBe("ATLAS-E072");
  });
});
