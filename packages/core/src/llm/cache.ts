import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * LLM response cache (ENG-A10).
 *
 *   key = sha256(phase \0 inputHash \0 analyzerVersion \0 promptVersion \0 model)
 *   file = <dir>/llm/<key[0..2]>/<key>.json   ← written via tmp + rename
 *
 * Upstream summaries are keyed by their children's INPUT hashes (see
 * pipeline.ts), so a nondeterministic child answer never invalidates parents.
 * The cache is best-effort: write failures are swallowed, corrupt entries are
 * misses and get deleted.
 */

export interface LlmCache {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  /** Drop one entry (e.g. its value no longer validates). */
  delete(key: string): Promise<void>;
}

export interface CacheKeyParts {
  phase: string;
  inputHash: string;
  analyzerVersion: string;
  promptVersion: string;
  model: string;
}

export function cacheKey(parts: CacheKeyParts): string {
  return sha256(
    [parts.phase, parts.inputHash, parts.analyzerVersion, parts.promptVersion, parts.model].join("\0"),
  );
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const ENTRY_VERSION = 1;

interface Entry {
  v: typeof ENTRY_VERSION;
  value: unknown;
}

export class FileLlmCache implements LlmCache {
  constructor(private readonly dir: string) {}

  pathFor(key: string): string {
    if (!/^[0-9a-f]{8,}$/.test(key)) throw new Error(`FileLlmCache: invalid key ${key}`);
    return join(this.dir, "llm", key.slice(0, 2), `${key}.json`);
  }

  async get(key: string): Promise<unknown> {
    const file = this.pathFor(key);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return undefined;
    }
    try {
      const entry = JSON.parse(raw) as Partial<Entry> | null;
      if (entry && entry.v === ENTRY_VERSION && "value" in entry && entry.value !== undefined) return entry.value;
    } catch {
      // corrupt JSON — fall through
    }
    await this.delete(key);
    return undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    const file = this.pathFor(key);
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await mkdir(join(this.dir, "llm", key.slice(0, 2)), { recursive: true });
      const entry: Entry = { v: ENTRY_VERSION, value };
      await writeFile(tmp, JSON.stringify(entry), "utf8");
      await rename(tmp, file);
    } catch {
      await rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true }).catch(() => undefined);
  }
}

export class MemoryLlmCache implements LlmCache {
  readonly entries = new Map<string, unknown>();

  get(key: string): Promise<unknown> {
    return Promise.resolve(this.entries.get(key));
  }

  set(key: string, value: unknown): Promise<void> {
    this.entries.set(key, structuredClone(value));
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }
}
