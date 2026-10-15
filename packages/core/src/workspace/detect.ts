import { withinDir } from "../util/collections.js";
import { parseDotEnv, parseNacosSqlDump, parsePropertiesConfig, parseYamlConfig, type ConfigDocument, type NacosConfigRow } from "../config/sources.js";
import { ConfigView, type ConfigLayer } from "../config/view.js";
import type { JavaFileFacts, ScriptFileFacts, ScriptValue } from "../facts/types.js";
import { stableId } from "../model/ids.js";
import type { Module, Service, SourceRef } from "../model/types.js";
import type { LoadedFile, Workspace } from "./load.js";
import { moduleClosure, parsePom, type MavenModule } from "./maven.js";

/**
 * Services and modules.
 *
 *   pom.xml* ─▶ MavenModules ─┐
 *   @SpringBootApplication ───┴▶ JavaService (classpath = module closure, config layers incl. Nacos)
 *   package.json (vue dep) ───▶ FrontendApp (.env, request baseURL, dev-server proxy)
 *
 * Service name precedence: atlas.yaml override > spring.application.name >
 * package.json name > artifactId / directory name.
 */

export interface JavaService {
  service: Service;
  appModule: MavenModule;
  /** Module directories (rootId-scoped) whose sources belong to this service. */
  classpath: { rootId: string; dir: string }[];
  config: ConfigView;
  profiles: string[];
  port: number;
  contextPath: string;
  configFiles: SourceRef[];
}

export interface ProxyRule {
  /** Path prefix the dev server intercepts, e.g. `/dev-api`; a leading `^` means a regular expression (Vite). */
  prefix: string;
  target: string;
  /** Rewrites the prefix away before forwarding. */
  stripPrefix: boolean;
  at: SourceRef;
}

export interface FrontendApp {
  service: Service;
  dir: string;
  env: ConfigView;
  /** Base path prepended to every request (axios baseURL), already resolved. */
  baseApi: string;
  proxies: ProxyRule[];
  devPort?: number;
  configFiles: SourceRef[];
}

export interface DetectedProject {
  services: Service[];
  java: JavaService[];
  frontends: FrontendApp[];
  maven: MavenModule[];
  modules: Module[];
  nacos: (NacosConfigRow & { at: SourceRef })[];
}

export interface DetectOptions {
  /** atlas.yaml service overrides keyed by `${rootId}:${dir}` or service name. */
  serviceNames?: Record<string, string>;
}

function dirOf(relPath: string): string {
  const slash = relPath.lastIndexOf("/");
  return slash < 0 ? "" : relPath.slice(0, slash);
}

const within = withinDir;

function owningModule(file: LoadedFile, modules: readonly MavenModule[]): MavenModule | undefined {
  let best: MavenModule | undefined;
  for (const m of modules) {
    if (m.rootId !== file.rootId || !within(m.dir, file.relPath)) continue;
    if (!best || m.dir.length > best.dir.length) best = m;
  }
  return best;
}

function configDocuments(file: LoadedFile): ConfigDocument[] {
  if (!file.text) return [];
  if (file.kind === "yaml") return parseYamlConfig(file.text, file.rootId, file.relPath);
  if (file.kind === "properties") return [parsePropertiesConfig(file.text, file.rootId, file.relPath)];
  return [];
}

const PROFILE_TOKEN = /^@([\w.-]+)@$/;

/** Route keys across Spring Cloud Gateway generations (2025+ moved them under server.webflux / server.webmvc). */
export const GATEWAY_ROUTE_PREFIXES = [
  "spring.cloud.gateway.routes",
  "spring.cloud.gateway.server.webflux.routes",
  "spring.cloud.gateway.server.webmvc.routes",
  "spring.cloud.gateway.mvc.routes",
];

/** Maven resource filtering tokens (`@artifactId@`, `@project.version@`, `@profiles.active@`). */
function mavenTokens(module: MavenModule, all: readonly MavenModule[]): Record<string, string> {
  const root = all.find((m) => m.rootId === module.rootId && m.dir === "");
  const defaults = Object.assign({}, ...all.flatMap((m) => m.profiles.filter((p) => p.activeByDefault).map((p) => p.properties))) as Record<string, string>;
  return {
    ...defaults,
    ...(root?.properties ?? {}),
    ...module.properties,
    artifactId: module.artifactId,
    "project.artifactId": module.artifactId,
    groupId: module.groupId,
    "project.groupId": module.groupId,
  };
}

function activeProfiles(base: ConfigView, maven: readonly MavenModule[]): string[] {
  const raw = base.value("spring.profiles.active")?.value ?? "";
  const token = PROFILE_TOKEN.exec(raw.trim());
  let value = raw;
  if (token) {
    // Maven resource filtering: `active: @profiles.active@` → default profile's property.
    const property = token[1] ?? "";
    value = "";
    for (const m of maven) {
      const profile = m.profiles.find((p) => p.activeByDefault && p.properties[property] !== undefined);
      if (profile) {
        value = profile.properties[property] ?? "";
        break;
      }
    }
  }
  return value
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p && !p.includes("${"));
}

function javaService(
  app: { file: LoadedFile; typeName: string; line: number },
  appModule: MavenModule,
  maven: readonly MavenModule[],
  files: readonly LoadedFile[],
  nacos: DetectedProject["nacos"],
  options: DetectOptions,
): JavaService {
  const resourceDir = `${appModule.dir ? `${appModule.dir}/` : ""}src/main/resources/`;
  const resources = files.filter((f) => f.rootId === appModule.rootId && f.relPath.startsWith(resourceDir) && !f.relPath.slice(resourceDir.length).includes("/"));
  const named = (pattern: RegExp) => resources.filter((f) => pattern.test(f.relPath.slice(resourceDir.length)));
  const layer = (f: LoadedFile): ConfigLayer => ({ name: f.relPath, documents: configDocuments(f) });

  const bootstrap = named(/^bootstrap\.(ya?ml|properties)$/).map(layer);
  const application = named(/^application\.(ya?ml|properties)$/).map(layer);
  const tokens = mavenTokens(appModule, maven);
  const base = new ConfigView([...application, ...bootstrap], [], tokens);
  const profiles = activeProfiles(base, maven);

  const profiled = (prefix: string) =>
    profiles.flatMap((p) => named(new RegExp(`^${prefix}-${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(ya?ml|properties)$`)).map(layer)).reverse();
  const local: ConfigLayer[] = [...profiled("application"), ...application, ...profiled("bootstrap"), ...bootstrap];
  const localView = new ConfigView(local, profiles, tokens);

  const remote: ConfigLayer[] = [];
  // Spring Cloud Alibaba 2022+: `spring.config.import: optional:nacos:<dataId>` (later imports win).
  const imported = localView
    .list("spring.config.import")
    .map((e) => /^(?:optional:)?nacos:([^?]+)/.exec(localView.resolve(e.value).value.trim())?.[1])
    .filter((id): id is string => !!id)
    .reverse();
  if (nacos.length > 0 && (localView.get("spring.cloud.nacos.config.server-addr") || imported.length > 0)) {
    const appName = localView.value("spring.application.name")?.value ?? appModule.artifactId;
    const prefix = localView.value("spring.cloud.nacos.config.prefix")?.value || appName;
    const ext = localView.value("spring.cloud.nacos.config.file-extension")?.value || "properties";
    const dataIds = [
      ...imported,
      ...profiles.map((p) => `${prefix}-${p}.${ext}`),
      `${prefix}.${ext}`,
      prefix,
      ...localView.list("spring.cloud.nacos.config.extension-configs").filter((e) => /data-?id$/i.test(e.key)).map((e) => localView.resolve(e.value).value).reverse(),
      ...localView.list("spring.cloud.nacos.config.shared-configs").filter((e) => /(\]|data-?id)$/i.test(e.key)).map((e) => localView.resolve(e.value).value).reverse(),
    ];
    for (const dataId of [...new Set(dataIds)]) {
      const row = nacos.find((r) => r.dataId === dataId);
      if (!row) continue;
      const documents = dataId.endsWith(".properties")
        ? [parsePropertiesConfig(row.content, row.at.rootId, row.at.file)]
        : parseYamlConfig(row.content, row.at.rootId, row.at.file);
      // Remote content lines are relative to the dump row; point every entry at the row.
      for (const doc of documents) for (const entry of doc.entries) entry.at = { ...row.at };
      remote.push({ name: `nacos:${dataId}`, documents });
    }
  }

  const config = new ConfigView([...remote, ...local], profiles, tokens);
  const closure = moduleClosure(appModule, maven);
  const deps = new Set(closure.flatMap((m) => m.dependencies.map((d) => d.artifactId)));
  const isGateway = [...deps].some((d) => d.startsWith("spring-cloud-starter-gateway")) || GATEWAY_ROUTE_PREFIXES.some((p) => config.list(p).length > 0);
  const name =
    options.serviceNames?.[`${appModule.rootId}:${appModule.dir}`] ??
    config.value("spring.application.name")?.value ??
    appModule.artifactId;
  const port = Number.parseInt(config.value("server.port")?.value ?? "", 10);
  const service: Service = {
    id: stableId("service", name, `${appModule.rootId}:${appModule.dir}`),
    name,
    rootId: appModule.rootId,
    path: appModule.dir,
    stack: "java-spring",
    kind: isGateway ? "gateway" : "backend",
    evidence: { rootId: app.file.rootId, file: app.file.relPath, line: app.line },
  };
  return {
    service,
    appModule,
    classpath: closure.map((m) => ({ rootId: m.rootId, dir: m.dir })),
    config,
    profiles,
    port: Number.isFinite(port) ? port : 8080,
    contextPath: (config.value("server.servlet.context-path")?.value ?? "").replace(/\/$/, ""),
    configFiles: [...resources.map((f) => ({ rootId: f.rootId, file: f.relPath })), ...remote.map((r) => r.documents[0]?.entries[0]?.at).filter((a): a is SourceRef => !!a)],
  };
}

// ── Frontend ─────────────────────────────────────────────────────────────────

function envReference(value: ScriptValue | undefined): string | undefined {
  if (!value) return undefined;
  const text = value.kind === "member" ? value.text : value.kind === "expr" ? value.text : undefined;
  // import.meta.env.X, process.env.X, or loadEnv() results such as env.VITE_X / viteEnv.VITE_X
  const m = text ? /(?:import\.meta\.env|process\.env|\w*[eE]nv)\.((?:VITE|VUE_APP)_\w+|\w+)/.exec(text) : null;
  return m?.[1];
}

function resolveScriptString(value: ScriptValue | undefined, env: ConfigView, scope?: ScriptFileFacts): string | undefined {
  if (!value) return undefined;
  if (value.kind === "string") return value.value;
  if (value.kind === "identifier" && scope) {
    const variable = scope.variables.find((v) => v.name === value.name);
    return variable && variable.value.kind !== "identifier" ? resolveScriptString(variable.value, env, scope) : undefined;
  }
  const ref = envReference(value);
  if (ref) return env.value(ref)?.value;
  if (value.kind === "template") return value.value.replace(/\$\{(?:import\.meta\.env|process\.env)\.(\w+)\}/g, (_m, k: string) => env.value(k)?.value ?? "");
  return undefined;
}

function resolveKey(key: string, env: ConfigView): string {
  if (!key.startsWith("[")) return key;
  const inner = key.slice(1, -1);
  // `['^' + process.env.VUE_APP_BASE_API]` or `[process.env.VUE_APP_BASE_API]`
  return inner
    .split("+")
    .map((part) => {
      const lit = /^['"`](.*)['"`]$/.exec(part.trim());
      if (lit) return lit[1] ?? "";
      const m = /(?:import\.meta\.env|process\.env)\.(\w+)/.exec(part);
      return m ? (env.value(m[1] ?? "")?.value ?? "") : part.trim();
    })
    .join("");
}

function objectAt(value: ScriptValue | undefined, ...keys: string[]): Record<string, ScriptValue> | undefined {
  let current = value;
  for (const key of keys) {
    if (current?.kind === "call") current = current.args[0];
    if (current?.kind === "function") current = current.returns;
    if (current?.kind !== "object") return undefined;
    current = current.props[key];
  }
  if (current?.kind === "call") current = current.args[0];
  if (current?.kind === "function") current = current.returns;
  return current?.kind === "object" ? current.props : undefined;
}

function proxyRules(config: LoadedFile | undefined, env: ConfigView): { proxies: ProxyRule[]; port?: number } {
  const facts = config?.facts as ScriptFileFacts | undefined;
  if (!config || !facts?.defaultExport) return { proxies: [] };
  let exp = facts.defaultExport;
  if (exp.kind === "identifier") {
    // `const viteConfig = defineConfig(...); export default viteConfig;`
    const name = exp.name;
    exp = facts.variables.find((v) => v.name === name)?.value ?? exp;
  }
  const server = objectAt(exp, "server") ?? objectAt(exp, "devServer");
  if (!server) return { proxies: [] };
  const portValue = server["port"];
  const proxies: ProxyRule[] = [];
  const proxy = server["proxy"];
  if (proxy?.kind === "object") {
    for (const [rawKey, rule] of Object.entries(proxy.props)) {
      const prefix = resolveKey(rawKey, env);
      if (!prefix) continue;
      const at: SourceRef = { rootId: config.rootId, file: config.relPath };
      if (rule.kind === "string" || rule.kind === "identifier") {
        proxies.push({ prefix, target: resolveScriptString(rule, env, facts) ?? "", stripPrefix: false, at });
        continue;
      }
      if (rule.kind !== "object") continue;
      const target = resolveScriptString(rule.props["target"], env, facts) ?? "";
      const rewrite = rule.props["rewrite"];
      const pathRewrite = rule.props["pathRewrite"];
      const strip =
        (rewrite?.kind === "function" && /replace\(\s*\/\^/.test(rewrite.text) && /,\s*['"]{2}\s*\)/.test(rewrite.text)) ||
        (pathRewrite?.kind === "object" && Object.entries(pathRewrite.props).some(([k, v]) => resolveKey(k, env).startsWith("^") && v.kind === "string" && v.value === ""));
      proxies.push({ prefix, target, stripPrefix: strip, at });
    }
  }
  const result: { proxies: ProxyRule[]; port?: number } = { proxies };
  if (portValue?.kind === "number") result.port = portValue.value;
  return result;
}

function frontendApp(manifest: LoadedFile, files: readonly LoadedFile[], options: DetectOptions): FrontendApp | undefined {
  let pkg: { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(manifest.text ?? "{}");
  } catch {
    return undefined;
  }
  if (!pkg.dependencies?.["vue"] && !pkg.devDependencies?.["vue"]) return undefined;
  const dir = dirOf(manifest.relPath);
  const inApp = (f: LoadedFile) => f.rootId === manifest.rootId && dirOf(f.relPath) === dir;
  const envFiles = files.filter((f) => inApp(f) && f.kind === "env" && /\/?\.env(\.development)?$/.test(f.relPath));
  const env = new ConfigView(
    envFiles
      .sort((a, b) => (a.relPath.endsWith(".development") ? -1 : b.relPath.endsWith(".development") ? 1 : 0))
      .map((f) => ({ name: f.relPath, documents: [parseDotEnv(f.text ?? "", f.rootId, f.relPath)] })),
  );

  const prefix = dir ? `${dir}/` : "";
  const requestFile = files.find((f) => f.rootId === manifest.rootId && new RegExp(`^${prefix}src/utils/request\\.[jt]s$`).test(f.relPath));
  let baseApi = "";
  const requestFacts = requestFile?.facts as ScriptFileFacts | undefined;
  for (const call of [...(requestFacts?.calls ?? []), ...(requestFacts?.variables ?? []).flatMap((v) => (v.value.kind === "call" ? [{ callee: v.value.callee, args: v.value.args, line: v.line }] : []))]) {
    if (!/axios\.create$/.test(call.callee)) continue;
    const opts = call.args[0];
    if (opts?.kind === "object") baseApi = resolveScriptString(opts.props["baseURL"], env) ?? "";
  }

  if (!baseApi) {
    // Convention fallback when baseURL is computed indirectly (pig, vben/Jeecg templates).
    for (const key of ["VITE_APP_BASE_API", "VUE_APP_BASE_API", "VITE_API_URL", "VITE_GLOB_API_URL", "VITE_BASE_API"]) {
      const v = env.value(key)?.value;
      if (v && v.startsWith("/")) {
        baseApi = v;
        break;
      }
    }
  }
  const devConfig = files.find((f) => inApp(f) && /(^|\/)(vite|vue)\.config\.[cm]?[jt]s$/.test(f.relPath));
  const { proxies, port } = proxyRules(devConfig, env);
  const vbenProxy = env.get("VITE_PROXY");
  if (proxies.length === 0 && vbenProxy) {
    // vben convention: VITE_PROXY=[["/prefix","http://host:port/ctx"]] with the prefix rewritten away.
    try {
      const pairs = JSON.parse(vbenProxy.value) as unknown;
      if (Array.isArray(pairs)) {
        for (const pair of pairs) {
          if (Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string") proxies.push({ prefix: pair[0], target: pair[1], stripPrefix: true, at: vbenProxy.at });
        }
      }
    } catch {
      // not JSON: ignore, the call stays unresolved with a diagnostic
    }
  }
  const name = options.serviceNames?.[`${manifest.rootId}:${dir}`] ?? pkg.name ?? (dir || "frontend");
  const service: Service = {
    id: stableId("service", name, `${manifest.rootId}:${dir}`),
    name,
    rootId: manifest.rootId,
    path: dir,
    stack: "vue",
    kind: "frontend",
    evidence: { rootId: manifest.rootId, file: manifest.relPath, line: 1 },
  };
  const app: FrontendApp = {
    service,
    dir,
    env,
    baseApi: baseApi.replace(/\/$/, ""),
    proxies,
    configFiles: [manifest, ...envFiles, ...(devConfig ? [devConfig] : []), ...(requestFile ? [requestFile] : [])].map((f) => ({ rootId: f.rootId, file: f.relPath })),
  };
  if (port !== undefined) app.devPort = port;
  return app;
}

// ── Modules ──────────────────────────────────────────────────────────────────

function countFiles(files: readonly LoadedFile[], rootId: string, dir: string, exclude: readonly string[] = []): { fileCount: number; loc: number } {
  let fileCount = 0;
  let loc = 0;
  for (const f of files) {
    if (f.rootId !== rootId || !within(dir, f.relPath) || exclude.some((e) => within(e, f.relPath))) continue;
    fileCount++;
    loc += f.lines;
  }
  return { fileCount, loc };
}

export function detectProject(workspace: Workspace, options: DetectOptions = {}): DetectedProject {
  const { files } = workspace;
  const maven = files.filter((f) => f.kind === "maven-pom").map(parsePom).filter((m): m is MavenModule => !!m);
  const nacos = files
    .filter((f) => f.kind === "sql" && f.text && /config_info/i.test(f.text))
    .flatMap((f) => parseNacosSqlDump(f.text ?? "").map((row) => ({ ...row, at: { rootId: f.rootId, file: f.relPath, line: row.line } })));

  const java: JavaService[] = [];
  const seenModules = new Set<MavenModule>();
  for (const file of files) {
    const facts = file.facts;
    if (facts?.lang !== "java") continue;
    const app = (facts as JavaFileFacts).types.find((t) => t.annotations.some((a) => a.name === "SpringBootApplication"));
    if (!app) continue;
    const module = owningModule(file, maven);
    if (!module || seenModules.has(module)) continue;
    seenModules.add(module);
    java.push(javaService({ file, typeName: app.name, line: app.line }, module, maven, files, nacos, options));
  }

  const frontends = files
    .filter((f) => f.kind === "npm-manifest" && !f.relPath.includes("node_modules/"))
    .map((f) => frontendApp(f, files, options))
    .filter((a): a is FrontendApp => !!a);

  // Disambiguate duplicate names across roots (e.g. two apps both called "ruoyi").
  const services = [...java.map((j) => j.service), ...frontends.map((f) => f.service)];
  const counts = new Map<string, number>();
  for (const s of services) counts.set(s.name, (counts.get(s.name) ?? 0) + 1);
  for (const s of services) {
    if ((counts.get(s.name) ?? 0) > 1) {
      const root = workspace.roots.find((r) => r.id === s.rootId);
      const suffix = s.path || (root ? root.path.replace(/\\/g, "/").split("/").pop() : s.rootId);
      s.name = `${s.name} (${suffix})`;
      s.id = stableId("service", s.name, `${s.rootId}:${s.path}`);
    }
  }

  const modules: Module[] = [];
  const moduleIdOf = new Map<MavenModule, string>();
  const ownerOf = (m: MavenModule): Service | undefined =>
    java.find((j) => j.appModule === m)?.service ??
    [...java].sort((a, b) => a.service.name.localeCompare(b.service.name)).find((j) => j.classpath.some((c) => c.rootId === m.rootId && c.dir === m.dir))?.service;
  for (const m of maven) {
    if (m.packaging === "pom") continue;
    const owner = ownerOf(m);
    const id = stableId("module", owner?.name ?? "", `${m.rootId}:${m.dir}`);
    moduleIdOf.set(m, id);
    modules.push({ id, serviceId: owner?.id ?? "", name: m.artifactId, path: m.dir, kind: "build-module", dependsOn: [], ...countFiles(files, m.rootId, m.dir, maven.filter((o) => o !== m && o.dir.startsWith(`${m.dir}/`)).map((o) => o.dir)) });
  }
  for (const m of maven) {
    const id = moduleIdOf.get(m);
    const module = modules.find((x) => x.id === id);
    if (!module) continue;
    module.dependsOn = m.dependencies.map((d) => maven.find((o) => o.artifactId === d.artifactId)).filter((o): o is MavenModule => !!o).map((o) => moduleIdOf.get(o)).filter((x): x is string => !!x);
  }
  for (const app of frontends) {
    const viewsDir = `${app.dir ? `${app.dir}/` : ""}src/views`;
    const viewDirs = new Set(
      files
        .filter((f) => f.rootId === app.service.rootId && f.relPath.startsWith(`${viewsDir}/`))
        .map((f) => f.relPath.slice(viewsDir.length + 1).split("/"))
        .filter((parts) => parts.length > 1)
        .map((parts) => parts[0] as string),
    );
    for (const view of [...viewDirs].sort()) {
      const dir = `${viewsDir}/${view}`;
      modules.push({ id: stableId("module", app.service.name, `${app.service.rootId}:${dir}`), serviceId: app.service.id, name: `views/${view}`, path: dir, kind: "package", dependsOn: [], ...countFiles(files, app.service.rootId, dir) });
    }
    modules.push({
      id: stableId("module", app.service.name, `${app.service.rootId}:${app.dir}`),
      serviceId: app.service.id,
      name: app.service.name,
      path: app.dir,
      kind: "frontend-app",
      dependsOn: [],
      ...countFiles(files, app.service.rootId, app.dir, [...viewDirs].map((v) => `${viewsDir}/${v}`)),
    });
  }

  return { services, java, frontends, maven, modules, nacos };
}
