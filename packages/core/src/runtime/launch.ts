/**
 * How to start a JVM with the agent, per launcher (V1, verified in S0):
 *
 *   java … -jar app.jar        → insert -javaagent / -Dotel.javaagent.configuration-file after `java`
 *   mvn … spring-boot:run      → -Dspring-boot.run.agents + -Dspring-boot.run.jvmArguments
 *                                (Maven's own JVM stays uninstrumented)
 *   anything else              → JAVA_TOOL_OPTIONS, appended (mvn test, Gradle, sh scripts);
 *                                build-tool JVM batches are dropped at ingest by command line
 *   IDE / other                → vmOptions() to paste into the run configuration
 *
 * Paths are double-quoted; S0: spaces work quoted, non-ASCII is handled by the caller
 * (agent-fetch copies the jar to an ASCII path).
 */

export type Launcher = "java-jar" | "maven-spring-boot" | "java-tool-options";

export interface TracedLaunch {
  launcher: Launcher;
  command: string;
  /** Environment additions (merged over the user's environment by the caller). */
  env: Record<string, string>;
  /** A -javaagent is already present (SkyWalking, Arthas…): ATLAS-E072 unless the user allows it. */
  conflict?: string;
}

export interface AgentFiles {
  agentPath: string;
  configPath: string;
}

const quote = (p: string) => (/[\s"]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p);

export function vmOptions(files: AgentFiles): string {
  return `-javaagent:${quote(files.agentPath)} -Dotel.javaagent.configuration-file=${quote(files.configPath)}`;
}

export function detectLauncher(command: string): Launcher {
  if (/(^|[\s/\\])java(\.exe)?["']?\s[\s\S]*-jar\s/.test(command)) return "java-jar";
  if (/(^|[\s/\\])mvnw?(\.cmd)?\b[\s\S]*\bspring-boot:run\b/.test(command)) return "maven-spring-boot";
  return "java-tool-options";
}

function existingAgent(command: string, env: Record<string, string | undefined>): string | undefined {
  const fromCommand = /-javaagent:(\S+)/.exec(command)?.[1];
  const fromEnv = /-javaagent:(\S+)/.exec(env["JAVA_TOOL_OPTIONS"] ?? "")?.[1];
  const found = fromCommand ?? fromEnv;
  return found && !/opentelemetry-javaagent/.test(found) ? found : undefined;
}

export function tracedLaunch(command: string, files: AgentFiles, env: Record<string, string | undefined> = {}): TracedLaunch {
  const launcher = detectLauncher(command);
  const conflict = existingAgent(command, env);
  const base = conflict ? { conflict } : {};
  if (launcher === "java-jar") {
    const at = /(^|[\s/\\])java(\.exe)?["']?(?=\s)/.exec(command);
    const insertAt = at ? at.index + at[0].length : 0;
    return { launcher, command: `${command.slice(0, insertAt)} ${vmOptions(files)}${command.slice(insertAt)}`, env: {}, ...base };
  }
  if (launcher === "maven-spring-boot") {
    const jvm = `-Dspring-boot.run.jvmArguments=-Dotel.javaagent.configuration-file=${files.configPath}`;
    return { launcher, command: `${command} ${quote(`-Dspring-boot.run.agents=${files.agentPath}`)} ${quote(jvm)}`, env: {}, ...base };
  }
  const existing = env["JAVA_TOOL_OPTIONS"]?.trim();
  return { launcher, command, env: { JAVA_TOOL_OPTIONS: [existing, vmOptions(files)].filter(Boolean).join(" ") }, ...base };
}
