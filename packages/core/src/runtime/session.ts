import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Aggregator, type AggregateState } from "./aggregate.js";
import { DEFAULT_RECEIVER_PORT, startReceiver, type Receiver, type ReceiverStats } from "./receiver.js";
import type { SpanRecord } from "./span-record.js";
import { TraceStore } from "./store.js";

/**
 * One runtime session per workspace (V8):
 *
 *   .atlas/receiver.json  { pid, port, startedAt }  ← lock; a live owner means "use its endpoint"
 *   ~/.project-atlas/tokens/<sha1(workspace)>  per-workspace token (machine-local, stable across
 *                                              restarts, so apps launched earlier keep working)
 *   receiver ─▶ Aggregator (in memory) ─▶ store.append + debounced saveAggregates
 */

export class RuntimeLockedError extends Error {
  readonly code = "ATLAS-E074";
  constructor(
    readonly ownerPid: number,
    readonly port: number,
  ) {
    super(`Another ProjectAtlas process (pid ${ownerPid}) already receives traces for this workspace on port ${port}`);
  }
}

export interface RuntimeSessionOptions {
  /** Workspace root that contains `.atlas/`. */
  workspaceDir: string;
  /** Override for tests; default `~/.project-atlas`. */
  homeDir?: string;
  port?: number;
  onSpans?(fresh: SpanRecord[], state: AggregateState): void;
  onError?(error: unknown): void;
  saveDelayMs?: number;
}

export interface RuntimeStatus {
  port: number;
  endpoint: string;
  spans: number;
  duplicates: number;
  receiver: ReceiverStats;
  lastSpanAt?: number;
}

interface LockFile {
  pid: number;
  port: number;
  startedAt: string;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function atlasHome(homeDir?: string): string {
  return homeDir ?? process.env["PROJECT_ATLAS_HOME"] ?? path.join(homedir(), ".project-atlas");
}

/** Stable per-workspace token stored outside the workspace (never committed, never in launch.json). */
export async function workspaceToken(workspaceDir: string, homeDir?: string): Promise<string> {
  const dir = path.join(atlasHome(homeDir), "tokens");
  const file = path.join(dir, createHash("sha1").update(path.resolve(workspaceDir).toLowerCase()).digest("hex"));
  try {
    const existing = (await readFile(file, "utf8")).trim();
    if (/^[0-9a-f]{48}$/.test(existing)) return existing;
  } catch {
    // first use
  }
  const token = randomBytes(24).toString("hex");
  await mkdir(dir, { recursive: true });
  await writeFile(file, token, { mode: 0o600 });
  return token;
}

/** The live owner of this workspace's receiver, if any. */
export async function runtimeOwner(workspaceDir: string): Promise<LockFile | undefined> {
  try {
    const lock = JSON.parse(await readFile(path.join(workspaceDir, ".atlas", "receiver.json"), "utf8")) as LockFile;
    return Number.isInteger(lock.pid) && alive(lock.pid) && lock.pid !== process.pid ? lock : undefined;
  } catch {
    return undefined;
  }
}

export class RuntimeSession {
  private saveTimer: NodeJS.Timeout | undefined;
  private lastSpanAt: number | undefined;
  private constructor(
    readonly workspaceDir: string,
    readonly token: string,
    readonly store: TraceStore,
    readonly aggregator: Aggregator,
    private receiver: Receiver,
    private readonly options: RuntimeSessionOptions,
  ) {}

  static async start(options: RuntimeSessionOptions): Promise<RuntimeSession> {
    const atlasDir = path.join(options.workspaceDir, ".atlas");
    const owner = await runtimeOwner(options.workspaceDir);
    if (owner) throw new RuntimeLockedError(owner.pid, owner.port);
    const token = await workspaceToken(options.workspaceDir, options.homeDir);
    const store = new TraceStore(path.join(atlasDir, "traces"));
    const aggregator = new Aggregator(await store.loadAggregates());
    let session: RuntimeSession | undefined;
    const receiver = await startReceiver({
      token,
      port: options.port ?? DEFAULT_RECEIVER_PORT,
      onSpans: async (records) => {
        await session?.ingest(records);
      },
      ...(options.onError ? { onError: options.onError } : {}),
    });
    session = new RuntimeSession(options.workspaceDir, token, store, aggregator, receiver, options);
    await mkdir(atlasDir, { recursive: true });
    const lock: LockFile = { pid: process.pid, port: receiver.port, startedAt: new Date().toISOString() };
    await writeFile(path.join(atlasDir, "receiver.json"), JSON.stringify(lock, null, 2));
    return session;
  }

  get port(): number {
    return this.receiver.port;
  }

  get endpoint(): string {
    return this.receiver.endpoint;
  }

  /** Fold records in (receiver callback, or `trace import`). */
  async ingest(records: SpanRecord[]): Promise<SpanRecord[]> {
    const fresh = this.aggregator.add(records);
    if (fresh.length === 0) return fresh;
    this.lastSpanAt = Date.now();
    await this.store.append(fresh);
    this.scheduleSave();
    this.options.onSpans?.(fresh, this.aggregator.state);
    return fresh;
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.store.saveAggregates(this.aggregator.state).catch((error: unknown) => this.options.onError?.(error));
    }, this.options.saveDelayMs ?? 1000);
  }

  status(): RuntimeStatus {
    return {
      port: this.receiver.port,
      endpoint: this.receiver.endpoint,
      spans: this.aggregator.state.total,
      duplicates: this.aggregator.state.duplicates,
      receiver: this.receiver.stats,
      ...(this.lastSpanAt ? { lastSpanAt: this.lastSpanAt } : {}),
    };
  }

  async stop(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    await this.receiver.close();
    await this.store.saveAggregates(this.aggregator.state);
    const lockFile = path.join(this.workspaceDir, ".atlas", "receiver.json");
    try {
      const lock = JSON.parse(await readFile(lockFile, "utf8")) as LockFile;
      if (lock.pid === process.pid) await rm(lockFile, { force: true });
    } catch {
      // already gone
    }
  }
}
