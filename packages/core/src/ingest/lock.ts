import { randomBytes } from "node:crypto";
import {
  type Stats,
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { isThisHost, ownStartMs, ownerIsStale, thisHost } from "../util/process-owner.js";

/**
 * Task 11c: one ingest per org at a time. `<dataDir>/<orgId>.ingest.lock` is
 * created exclusively (O_EXCL) and holds `{pid, host, startedAt, token}`.
 *
 * A lock is stale only when its owner is gone on THIS host: the pid is dead,
 * or alive but a different process (it started after the recorded start: a
 * reused pid). A stale lock is removed and taken. A lock from another host is
 * never auto-removed (its pid cannot be probed here). A lock carrying our own
 * pid is live only if this process holds it (a second ingest in the same
 * process refuses); otherwise it was left by an earlier process that had our
 * pid (a container restart) and is stale. An unreadable / half-written lock
 * is live for 60 s (its writer may still be between create and write), stale
 * after.
 *
 * Breaking a stale lock happens under `<lock>.break` (O_EXCL), and only if
 * the file is still the one judged stale (same content, inode, size and
 * mtime): two runs racing to break the same stale lock cannot delete each
 * other's fresh lock. A lock is written to a temp file and hard-linked into
 * place, so it is never observable empty (N-2).
 */

export interface IngestLockHolder {
  pid: number;
  host: string | null;
  startedAt: string;
  token?: string;
  /** The holder process's start time (epoch ms). */
  procStartMs?: number;
}

export class IngestLockedError extends Error {
  constructor(
    message: string,
    readonly holder: IngestLockHolder | null,
    readonly lockPath: string,
  ) {
    super(message);
    this.name = "IngestLockedError";
  }
}

export interface IngestLock {
  path: string;
  release(): void;
}

const UNPARSEABLE_GRACE_MS = 60_000;
/** A `.break` file older than this was left by a crash mid-break. */
const BREAKER_STALE_MS = 10_000;
/** Tokens of the locks this process holds. */
const heldTokens = new Set<string>();

export function ingestLockPath(dir: string, orgId: string): string {
  return path.join(dir, `${orgId}.ingest.lock`);
}

function readRaw(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function parseHolder(raw: string | null): IngestLockHolder | null {
  if (raw === null) return null;
  try {
    const j = JSON.parse(raw) as Partial<IngestLockHolder>;
    if (typeof j.pid !== "number") return null;
    return {
      pid: j.pid,
      host: typeof j.host === "string" ? j.host : null,
      startedAt: typeof j.startedAt === "string" ? j.startedAt : "?",
      ...(typeof j.token === "string" ? { token: j.token } : {}),
      ...(typeof j.procStartMs === "number" ? { procStartMs: j.procStartMs } : {}),
    };
  } catch {
    return null;
  }
}

const readHolder = (p: string): IngestLockHolder | null => parseHolder(readRaw(p));

function holderIsStale(h: IngestLockHolder): boolean {
  if (h.pid === process.pid && isThisHost(h.host)) {
    return !(h.token !== undefined && heldTokens.has(h.token));
  }
  const taken = Date.parse(h.startedAt);
  return ownerIsStale({
    pid: h.pid,
    host: h.host,
    procStartMs: h.procStartMs ?? null,
    takenAtMs: Number.isFinite(taken) ? taken : null,
  });
}

/**
 * Remove the lock at `p` if it still holds `staleRaw`, under an exclusive
 * `.break` file. Returns false when another run is breaking it right now.
 */
type FileId = Pick<Stats, "ino" | "size" | "mtimeMs">;
const sameFile = (a: FileId, b: FileId): boolean =>
  a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

function statOrNull(p: string): FileId | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

function breakStale(p: string, staleRaw: string, staleStat: FileId): boolean {
  const brk = `${p}.break`;
  let fd: number | undefined;
  for (let i = 0; i < 2 && fd === undefined; i++) {
    try {
      fd = openSync(brk, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let age = 0;
      try {
        age = Date.now() - statSync(brk).mtimeMs;
      } catch {
        continue; // released meanwhile: retry
      }
      if (age <= BREAKER_STALE_MS) return false;
      try {
        unlinkSync(brk);
      } catch {
        /* another run removed it */
      }
    }
  }
  if (fd === undefined) return false;
  try {
    const now = statOrNull(p);
    if (now && sameFile(now, staleStat) && readRaw(p) === staleRaw) {
      try {
        unlinkSync(p);
      } catch {
        /* already gone */
      }
    }
  } finally {
    closeSync(fd);
    try {
      unlinkSync(brk);
    } catch {
      /* already gone */
    }
  }
  return true;
}

/**
 * Create `p` holding `body`, failing with EEXIST when it exists. Written to a
 * temp file and hard-linked into place (atomic, never empty); where hard
 * links are unsupported, O_EXCL create + write.
 */
function createLock(p: string, body: string, token: string): void {
  const tmp = `${p}.${token}.tmp`;
  writeFileSync(tmp, body, { flag: "wx" });
  try {
    linkSync(tmp, p);
    return;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "ENOSYS") throw e;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
  }
  const fd = openSync(p, "wx");
  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
}

function lockedMessage(label: string, h: IngestLockHolder | null, p: string): string {
  if (!h) return `ingest already running for ${label} (lock ${p} is being written); retry later`;
  if (isThisHost(h.host)) {
    return `ingest already running for ${label} (pid ${h.pid} since ${h.startedAt}); retry later`;
  }
  return `ingest already running for ${label} (pid ${h.pid} on host ${h.host} since ${h.startedAt}); retry later — if no ingest is running on ${h.host}, delete ${p}`;
}

export function acquireIngestLock(opts: {
  dir: string;
  orgId: string;
  /** Shown in the refusal message (the alias the user typed). Default: orgId. */
  orgLabel?: string;
  /** Test hook: runs after a lock was judged stale, before it is broken. */
  _beforeBreak?: () => void;
}): IngestLock {
  const p = ingestLockPath(opts.dir, opts.orgId);
  const label = opts.orgLabel ?? opts.orgId;
  mkdirSync(opts.dir, { recursive: true });
  const token = randomBytes(8).toString("hex");
  const procStartMs = ownStartMs();
  const body = JSON.stringify({
    pid: process.pid,
    host: thisHost(),
    startedAt: new Date().toISOString(),
    ...(procStartMs !== null ? { procStartMs } : {}),
    token,
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      createLock(p, body, token);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const raw = readRaw(p);
      const st = statOrNull(p);
      if (raw === null || st === null) continue; // vanished: retry
      const holder = parseHolder(raw);
      const stale = holder ? holderIsStale(holder) : Date.now() - st.mtimeMs > UNPARSEABLE_GRACE_MS;
      if (stale && attempt === 0) {
        opts._beforeBreak?.();
        breakStale(p, raw, st);
        continue;
      }
      throw new IngestLockedError(lockedMessage(label, holder, p), holder, p);
    }
    heldTokens.add(token);
    let released = false;
    return {
      path: p,
      release() {
        if (released) return;
        released = true;
        heldTokens.delete(token);
        // Only remove the lock we wrote: a stale-removal by another run may
        // have replaced it.
        if (readHolder(p)?.token !== token) return;
        try {
          unlinkSync(p);
        } catch {
          /* already gone */
        }
      },
    };
  }
  const holder = readHolder(p);
  throw new IngestLockedError(lockedMessage(label, holder, p), holder, p);
}
