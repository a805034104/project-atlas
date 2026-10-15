import { stat } from "node:fs/promises";
import type { CommitRecord, Diagnostic, ModuleHistory } from "../model/types.js";
import { LOG_FORMAT, parseGitLog } from "./parse.js";
import { DEFAULT_MAX_OUTPUT_BYTES, GitCommandError, GitNotFoundError, runGit } from "./run.js";

/**
 * Per-module git history (spec D8, AC#6 as revised by ENG-T4).
 *
 *   rev-parse ──▶ not a repo? ──▶ degraded "no-git" + ATLAS-I001
 *       │         git missing? ──▶ degraded "no-git" + ATLAS-E001
 *       ▼
 *   shallow? / HEAD
 *       ▼
 *   per module (pool of 4):
 *     git log -z --numstat --find-renames --format=… [--literal-pathspecs -- <path>]
 *       ▼
 *   parseGitLog ──▶ sort newest first ──▶ ModuleHistory
 *
 * Why one `git log` per module instead of one repo-wide pass with
 * longest-prefix attribution: AC#6 requires the count to equal
 * `git log -- <path>`, whose default history simplification (a) hides side-
 * branch commits whose changes a merge discarded for that path, and (b) shows
 * merges that are not TREESAME to any parent for that path (evil merges,
 * conflict resolutions) although they print no numstat. Neither can be
 * reconstructed from a repo-wide log, so we run the exact pathspec query.
 * Nested modules therefore also count their children's commits, matching
 * `git log -- <parent>`.
 */

export interface GitHistoryModule {
  id: string;
  /** Relative to `cwd`, forward slashes; "" = whole repo. */
  path: string;
}

export interface GitHistoryOptions {
  /** Repository root. */
  cwd: string;
  modules: GitHistoryModule[];
  /** Default 500. */
  maxCommitsPerModule?: number;
  since?: Date;
  signal?: AbortSignal;
  /** Default "git". */
  gitPath?: string;
  /** Cap on a single git invocation's stdout. Default 200 MB. */
  maxOutputBytes?: number;
}

export interface GitHistoryResult {
  history: ModuleHistory[];
  diagnostics: Diagnostic[];
  head?: string;
  shallow: boolean;
}

export const DEFAULT_MAX_COMMITS_PER_MODULE = 500;
const CONCURRENCY = 4;

/** `-c` overrides that make output independent of user config. */
const CONFIG_ARGS = [
  "-c", "core.quotepath=off",
  "-c", "i18n.logOutputEncoding=UTF-8",
  "-c", "log.follow=false",
  "-c", "log.showSignature=false",
  // Defense in depth against repo-local config: no fsmonitor hook, no external diff driver.
  "-c", "core.fsmonitor=false",
  "-c", "diff.external=",
  "--literal-pathspecs",
];

export function normalizeModulePath(p: string): string {
  let out = p.replace(/\\/g, "/");
  while (out.startsWith("./")) out = out.slice(2);
  out = out.replace(/\/+$/, "");
  return out === "." ? "" : out;
}

export function buildLogArgs(path: string, maxCount: number, since: Date | undefined): string[] {
  const args = [
    ...CONFIG_ARGS,
    "log",
    "-z",
    "--numstat",
    "--find-renames",
    "--no-color",
    "--no-ext-diff", "--no-textconv",
    `--format=${LOG_FORMAT}`,
    `--max-count=${maxCount}`,
  ];
  if (since) args.push(`--since=${since.toISOString()}`);
  const p = normalizeModulePath(path);
  if (p !== "") args.push("--", p);
  return args;
}

function degradedAll(modules: GitHistoryModule[], degraded: "no-git"): ModuleHistory[] {
  return modules.map((m) => ({ moduleId: m.id, commits: [], degraded }));
}

function sortNewestFirst(commits: CommitRecord[]): CommitRecord[] {
  // Stable sort: ties keep git's (commit-date) order.
  return commits
    .map((c, i) => ({ c, i, t: Date.parse(c.authorTime) }))
    .sort((a, b) => b.t - a.t || a.i - b.i)
    .map((x) => x.c);
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function collectModuleHistory(opts: GitHistoryOptions): Promise<GitHistoryResult> {
  const gitPath = opts.gitPath ?? "git";
  const maxCommits = opts.maxCommitsPerModule ?? DEFAULT_MAX_COMMITS_PER_MODULE;
  const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const { cwd, signal } = opts;
  const diagnostics: Diagnostic[] = [];

  // A missing cwd also surfaces as ENOENT from spawn; rule it out so ENOENT
  // reliably means "git binary missing".
  const st = await stat(cwd);
  if (!st.isDirectory()) throw new Error(`not a directory: ${cwd}`);

  const git = (args: string[]) => runGit({ gitPath, cwd, args, signal, maxBytes });

  let probe;
  try {
    probe = await git(["rev-parse", "--is-shallow-repository"]);
  } catch (err) {
    if (!(err instanceof GitNotFoundError)) throw err;
    diagnostics.push({
      code: "ATLAS-E001",
      severity: "error",
      message: `git is not installed or not executable (${gitPath}); install git or set the git path in settings. Change history is unavailable.`,
    });
    return { history: degradedAll(opts.modules, "no-git"), diagnostics, shallow: false };
  }
  if (probe.code !== 0) {
    if (/not a git repository/i.test(probe.stderr)) {
      diagnostics.push({
        code: "ATLAS-I001",
        severity: "info",
        message: `${cwd} is not a git repository; change history is unavailable.`,
      });
      return { history: degradedAll(opts.modules, "no-git"), diagnostics, shallow: false };
    }
    throw new GitCommandError(["rev-parse", "--is-shallow-repository"], probe.code, probe.stderr);
  }
  const shallow = probe.stdout.trim() === "true";

  const headRes = await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (headRes.code !== 0 && headRes.code !== 1) {
    throw new GitCommandError(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], headRes.code, headRes.stderr);
  }
  const head = headRes.code === 0 ? headRes.stdout.trim() : undefined;

  if (shallow) {
    diagnostics.push({
      code: "ATLAS-I002",
      severity: "info",
      message: "Shallow clone: change history is incomplete. Run `git fetch --unshallow` for full history.",
    });
  }

  const history = await mapPool(opts.modules, CONCURRENCY, async (m): Promise<ModuleHistory> => {
    const entry: ModuleHistory = { moduleId: m.id, commits: [] };
    if (shallow) entry.degraded = "shallow";
    if (head === undefined) return entry; // unborn branch: no commits yet

    const args = buildLogArgs(m.path, maxCommits, opts.since);
    const res = await git(args);
    if (!res.truncated && res.code !== 0) throw new GitCommandError(args, res.code, res.stderr);

    const parsed = parseGitLog(res.stdout);
    let commits = parsed.commits;
    if (res.truncated) {
      // The last parsed record may have lost numstat entries at the cut.
      if (!parsed.incomplete) commits = commits.slice(0, -1);
      diagnostics.push({
        code: "ATLAS-W001",
        severity: "warning",
        message: `git log output for module ${m.id} exceeded ${maxBytes} bytes; history truncated to ${commits.length} commits.`,
      });
    }
    entry.commits = sortNewestFirst(commits).slice(0, maxCommits);
    return entry;
  });

  const result: GitHistoryResult = { history, diagnostics, shallow };
  if (head !== undefined) result.head = head;
  return result;
}
