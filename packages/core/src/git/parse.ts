import type { CommitRecord } from "../model/types.js";

/**
 * Parser for `git log -z --numstat --find-renames --format=LOG_FORMAT`.
 *
 * Byte layout per commit (RS = \x1e, NUL = \0):
 *
 *   RS sha NUL authorISO NUL author NUL message NUL   ← LOG_FORMAT
 *   NUL                                               ← -z commit terminator
 *   [ \n                                              ← only if a diff follows
 *     added TAB deleted TAB path NUL                  ← plain entry
 *     added TAB deleted TAB NUL old NUL new NUL       ← rename entry
 *     ... ]
 *
 * Binary files report `-` for added/deleted (counted as 0). Merge commits and
 * empty commits carry no numstat block. Every header field is NUL-terminated
 * and every numstat entry starts with a digit or `-`, so an RS at an entry
 * boundary unambiguously starts the next commit even if a message or path
 * itself contains RS.
 */

export const LOG_FORMAT = "%x1e%H%x00%aI%x00%an%x00%B%x00";

const RS = "\x1e";
const NUL = "\0";

export interface ParseResult {
  commits: CommitRecord[];
  /** True when the input ended inside a record (e.g. truncated output); that record is dropped. */
  incomplete: boolean;
}

class Cursor {
  pos = 0;
  constructor(readonly s: string) {}

  /** Reads up to (not including) `delim` and skips it; null if `delim` never appears. */
  until(delim: string): string | null {
    const end = this.s.indexOf(delim, this.pos);
    if (end < 0) return null;
    const out = this.s.slice(this.pos, end);
    this.pos = end + delim.length;
    return out;
  }

  skipSeparators(): void {
    while (this.pos < this.s.length) {
      const ch = this.s[this.pos];
      if (ch !== NUL && ch !== "\n") break;
      this.pos++;
    }
  }

  get done(): boolean {
    return this.pos >= this.s.length;
  }

  peek(): string | undefined {
    return this.s[this.pos];
  }
}

function toCount(raw: string): number {
  if (raw === "-") return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || String(n) !== raw) {
    throw new Error(`malformed numstat count: ${JSON.stringify(raw)}`);
  }
  return n;
}

function toUtcIso(raw: string): string {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error(`malformed author date: ${JSON.stringify(raw)}`);
  return d.toISOString();
}

/**
 * Parses one record; returns null if the input ends mid-record.
 * Assumes the cursor sits just past the leading RS.
 */
function parseRecord(c: Cursor): CommitRecord | null {
  const sha = c.until(NUL);
  const authorIso = c.until(NUL);
  const author = c.until(NUL);
  const message = c.until(NUL);
  if (sha === null || authorIso === null || author === null || message === null) return null;
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`malformed commit sha: ${JSON.stringify(sha)}`);

  const record: CommitRecord = {
    sha,
    authorTime: toUtcIso(authorIso),
    author,
    message: message.replace(/\s+$/, ""),
    added: 0,
    deleted: 0,
    files: [],
  };
  const seen = new Set<string>();
  const addFile = (p: string): void => {
    if (!seen.has(p)) {
      seen.add(p);
      record.files.push(p);
    }
  };

  for (;;) {
    c.skipSeparators();
    if (c.done || c.peek() === RS) return record;

    const added = c.until("\t");
    const deleted = added === null ? null : c.until("\t");
    if (added === null || deleted === null) return null;
    record.added += toCount(added);
    record.deleted += toCount(deleted);

    if (c.peek() === NUL) {
      c.pos++;
      const from = c.until(NUL);
      const to = from === null ? null : c.until(NUL);
      if (from === null || to === null) return null;
      addFile(from);
      addFile(to);
    } else {
      const path = c.until(NUL);
      if (path === null) return null;
      addFile(path);
    }
  }
}

export function parseGitLog(output: string): ParseResult {
  const c = new Cursor(output);
  const commits: CommitRecord[] = [];
  c.skipSeparators();
  while (!c.done) {
    if (c.peek() !== RS) {
      throw new Error(`unexpected git log output at offset ${c.pos}: ${JSON.stringify(output.slice(c.pos, c.pos + 40))}`);
    }
    c.pos++;
    const record = parseRecord(c);
    if (record === null) return { commits, incomplete: true };
    commits.push(record);
  }
  return { commits, incomplete: false };
}
