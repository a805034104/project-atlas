import type { SourceRef, StartupGuide } from "../model/types.js";
import type { FrontendApp, JavaService } from "../workspace/detect.js";
import type { LoadedFile } from "../workspace/load.js";

/**
 * Deterministic startup guides (no LLM). Every command and prerequisite cites
 * the file and line it comes from (spec AC#5: zero fabricated commands); the
 * AI layer may later enrich these, under the same evidence check.
 */

function lineOf(text: string, needle: RegExp): number | undefined {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => needle.test(l));
  return i < 0 ? undefined : i + 1;
}

function ref(file: LoadedFile, line?: number): SourceRef {
  return line === undefined ? { rootId: file.rootId, file: file.relPath } : { rootId: file.rootId, file: file.relPath, line };
}

export function javaStartup(svc: JavaService, files: readonly LoadedFile[]): StartupGuide {
  const guide: StartupGuide = { target: svc.service.name, serviceId: svc.service.id, prerequisites: [], steps: [], ports: [], configFiles: svc.configFiles };
  const inRoot = files.filter((f) => f.rootId === svc.service.rootId);
  const rootPom = inRoot.find((f) => f.relPath === "pom.xml") ?? inRoot.find((f) => f.relPath === `${svc.appModule.dir}/pom.xml`);
  const appPom = inRoot.find((f) => f.relPath === (svc.appModule.dir ? `${svc.appModule.dir}/pom.xml` : "pom.xml"));

  for (const pom of [rootPom, appPom]) {
    const line = pom?.text ? lineOf(pom.text, /<java\.version>|<maven\.compiler\.source>/) : undefined;
    if (pom?.text && line) {
      const version = /<(?:java\.version|maven\.compiler\.source)>([^<]+)</.exec(pom.text.split("\n")[line - 1] ?? "")?.[1];
      guide.prerequisites.push({ name: "JDK", ...(version ? { version } : {}), evidence: ref(pom, line) });
      break;
    }
  }
  const datasource = svc.config.list("spring.datasource").find((e) => /url$/i.test(e.key) && /jdbc:(\w+)/.test(svc.config.resolve(e.value).value));
  if (datasource) {
    const db = /jdbc:(\w+)/.exec(svc.config.resolve(datasource.value).value)?.[1] ?? "database";
    guide.prerequisites.push({ name: db === "mysql" ? "MySQL" : db === "postgresql" ? "PostgreSQL" : db, evidence: datasource.at });
  }
  const redis = svc.config.get("spring.redis.host") ?? svc.config.get("spring.data.redis.host");
  if (redis) guide.prerequisites.push({ name: "Redis", evidence: redis.at });
  const nacos = svc.config.get("spring.cloud.nacos.discovery.server-addr") ?? svc.config.get("spring.cloud.nacos.config.server-addr");
  if (nacos) guide.prerequisites.push({ name: "Nacos", version: svc.config.resolve(nacos.value).value, evidence: nacos.at });

  const port = svc.config.get("server.port");
  guide.ports.push({ port: svc.port, evidence: port?.at ?? svc.service.evidence });

  if (appPom?.text) {
    const plugin = lineOf(appPom.text, /spring-boot-maven-plugin/);
    if (plugin) {
      const module = svc.appModule.dir;
      guide.steps.push({ command: module ? `mvn -pl ${module} -am spring-boot:run` : "mvn spring-boot:run", cwd: ".", evidence: ref(appPom, plugin) });
    }
  }
  guide.steps.push({ command: `run ${svc.service.evidence.file.split("/").pop()?.replace(/\.java$/, "")}.main()`, cwd: ".", evidence: svc.service.evidence });
  for (const script of inRoot.filter((f) => f.kind === "shell" && !f.relPath.includes("/") && f.text?.includes(svc.appModule.artifactId))) {
    const line = lineOf(script.text ?? "", /start/);
    if (script.relPath.endsWith(".sh")) guide.steps.push({ command: `sh ${script.relPath} start`, cwd: ".", evidence: ref(script, line) });
  }
  return guide;
}

export function frontendStartup(app: FrontendApp, files: readonly LoadedFile[]): StartupGuide {
  const guide: StartupGuide = { target: app.service.name, serviceId: app.service.id, prerequisites: [], steps: [], ports: [], configFiles: app.configFiles };
  const manifest = files.find((f) => f.rootId === app.service.rootId && f.relPath === (app.dir ? `${app.dir}/package.json` : "package.json"));
  if (!manifest?.text) return guide;
  const engines = lineOf(manifest.text, /"node"\s*:/);
  if (engines) guide.prerequisites.push({ name: "Node.js", version: /"node"\s*:\s*"([^"]+)"/.exec(manifest.text)?.[1] ?? "", evidence: ref(manifest, engines) });
  else guide.prerequisites.push({ name: "Node.js", evidence: ref(manifest, 1) });
  const deps = lineOf(manifest.text, /"dependencies"\s*:/);
  const lockfile = files.find((f) => f.rootId === app.service.rootId && /(^|\/)(pnpm-lock\.yaml|yarn\.lock)$/.test(f.relPath));
  const installer = lockfile?.relPath.endsWith("pnpm-lock.yaml") ? "pnpm" : lockfile?.relPath.endsWith("yarn.lock") ? "yarn" : "npm";
  guide.steps.push({ command: `${installer} install`, cwd: app.dir || ".", evidence: ref(manifest, deps ?? 1) });
  for (const script of ["dev", "serve", "start"]) {
    const line = lineOf(manifest.text, new RegExp(`"${script}"\\s*:`));
    if (line) {
      guide.steps.push({ command: installer === "npm" ? `npm run ${script}` : `${installer} ${script}`, cwd: app.dir || ".", evidence: ref(manifest, line) });
      break;
    }
  }
  if (app.devPort) guide.ports.push({ port: app.devPort, evidence: app.proxies[0]?.at ?? ref(manifest) });
  return guide;
}
