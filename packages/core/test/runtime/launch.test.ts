import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JAVAAGENT_FILE } from "../../src/runtime/agent-config.js";
import { AgentDownloadError, AgentIntegrityError, ensureJavaAgent, privateAsciiDir, runtimeConfigDir } from "../../src/runtime/agent-fetch.js";
import { detectLauncher, tracedLaunch, vmOptions } from "../../src/runtime/launch.js";

const files = { agentPath: "C:/agents/otel.jar", configPath: "C:/Users/Jo Doe/.project-atlas/configs/app.properties" };

describe("tracedLaunch", () => {
  it("inserts agent options after java for java -jar", () => {
    const l = tracedLaunch("java -Xmx512m -jar ruoyi-admin/target/ruoyi-admin.jar --server.port=8080", files);
    expect(l.launcher).toBe("java-jar");
    expect(l.command).toBe('java -javaagent:C:/agents/otel.jar -Dotel.javaagent.configuration-file="C:/Users/Jo Doe/.project-atlas/configs/app.properties" -Xmx512m -jar ruoyi-admin/target/ruoyi-admin.jar --server.port=8080');
    expect(l.env).toEqual({});
  });

  it("uses spring-boot.run.agents for mvn spring-boot:run (Maven's own JVM stays clean)", () => {
    const l = tracedLaunch("mvn -pl ruoyi-admin -am spring-boot:run", files);
    expect(l.launcher).toBe("maven-spring-boot");
    expect(l.command).toContain("-Dspring-boot.run.agents=C:/agents/otel.jar");
    // A path with spaces stays one JVM argument (the plugin splits jvmArguments on whitespace).
    expect(l.command).toContain(`"-Dspring-boot.run.jvmArguments='-Dotel.javaagent.configuration-file=C:/Users/Jo Doe/.project-atlas/configs/app.properties'"`);
    expect(detectLauncher("./mvnw.cmd spring-boot:run")).toBe("maven-spring-boot");
  });

  it("falls back to JAVA_TOOL_OPTIONS (appended) for tests, Gradle and scripts", () => {
    const l = tracedLaunch("mvn test", files, { JAVA_TOOL_OPTIONS: "-Dfile.encoding=UTF-8" });
    expect(l.launcher).toBe("java-tool-options");
    expect(l.command).toBe("mvn test");
    expect(l.env["JAVA_TOOL_OPTIONS"]).toBe(`-Dfile.encoding=UTF-8 ${vmOptions(files)}`);
    expect(detectLauncher("sh ry.sh start")).toBe("java-tool-options");
  });

  it("reports an existing foreign javaagent (ATLAS-E072) but not our own", () => {
    expect(tracedLaunch("java -javaagent:/opt/skywalking-agent.jar -jar app.jar", files).conflict).toBe("/opt/skywalking-agent.jar");
    expect(tracedLaunch("mvn test", files, { JAVA_TOOL_OPTIONS: "-javaagent:arthas-agent.jar" }).conflict).toBe("arthas-agent.jar");
    expect(tracedLaunch("java -javaagent:/x/opentelemetry-javaagent-2.31.1.jar -jar app.jar", files).conflict).toBeUndefined();
  });
});

const realAgent = path.join(homedir(), ".project-atlas", "agents", JAVAAGENT_FILE);

describe.skipIf(!existsSync(realAgent))("ensureJavaAgent (with the real pinned jar as the 'download')", () => {
  const bytes = existsSync(realAgent) ? readFileSync(realAgent) : Buffer.alloc(0);
  const fakeFetch = (responses: Record<string, () => Response>): typeof fetch =>
    (async (input: string | URL | Request) => {
      const url = String(input);
      const make = responses[url];
      if (!make) throw new Error(`ECONNREFUSED ${url}`);
      return make();
    }) as typeof fetch;

  it("falls through a proxy login page to the next mirror and caches the verified jar", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "atlas-home-"));
    const progress: number[] = [];
    const agent = await ensureJavaAgent({
      homeDir: home,
      urls: ["https://central.example/agent.jar", "https://mirror.example/agent.jar"],
      fetch: fakeFetch({
        "https://central.example/agent.jar": () => new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } }),
        "https://mirror.example/agent.jar": () => new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } }),
      }),
      onProgress: (p) => progress.push(p.received),
    });
    expect(agent).toBe(path.join(home, "agents", JAVAAGENT_FILE));
    expect(progress.at(-1)).toBe(bytes.length);
    // second call: served from the verified cache, no network
    expect(await ensureJavaAgent({ homeDir: home, fetch: fakeFetch({}) })).toBe(agent);
  });

  it("reports every failed source with the HTML hint (ATLAS-E070)", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "atlas-home-"));
    const error = await ensureJavaAgent({
      homeDir: home,
      urls: ["https://central.example/a.jar", "https://mirror.example/a.jar"],
      fetch: fakeFetch({ "https://central.example/a.jar": () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }) }),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentDownloadError);
    const uf = (error as AgentDownloadError).toUserFacing();
    expect(uf.code).toBe("ATLAS-E070");
    expect(uf.cause).toMatch(/central\.example: sha256 mismatch .*text\/html/);
    expect(uf.cause).toMatch(/mirror\.example: ECONNREFUSED/);
    expect(uf.fix).toContain("Invoke-WebRequest");
  });

  it("re-downloads a tampered cache and rejects a wrong explicit jar (ATLAS-E071)", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "atlas-home-"));
    await mkdir(path.join(home, "agents"), { recursive: true });
    await writeFile(path.join(home, "agents", JAVAAGENT_FILE), "tampered");
    const agent = await ensureJavaAgent({ homeDir: home, urls: ["https://m/a.jar"], fetch: fakeFetch({ "https://m/a.jar": () => new Response(bytes) }) });
    expect(readFileSync(agent).length).toBe(bytes.length);
    const wrong = path.join(home, "wrong.jar");
    await writeFile(wrong, "not the agent");
    await expect(ensureJavaAgent({ explicitPath: wrong })).rejects.toBeInstanceOf(AgentIntegrityError);
  });

  it("copies the jar to an ASCII directory when its path has non-ASCII characters (S0 Run D)", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "atlas-"));
    const chinese = path.join(base, "测试 目录");
    await mkdir(chinese, { recursive: true });
    const jar = path.join(chinese, JAVAAGENT_FILE);
    await copyFile(realAgent, jar);
    const asciiDir = path.join(base, "ascii");
    const usable = await ensureJavaAgent({ explicitPath: jar, asciiDir });
    expect(usable).toBe(path.join(asciiDir, JAVAAGENT_FILE));
    expect(/^[\x20-\x7e]*$/.test(usable)).toBe(true);
  });

  it("uses a private per-user ASCII directory for a non-ASCII home, stable across calls", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "atlas-"));
    const home = path.join(base, "用户");
    const dir = await privateAsciiDir(home);
    expect(/^[ -~]*$/.test(dir)).toBe(true);
    expect(dir).not.toMatch(/project-atlas[\/]agents$|^\/tmp\/project-atlas-agents$/); // never a fixed shared path
    expect(await privateAsciiDir(home)).toBe(dir);
    expect(await runtimeConfigDir(home)).toBe(path.join(dir, "configs"));
  });
});
