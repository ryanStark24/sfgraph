import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  IngestLockedError,
  acquireIngestLock,
  rebuildBackupsKept,
  snapshotCountInFile,
} from "@ryanstark24/sfgraph-core";
import { validateOrgIdentifier } from "@ryanstark24/sfgraph-shared";

/**
 * Rebuild backups: `sfgraph ingest --rebuild` moves the old graph file to
 * `<dataDir>/backups/<orgId>.rebuild-<ISO stamp>.sqlite` (plus its -wal/-shm/-journal).
 * Every function here only touches files that match that name; anything else in
 * backups/ is reported, never removed (except by `storage clean --backups --apply`).
 *
 * A backup of an INCOMPLETE graph (the earlier rebuild's sync never finished) carries
 * a `<backup>.incomplete` marker file, written when the rebuild moves it. Such a backup
 * never counts toward the kept backups, so it cannot push out a complete one.
 */

/** SQLite files that live beside a database file. */
export const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"];
/** Marker kept beside a backup whose graph was never completed. */
export const INCOMPLETE_SUFFIX = ".incomplete";

const BACKUP_RE = /^(.+)\.rebuild-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.sqlite$/;

export interface BackupSet {
  /** File name of the main `.sqlite` file in backups/. */
  name: string;
  orgId: string;
  stamp: string;
  path: string;
  /** Main file plus sidecars and marker. */
  bytes: number;
  /** ISO time from the stamp (the time of the rebuild), or null if unreadable. */
  at: string | null;
  incomplete: boolean;
}

export interface OtherFile {
  name: string;
  path: string;
  bytes: number;
}

/** 1536 -> "1.5 KB"; 0 -> "0 B". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/** Bytes of a file or a directory tree; 0 for anything unreadable. */
export function pathBytes(p: string): number {
  try {
    const st = statSync(p);
    if (!st.isDirectory()) return st.size;
    let total = 0;
    for (const e of readdirSync(p)) total += pathBytes(path.join(p, e));
    return total;
  } catch {
    return 0;
  }
}

function sizeOrZero(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

function validOrg(id: string): boolean {
  try {
    validateOrgIdentifier(id);
    return true;
  } catch {
    return false;
  }
}

function stampToIso(stamp: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(stamp);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Every rebuild backup in `backupDir`, oldest name first, and every other entry
 * (files that do not match the pattern, directories) that is not a sidecar or marker
 * of a matching backup.
 */
export function listBackups(backupDir: string): { backups: BackupSet[]; other: OtherFile[] } {
  let names: string[];
  try {
    names = readdirSync(backupDir);
  } catch {
    return { backups: [], other: [] };
  }
  const backups: BackupSet[] = [];
  const owned = new Set<string>();
  for (const name of names) {
    const m = BACKUP_RE.exec(name);
    if (!m || !m[1] || !m[2] || !validOrg(m[1])) continue;
    const p = path.join(backupDir, name);
    owned.add(name);
    let bytes = sizeOrZero(p);
    for (const suffix of [...SQLITE_SIDECAR_SUFFIXES, INCOMPLETE_SUFFIX]) {
      owned.add(`${name}${suffix}`);
      bytes += sizeOrZero(`${p}${suffix}`);
    }
    backups.push({
      name,
      orgId: m[1],
      stamp: m[2],
      path: p,
      bytes,
      at: stampToIso(m[2]),
      incomplete: existsSync(`${p}${INCOMPLETE_SUFFIX}`),
    });
  }
  backups.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const other: OtherFile[] = names
    .filter((n) => !owned.has(n))
    .sort()
    .map((n) => ({
      name: n,
      path: path.join(backupDir, n),
      bytes: pathBytes(path.join(backupDir, n)),
    }));
  return { backups, other };
}

const IN_USE_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);

/**
 * Delete one backup with its sidecars and marker. The main file goes first: if the
 * operating system refuses (Windows keeps a file another process has open) nothing
 * else is touched and the result is `in-use`, never counted as freed.
 */
export function removeBackupSet(
  set: BackupSet,
  unlink: (p: string) => void = unlinkSync,
): { status: "done" | "in-use"; freedBytes: number } {
  try {
    unlink(set.path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      /* already gone: still tidy the sidecars */
    } else if (code !== undefined && IN_USE_CODES.has(code)) {
      return { status: "in-use", freedBytes: 0 };
    } else {
      throw e;
    }
  }
  let freed = set.bytes;
  for (const suffix of [...SQLITE_SIDECAR_SUFFIXES, INCOMPLETE_SUFFIX]) {
    const f = `${set.path}${suffix}`;
    try {
      unlink(f);
    } catch (e) {
      // A sidecar that cannot go is not freed; the main file already is.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") freed -= sizeOrZero(f);
    }
  }
  return { status: "done", freedBytes: Math.max(0, freed) };
}

/** Marker that an org's rebuild has started and its sync has not finished. */
export function rebuildPendingPath(dataDir: string, orgId: string): string {
  return path.join(dataDir, `${orgId}.rebuild-pending.json`);
}

export function markRebuildPending(dataDir: string, orgId: string): void {
  writeFileSync(
    rebuildPendingPath(dataDir, orgId),
    JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid }),
  );
}

export function isRebuildPending(dataDir: string, orgId: string): boolean {
  return existsSync(rebuildPendingPath(dataDir, orgId));
}

export function clearRebuildPending(dataDir: string, orgId: string): void {
  try {
    unlinkSync(rebuildPendingPath(dataDir, orgId));
  } catch {
    /* already gone */
  }
}

/** Mark a freshly moved backup as the copy of a graph whose rebuild never finished. */
export function markBackupIncomplete(backupPath: string): void {
  try {
    writeFileSync(
      `${backupPath}${INCOMPLETE_SUFFIX}`,
      "the rebuild that followed the previous backup of this graph did not finish\n",
    );
  } catch {
    /* best-effort: without the marker it counts as complete, the old behaviour */
  }
}

/** Is a pending marker readable at all (for diagnostics in tests)? */
export function readPending(dataDir: string, orgId: string): unknown {
  try {
    return JSON.parse(readFileSync(rebuildPendingPath(dataDir, orgId), "utf8"));
  } catch {
    return null;
  }
}

export interface PruneOutcome {
  removed: BackupSet[];
  /** Left in place because the operating system said the file is in use. */
  inUse: BackupSet[];
  kept: BackupSet[];
  freedBytes: number;
}

/**
 * Which of one org's backups to keep, newest first:
 * - the newest `keep` COMPLETE backups (incomplete ones never count toward `keep`);
 * - when keep > 0 and no backup is complete, the newest one anyway (never leave an org
 *   with only unusable copies and none to look at);
 * - with `protectHistory`, the newest complete backup that still holds snapshot history
 *   (unreadable counts as holding), because a rebuild whose snapshot copy failed left
 *   that history only there.
 */
export function planBackupKeep(
  sets: BackupSet[],
  keep: number,
  protectHistory: boolean,
  historyOf: (s: BackupSet) => number = (s) => snapshotCountInFile(s.path),
): { keep: BackupSet[]; drop: BackupSet[] } {
  const newestFirst = [...sets].sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  const complete = newestFirst.filter((s) => !s.incomplete);
  const kept = new Set<BackupSet>(complete.slice(0, Math.max(0, keep)));
  if (keep > 0 && complete.length === 0 && newestFirst[0]) kept.add(newestFirst[0]);
  if (protectHistory) {
    const pool = complete.length > 0 ? complete : newestFirst;
    const holder =
      pool.find((s) => kept.has(s) && historyOf(s) !== 0) ?? pool.find((s) => historyOf(s) !== 0);
    if (holder) kept.add(holder);
  }
  return {
    keep: newestFirst.filter((s) => kept.has(s)),
    drop: newestFirst.filter((s) => !kept.has(s)),
  };
}

/** Apply {@link planBackupKeep} to one org's backups in `backupDir`. Best-effort per file. */
export function pruneOrgBackups(
  backupDir: string,
  orgId: string,
  o: { keep?: number; protectHistory?: boolean; unlink?: (p: string) => void } = {},
): PruneOutcome {
  const sets = listBackups(backupDir).backups.filter((b) => b.orgId === orgId);
  const plan = planBackupKeep(sets, o.keep ?? rebuildBackupsKept(), o.protectHistory ?? true);
  const out: PruneOutcome = { removed: [], inUse: [], kept: plan.keep, freedBytes: 0 };
  for (const s of plan.drop) {
    try {
      const r = removeBackupSet(s, o.unlink);
      if (r.status === "done") {
        out.removed.push(s);
        out.freedBytes += r.freedBytes;
      } else {
        out.inUse.push(s);
      }
    } catch {
      out.inUse.push(s);
    }
  }
  return out;
}

export interface SweepOutcome {
  /** Orgs whose backups were pruned. */
  orgs: string[];
  removed: BackupSet[];
  inUse: BackupSet[];
  /** Orgs left alone because their ingest lock is held. */
  busyOrgs: string[];
  /** Files in backups/ that are not rebuild backups; reported, never touched. */
  other: OtherFile[];
  freedBytes: number;
}

/**
 * Apply the keep rule to the backups of every org in backups/ (not only the one being
 * rebuilt), so a stale org's old copies go too. An org whose ingest lock is held (by
 * another process, or an org of this run still working) is skipped. `skipOrgs` are orgs
 * the caller already handled.
 */
export function sweepBackups(
  dataDir: string,
  o: { keep?: number; skipOrgs?: ReadonlySet<string>; unlink?: (p: string) => void } = {},
): SweepOutcome {
  const backupDir = path.join(dataDir, "backups");
  const { backups, other } = listBackups(backupDir);
  const out: SweepOutcome = {
    orgs: [],
    removed: [],
    inUse: [],
    busyOrgs: [],
    other,
    freedBytes: 0,
  };
  const orgs = [...new Set(backups.map((b) => b.orgId))].filter((id) => !o.skipOrgs?.has(id));
  for (const orgId of orgs) {
    let lock: ReturnType<typeof acquireIngestLock>;
    try {
      lock = acquireIngestLock({ dir: dataDir, orgId });
    } catch (e) {
      if (e instanceof IngestLockedError) {
        out.busyOrgs.push(orgId);
        continue;
      }
      throw e;
    }
    try {
      const r = pruneOrgBackups(backupDir, orgId, {
        ...(o.keep !== undefined ? { keep: o.keep } : {}),
        protectHistory: true,
        ...(o.unlink ? { unlink: o.unlink } : {}),
      });
      out.orgs.push(orgId);
      out.removed.push(...r.removed);
      out.inUse.push(...r.inUse);
      out.freedBytes += r.freedBytes;
    } finally {
      lock.release();
    }
  }
  return out;
}
