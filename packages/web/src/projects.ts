import { createHash } from "node:crypto";
import { access, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { AnalysisController, HostSession, RuntimeHost, isAllowedGitUrl, shallowClone, toUserFacing, type UserFacingError, type WebviewCommand } from "@project-atlas/core";
import { EventHub, PromptBroker } from "./sse.js";
import { readJson, writeJsonAtomic, type SettingsStore } from "./store.js";
import { webEnv } from "./web-env.js";

/**
 * Imported projects.
 *
 *   import(path | git URL, trusted) ─▶ validate ─▶ id = sha1(realpath)[0..16]
 *     ─▶ storage: <repo>/.atlas when writable (same place as the extension and the CLI),
 *        else ~/.project-atlas/projects/<id>/.atlas (read-only checkout, git import)
 *   open(id) ─▶ ProjectSession (AnalysisController + RuntimeHost + HostSession + SSE hub)
 *     at most MAX_LOADED in memory (least recently used idle one is unloaded)
 *   analyses run one at a time across projects (parse workers are per analysis)
 */

const MAX_LOADED = 3;

export interface ProjectRecord {
  id: string;
  name: string;
  /** Root folder analyzed (a checkout under the home for git imports). */
  path: string;
  atlasDir: string;
  storage: "repo" | "home";
  source: "local" | "git";
  gitUrl?: string;
  trusted: boolean;
  addedAt: string;
  openedAt: string;
  memento: Record<string, unknown>;
}

export class ImportError extends Error {
  constructor(readonly userFacing: UserFacingError) {
    super(userFacing.problem);
  }
}

export interface ProjectSession {
  record: ProjectRecord;
  controller: AnalysisController;
  runtime: RuntimeHost;
  session: HostSession;
  hub: EventHub;
  prompts: PromptBroker;
  lastUsed: number;
  runCommand(command: WebviewCommand): Promise<void>;
}

/** Cleans a path the user pasted (quotes from Explorer "Copy as path", trailing separators). */
export function cleanPathInput(input: string): string {
  let p = input.trim();
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) p = p.slice(1, -1).trim();
  if (p.startsWith("~")) p = path.join(homedir(), p.slice(1));
  while (p.length > 1 && /[\\/]$/.test(p) && !/^[A-Za-z]:[\\/]$/.test(p)) p = p.slice(0, -1);
  return p;
}

export function isGitUrl(input: string): boolean {
  return /^(https:\/\/|git@)/.test(input.trim());
}

/** UNC and device paths can leak the user's NTLM hash to a remote host on access. */
function isRemoteOrDevicePath(p: string): boolean {
  return /^(\\\\|\/\/)/.test(p);
}

/** Importing the home folder or a drive root exposes far more than one project. */
export function isBroadRoot(p: string): boolean {
  const resolved = path.resolve(p);
  return resolved === path.resolve(homedir()) || path.dirname(resolved) === resolved;
}

async function writable(dir: string): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    await writeFile(probe, "");
    await rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

export interface RegistryOptions {
  home: string;
  settings: SettingsStore;
  assets: { wasmDir?: string; workerPath?: string };
  log: (line: string) => void;
}

export class ProjectRegistry {
  private records: ProjectRecord[] = [];
  private readonly loaded = new Map<string, ProjectSession>();
  private analysisQueue: Promise<unknown> = Promise.resolve();

  private constructor(private readonly options: RegistryOptions) {}

  static async open(options: RegistryOptions): Promise<ProjectRegistry> {
    const registry = new ProjectRegistry(options);
    const stored = await readJson<{ projects?: ProjectRecord[] }>(registry.file, {});
    registry.records = (stored.projects ?? []).filter((r) => typeof r.id === "string" && typeof r.path === "string");
    return registry;
  }

  private get file(): string {
    return path.join(this.options.home, "projects.json");
  }

  private async save(): Promise<void> {
    await writeJsonAtomic(this.file, { version: 1, projects: this.records });
  }

  list(): ProjectRecord[] {
    return [...this.records].sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  }

  get(id: string): ProjectRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  /** Import (or re-open) a local folder or a git URL. */
  async import(input: string, trusted: boolean, signal?: AbortSignal): Promise<{ record: ProjectRecord; warning?: "broad-root" }> {
    const raw = input.trim();
    if (!raw) throw importError("ATLAS-E082", "empty", "Enter a folder path or a git URL.");
    if (isGitUrl(raw)) return { record: await this.importGit(raw, trusted, signal) };
    const cleaned = cleanPathInput(raw);
    if (isRemoteOrDevicePath(cleaned)) throw importError("ATLAS-E082", cleaned, "Network (UNC) and device paths are not supported; copy the project to a local folder.");
    if (!path.isAbsolute(cleaned)) throw importError("ATLAS-E082", cleaned, "Use an absolute path, e.g. D:\\code\\RuoYi-Vue or /home/me/RuoYi-Vue.");
    let real: string;
    try {
      real = await realpath(cleaned);
      if (!(await stat(real)).isDirectory()) throw new Error("not a directory");
      await access(real);
    } catch (error) {
      throw importError("ATLAS-E082", cleaned, (error as NodeJS.ErrnoException).code === "ENOENT" ? "The folder does not exist." : (error as Error).message === "not a directory" ? "This is a file, not a folder." : `The folder cannot be read (${(error as Error).message}).`);
    }
    const id = projectId(real);
    const existing = this.get(id);
    const now = new Date().toISOString();
    if (existing) {
      existing.openedAt = now;
      if (trusted) existing.trusted = true;
      await this.save();
      return { record: existing, ...(isBroadRoot(real) ? { warning: "broad-root" as const } : {}) };
    }
    const repoAtlas = path.join(real, ".atlas");
    const inRepo = await writable(repoAtlas);
    const record: ProjectRecord = {
      id,
      name: path.basename(real) || real,
      path: real,
      atlasDir: inRepo ? repoAtlas : path.join(this.options.home, "projects", id, ".atlas"),
      storage: inRepo ? "repo" : "home",
      source: "local",
      trusted,
      addedAt: now,
      openedAt: now,
      memento: {},
    };
    this.records.push(record);
    await this.save();
    return { record, ...(isBroadRoot(real) ? { warning: "broad-root" as const } : {}) };
  }

  private async importGit(url: string, trusted: boolean, signal?: AbortSignal): Promise<ProjectRecord> {
    if (!isAllowedGitUrl(url)) throw importError("ATLAS-E030", url, "Only public https:// and git@host: URLs without credentials are supported.");
    const id = projectId(`git:${url}`);
    const existing = this.get(id);
    if (existing) {
      existing.openedAt = new Date().toISOString();
      await this.save();
      return existing;
    }
    const base = path.join(this.options.home, "projects", id);
    const atlasDir = path.join(base, ".atlas");
    let checkout: string;
    try {
      checkout = await shallowClone({ atlasDir, url, ...(signal ? { signal } : {}) });
    } catch (error) {
      throw new ImportError(toUserFacing(error));
    }
    const now = new Date().toISOString();
    const record: ProjectRecord = { id, name: url.replace(/\.git$/, "").split(/[/:]/).pop() || url, path: checkout, atlasDir, storage: "home", source: "git", gitUrl: url, trusted, addedAt: now, openedAt: now, memento: {} };
    this.records.push(record);
    await this.save();
    return record;
  }

  async remove(id: string): Promise<void> {
    const session = this.loaded.get(id);
    if (session) this.unload(session);
    this.records = this.records.filter((r) => r.id !== id);
    await this.save();
  }

  async setTrusted(id: string, trusted: boolean): Promise<void> {
    const record = this.get(id);
    if (!record) return;
    record.trusted = trusted;
    await this.save();
    this.loaded.get(id)?.runtime.trustChanged();
  }

  /** The live session for a project (loaded on demand, stored map restored). */
  async session(id: string): Promise<ProjectSession | undefined> {
    const record = this.get(id);
    if (!record) return undefined;
    const live = this.loaded.get(id);
    if (live) {
      live.lastUsed = Date.now();
      return live;
    }
    const hub = new EventHub();
    const prompts = new PromptBroker(hub);
    const log = (line: string) => this.options.log(`[${record.name}] ${line}`);
    const env = webEnv({
      settings: this.options.settings,
      hub,
      prompts,
      trusted: () => record.trusted,
      memento: {
        get: <T>(key: string, fallback: T) => (key in record.memento ? (record.memento[key] as T) : fallback),
        update: async (key, value) => {
          record.memento[key] = value;
          await this.save();
        },
      },
      assets: this.options.assets,
      log,
    });
    const controller = new AnalysisController({ env, atlasDir: record.atlasDir, roots: () => [{ path: record.path }] });
    const runtime = new RuntimeHost({ env, controller, workspaceDir: record.path });
    const runCommand = async (command: WebviewCommand): Promise<void> => {
      switch (command) {
        case "atlas.analyze":
        case "atlas.analyzeIncremental":
          await this.runExclusive(() => controller.analyze());
          return;
        case "atlas.cancel":
          controller.cancel();
          prompts.cancelAll();
          return;
        case "atlas.runtime.copyVmOptions":
        case "atlas.runtime.launch":
          await runtime.copyVmOptions();
          return;
        case "atlas.runtime.stop":
          await runtime.stop();
          return;
        case "atlas.runtime.clear":
          await runtime.clear();
          return;
        default:
          // configureProvider / export / diagnose are handled by the page itself.
          return;
      }
    };
    const session = new HostSession({ env, controller, runtime, post: (m) => hub.broadcast(m), runCommand });
    const project: ProjectSession = { record, controller, runtime, session, hub, prompts, lastUsed: Date.now(), runCommand };
    this.loaded.set(id, project);
    await controller.restore();
    await runtime.restore();
    this.evict();
    return project;
  }

  /** Run analyses one at a time (each one starts its own parse workers). */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.analysisQueue.then(fn, fn);
    this.analysisQueue = next.catch(() => undefined);
    return next;
  }

  /** Something is in flight (analysis, receiver with recent spans): keep the process alive. */
  busy(): boolean {
    for (const s of this.loaded.values()) {
      if (s.controller.busy) return true;
      if (s.runtime.running && Date.now() - (s.runtime.state.lastSpanAt ?? s.runtime.state.since ?? 0) < 30 * 60_000) return true;
    }
    return false;
  }

  /** Any tab connected to any project. */
  connected(): boolean {
    for (const s of this.loaded.values()) if (s.hub.size > 0) return true;
    return false;
  }

  private evict(): void {
    if (this.loaded.size <= MAX_LOADED) return;
    const idle = [...this.loaded.values()].filter((s) => s.hub.size === 0 && !s.controller.busy && !s.runtime.running).sort((a, b) => a.lastUsed - b.lastUsed);
    for (const s of idle.slice(0, this.loaded.size - MAX_LOADED)) this.unload(s);
  }

  private unload(s: ProjectSession): void {
    s.prompts.cancelAll();
    s.session.dispose();
    s.runtime.dispose();
    s.controller.dispose();
    s.hub.close();
    this.loaded.delete(s.record.id);
  }

  async close(): Promise<void> {
    for (const s of [...this.loaded.values()]) {
      s.controller.cancel();
      await s.runtime.stop();
      this.unload(s);
    }
  }
}

export function projectId(key: string): string {
  return createHash("sha1").update(process.platform === "win32" ? key.toLowerCase() : key).digest("hex").slice(0, 16);
}

function importError(code: string, input: string, fix: string): ImportError {
  return new ImportError({ code, problem: `Cannot import ${input}`, cause: fix, fix, docsUrl: `https://github.com/a805034104/project-atlas/blob/main/docs/errors.md#${code.toLowerCase()}` });
}
