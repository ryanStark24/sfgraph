import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { safeGitConfig } from "../../analyze/wip-changed-files.js";

/**
 * When each source file last changed, for `lastModifiedAt` (and so for
 * `freshness_report`). One batched pass over git history, never one process per
 * file:
 *   - a tracked, clean file: the time of the last commit that touched it;
 *   - a file edited since HEAD, or untracked: its mtime (a local edit is the
 *     newest change there is);
 *   - not a git work tree, git missing or failing, or a file git does not know
 *     (ignored): its mtime.
 * A member made of several files (a bundle, an object folder) takes the newest
 * of its files.
 *
 *
 * Two cases where git cannot tell the real change time, and the answer is "no
 * authoritative time" (the lookup is null, so the ingest-time fallback applies
 * and a time already stored is kept) rather than a wrong one:
 *   - a shallow clone: a file whose newest visible commit is a shallow
 *     boundary commit last changed at some unknown earlier time;
 *   - a git log that timed out, hit the byte cap or failed: a tracked file the
 *     partial output never reached.
 * Files git does not track at all (untracked, ignored) still use their mtime.
 *
 * Bounded like the rest of the code base: every git call has a timeout and a
 * byte cap, and the number of git calls is fixed (never per file).
 */

/** What a runner hands back: stdout, null on failure, or stdout flagged partial (timeout / byte cap). */
export type GitRunResult = string | null | { stdout: string; partial: boolean };

/** Runs `git <args>` in `cwd`. */
export type GitRunner = (args: string[], cwd: string) => Promise<GitRunResult>;

export const GIT_TIMEOUT_MS = 60_000;
export const GIT_MAX_BYTES = 128 * 1024 * 1024;

export const execGit: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BYTES,
        windowsHide: true,
      },
      (err, stdout) => {
        // Timeout / overflow still hand back what was read, flagged partial.
        const out = typeof stdout === "string" ? stdout : "";
        if (err) resolve(out.length > 0 ? { stdout: out, partial: true } : null);
        else resolve(out);
      },
    );
  });

export function mtimeMs(p: string): number | null {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

export const WALK_MAX_ENTRIES = 5000;

/** mtime of a file, or the newest file mtime under a directory (bounded walk; the directory's own mtime if empty or unreadable). */
const ALL = (): boolean => true;

export function newestMtime(p: string, include: (file: string) => boolean = ALL): number | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    return null;
  }
  if (!st.isDirectory()) return st.mtimeMs;
  let newest = 0;
  let seen = 0;
  const queue = [p];
  while (queue.length > 0 && seen < WALK_MAX_ENTRIES) {
    const dir = queue.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > WALK_MAX_ENTRIES) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== ".git" && e.name !== "node_modules") queue.push(full);
      } else if (e.isFile()) {
        try {
          if (include(full)) newest = Math.max(newest, fs.statSync(full).mtimeMs);
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  }
  if (newest > 0) return newest;
  // Nothing matched: the directory's own mtime only for the unfiltered walk.
  return include === ALL ? st.mtimeMs : null;
}

const textOf = (r: GitRunResult): string =>
  r === null ? "" : typeof r === "string" ? r : r.stdout;

const splitZ = (s: string): string[] => s.split("\0").filter((p) => p.length > 0);

/** Parse `git log --format=%x01%ct --name-only -z` (newest commit first): file -> newest commit time (ms). */
export function parseGitLog(out: string): Map<string, number> {
  const times = new Map<string, number>();
  for (const [file, v] of parseGitLogDetailed(out)) times.set(file, v.ms);
  return times;
}

/** As `parseGitLog`, with the commit hash when the format is `%x01%ct %H`. */
export function parseGitLogDetailed(out: string): Map<string, { ms: number; hash: string }> {
  const times = new Map<string, { ms: number; hash: string }>();
  let ts = 0;
  let hash = "";
  for (const raw of out.split("\0")) {
    let tok = raw;
    if (tok.startsWith("\x01")) {
      const nl = tok.indexOf("\n");
      const head = nl >= 0 ? tok.slice(1, nl) : tok.slice(1);
      ts = Number.parseInt(head, 10) * 1000;
      hash = head.split(" ")[1] ?? "";
      tok = nl >= 0 ? tok.slice(nl + 1) : "";
    }
    tok = tok.replace(/^\n+/, "");
    if (!tok || !Number.isFinite(ts) || ts <= 0) continue;
    if (!times.has(tok)) times.set(tok, { ms: ts, hash });
  }
  return times;
}

export class ChangeTimes {
  private readonly files = new Map<string, number>();
  private readonly dirs = new Map<string, number>();
  /** Tracked files whose real change time git cannot give (shallow boundary, partial log): no authoritative time. */
  private readonly unknown = new Set<string>();

  private constructor(private readonly root: string) {}

  /**
   * Build the lookup for `scopeDirs` (absolute) under `root`. Never throws:
   * with no git signal every lookup is the mtime.
   */
  static async load(
    root: string,
    scopeDirs: string[],
    run: GitRunner = execGit,
  ): Promise<ChangeTimes> {
    const ct = new ChangeTimes(path.resolve(root));
    try {
      await ct.fill(scopeDirs, run);
    } catch {
      /* mtime fallback */
    }
    return ct;
  }

  private note(abs: string, ms: number): void {
    const prev = this.files.get(abs);
    if (prev !== undefined && prev >= ms) return;
    this.files.set(abs, ms);
    // Bubble up to the root so directory members read their newest file.
    let d = path.dirname(abs);
    while (d.startsWith(this.root)) {
      const cur = this.dirs.get(d);
      if (cur === undefined || cur < ms) this.dirs.set(d, ms);
      if (d === this.root || d === path.dirname(d)) break;
      d = path.dirname(d);
    }
  }

  private async fill(scopeDirs: string[], run: GitRunner): Promise<void> {
    const root = this.root;
    const cfg = safeGitConfig(root);
    if (!cfg) return;
    const inside = await run([...cfg, "rev-parse", "--is-inside-work-tree"], root);
    if (textOf(inside).trim() !== "true") return;
    const boundary = await this.shallowBoundary(cfg, run);
    const specs = scopeDirs
      .map((d) => path.relative(root, d))
      .filter((r) => r !== "" && !r.startsWith(".."))
      .map((r) => r.split(path.sep).join("/"));
    const spec = specs.length > 0 ? ["--", ...specs] : ["--", "."];

    const log = await run(
      [
        ...cfg,
        "log",
        "--format=%x01%ct %H",
        "--name-only",
        // Combined diff for merges: a file changed while resolving a conflict
        // is attributed to the merge commit, not an older parent.
        "-c",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--relative",
        "-z",
        ...spec,
      ],
      root,
    );
    // A failed, timed-out or truncated log leaves tracked files unseen.
    const partial = log === null || (typeof log === "object" && log.partial);
    for (const [rel, v] of parseGitLogDetailed(textOf(log))) {
      const abs = path.join(root, rel);
      if (boundary.has(v.hash)) this.unknown.add(abs);
      else this.note(abs, v.ms);
    }
    if (partial) {
      const tracked = await run([...cfg, "ls-files", "-z", ...spec], root);
      for (const rel of splitZ(textOf(tracked))) {
        const abs = path.join(root, rel);
        if (!this.files.has(abs)) this.unknown.add(abs);
      }
    }

    // Edited since HEAD or untracked: the file's own mtime, whatever git says.
    const diff = await run(
      [
        ...cfg,
        "diff",
        "HEAD",
        "--ignore-submodules",
        "--name-only",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--relative",
        "-z",
        ...spec,
      ],
      root,
    );
    const others = await run(
      [...cfg, "ls-files", "--others", "--exclude-standard", "-z", ...spec],
      root,
    );
    for (const rel of [...splitZ(textOf(diff)), ...splitZ(textOf(others))]) {
      const abs = path.join(root, rel);
      const m = mtimeMs(abs);
      if (m === null) continue;
      this.files.delete(abs);
      this.unknown.delete(abs);
      this.note(abs, m);
    }
  }

  /** Shallow boundary commit hashes (empty when the repository is not shallow). One fixed git call. */
  private async shallowBoundary(cfg: string[], run: GitRunner): Promise<Set<string>> {
    const out = new Set<string>();
    const res = textOf(
      await run(
        [...cfg, "rev-parse", "--is-shallow-repository", "--git-path", "shallow"],
        this.root,
      ),
    );
    const [flag, shallowFile] = res.split("\n").map((l) => l.trim());
    if (flag !== "true" || !shallowFile) return out;
    try {
      const raw = fs.readFileSync(path.resolve(this.root, shallowFile), "utf8");
      for (const h of raw.split("\n")) if (h.trim()) out.add(h.trim());
    } catch {
      /* unreadable: treated as no boundary known */
    }
    return out;
  }

  /**
   * Last change of a file, or of the newest file under a directory. Git's
   * answer when it has one; otherwise the file's mtime, and for a directory the
   * newest descendant file's mtime (editing a file does not bump its parent
   * directory's mtime). ISO string or null.
   */
  lookup(abs: string): string | null {
    const p = path.resolve(abs);
    if (this.unknown.has(p)) return null;
    const known = this.files.get(p) ?? this.dirs.get(p);
    if (known !== undefined && !this.isDirectory(p)) return new Date(known).toISOString();
    // A directory: git's time for its tracked files, and the mtime of every
    // descendant file git does not track (ignored files are not listed by
    // git, but the extractor still reads them). Bounded and memoised.
    let walked = this.walked.get(p);
    if (walked === undefined) {
      walked = this.newestUntracked(p);
      this.walked.set(p, walked);
    }
    const ms = known === undefined ? walked : walked === null ? known : Math.max(known, walked);
    return ms === null ? null : new Date(ms).toISOString();
  }

  private readonly walked = new Map<string, number | null>();

  private isDirectory(p: string): boolean {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  }

  /** Newest mtime among descendant files git has no time for; the plain mtime walk when git gave nothing at all. */
  private newestUntracked(dir: string): number | null {
    if (this.files.size === 0 && this.dirs.size === 0 && this.unknown.size === 0) {
      return newestMtime(dir);
    }
    return newestMtime(dir, (full) => !this.files.has(full) && !this.unknown.has(full));
  }
}
