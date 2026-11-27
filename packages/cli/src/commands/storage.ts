import { existsSync, readdirSync, rmSync, statSync, statfsSync, unlinkSync } from "node:fs";
import path from "node:path";
import {
  IngestLockedError,
  SqliteGraphStore,
  SqliteSnapshotStore,
  acquireIngestLock,
  freeBytesOf,
  loadBetterSqlite3,
  selectAutoToPrune,
  snapshotsKept,
} from "@ryanstark24/sfgraph-core";
import {
  SfgraphError,
  asOrgId,
  getSfgraphPaths,
  safeOrgDbPath,
  validateOrgIdentifier,
} from "@ryanstark24/sfgraph-shared";
import {
  type BackupSet,
  SQLITE_SIDECAR_SUFFIXES,
  clearRebuildPending,
  formatBytes,
  listBackups,
  pathBytes,
  removeBackupSet,
} from "./rebuild-backups.js";

/**
 * `sfgraph storage`: where the data dir's bytes are (read-only), `storage clean`
 * (backups, auto snapshots, VACUUM; a dry run unless --apply) and `storage drop <org>`
 * (one whole graph, only when named). `clean` never deletes a live graph file.
 */

export const STORAGE_SCHEMA_VERSION = 1;
/** An org is stale when last synced 7 or more days ago, or never (the same rule as list_orgs). */
const STALE_DAYS = 7;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------
// Report (`sfgraph storage`)

export interface StorageTableBytes {
  name: string;
  bytes: number;
}

export interface StorageGraph {
  orgId: string;
  alias: string | null;
  /** Absolute path of the graph file. */
  file: string;
  /** The graph file only (not its -wal). */
  bytes: number;
  walBytes: number;
  /** Free pages inside the file (freelist_count x page_size): what VACUUM would give back. 0 when the file could not be opened. */
  freeBytes: number;
  /** Snapshot counts; null when the graph could not be opened (another process holds it, or it is not readable). */
  snapshots: { auto: number | null; manual: number | null };
  lastSyncAt: string | null;
  stale: boolean;
  /** With --detail only: largest tables and indexes by bytes (dbstat). */
  tables?: StorageTableBytes[];
}

export interface StorageReport {
  schemaVersion: 1;
  dataDir: string;
  totalBytes: number;
  graphs: StorageGraph[];
  backups: {
    count: number;
    bytes: number;
    byOrg: Array<{ orgId: string; count: number; bytes: number; newestAt: string | null }>;
    other: { count: number; bytes: number };
  };
  embeddingCache: { bytes: number };
  otherBytes: number;
}

interface ReadonlyDb {
  prepare: (s: string) => {
    all: (...a: unknown[]) => unknown[];
    get: (...a: unknown[]) => unknown;
  };
  pragma: (s: string, o?: { simple?: boolean }) => unknown;
  close: () => void;
}

/**
 * Open a graph read-only. Reading a WAL-mode file leaves empty `-wal`/`-shm` files behind
 * (a read-only connection cannot delete them), which would make a dry run change the
 * directory. When neither existed before, close() removes the ones this open created
 * (only if the -wal is empty, so no data is ever dropped).
 */
function openReadonly(file: string): ReadonlyDb | null {
  const hadSidecars = existsSync(`${file}-wal`) || existsSync(`${file}-shm`);
  try {
    const Ctor = loadBetterSqlite3() as new (p: string, o?: unknown) => ReadonlyDb;
    const db = new Ctor(file, { readonly: true, fileMustExist: true });
    try {
      db.pragma("busy_timeout = 500");
    } catch {
      /* best-effort */
    }
    const close = db.close.bind(db);
    db.close = () => {
      close();
      if (hadSidecars) return;
      try {
        if (sizeOrZero(`${file}-wal`) === 0) {
          for (const sfx of ["-wal", "-shm"]) rmSync(`${file}${sfx}`, { force: true });
        }
      } catch {
        /* best-effort */
      }
    };
    return db;
  } catch {
    return null;
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

/** `<dataDir>/<orgId>.sqlite` files (top level only), by org id. */
export function listGraphFiles(dataDir: string): Array<{ orgId: string; file: string }> {
  let names: string[];
  try {
    names = readdirSync(dataDir);
  } catch {
    return [];
  }
  const out: Array<{ orgId: string; file: string }> = [];
  for (const n of names.sort()) {
    if (!n.endsWith(".sqlite")) continue;
    const orgId = n.slice(0, -".sqlite".length);
    if (!validOrg(orgId)) continue;
    const file = path.join(dataDir, n);
    try {
      if (!statSync(file).isFile()) continue;
    } catch {
      continue;
    }
    out.push({ orgId, file });
  }
  return out;
}

function tryAll<T>(db: ReadonlyDb, sql: string, ...args: unknown[]): T[] | null {
  try {
    return db.prepare(sql).all(...args) as T[];
  } catch {
    return null;
  }
}

function readGraph(g: { orgId: string; file: string }, now: number, detail: boolean): StorageGraph {
  const base = {
    orgId: g.orgId,
    file: g.file,
    bytes: sizeOrZero(g.file),
    walBytes: sizeOrZero(`${g.file}-wal`),
  };
  const db = openReadonly(g.file);
  if (!db) {
    return {
      ...base,
      alias: null,
      freeBytes: 0,
      snapshots: { auto: null, manual: null },
      lastSyncAt: null,
      stale: true,
    };
  }
  try {
    let freeBytes = 0;
    try {
      freeBytes = freeBytesOf(db as never);
    } catch {
      /* unreadable header: report 0 */
    }
    let snapshots: StorageGraph["snapshots"];
    try {
      const counts = db
        .prepare("SELECT is_auto, COUNT(*) AS c FROM _sfgraph_snapshots GROUP BY is_auto")
        .all() as Array<{ is_auto: number; c: number }>;
      snapshots = {
        auto: counts.filter((r) => Number(r.is_auto) === 1).reduce((n, r) => n + r.c, 0),
        manual: counts.filter((r) => Number(r.is_auto) !== 1).reduce((n, r) => n + r.c, 0),
      };
    } catch (e) {
      // No snapshot table (an old or empty file): none. Any other failure (locked, not a
      // database): unknown.
      snapshots = /no such table/i.test((e as Error).message)
        ? { auto: 0, manual: 0 }
        : { auto: null, manual: null };
    }
    const row =
      tryAll<{ alias: string | null; last_synced_at: number | null }>(
        db,
        "SELECT alias, last_synced_at FROM _sfgraph_orgs WHERE id = ?",
        g.orgId,
      )?.[0] ??
      tryAll<{ alias: string | null; last_synced_at: number | null }>(
        db,
        "SELECT alias, last_synced_at FROM _sfgraph_orgs LIMIT 1",
      )?.[0];
    const syncedMs = row?.last_synced_at != null ? Number(row.last_synced_at) : null;
    const lastSyncAt =
      syncedMs !== null && Number.isFinite(syncedMs) ? new Date(syncedMs).toISOString() : null;
    const stale = syncedMs === null || (now - syncedMs) / DAY_MS >= STALE_DAYS;
    const out: StorageGraph = {
      ...base,
      alias: row?.alias ? String(row.alias) : null,
      freeBytes,
      snapshots,
      lastSyncAt,
      stale,
    };
    if (detail) {
      const t = tryAll<{ name: string; bytes: number }>(
        db,
        "SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 25",
      );
      if (t) out.tables = t.map((r) => ({ name: String(r.name), bytes: Number(r.bytes) }));
    }
    return out;
  } finally {
    db.close();
  }
}

/** The whole picture of a data dir. Read-only; graphs are opened read-only. */
export function buildStorageReport(
  dataDir: string,
  o: { detail?: boolean; now?: number } = {},
): StorageReport {
  const now = o.now ?? Date.now();
  const graphs = listGraphFiles(dataDir).map((g) => readGraph(g, now, Boolean(o.detail)));
  const { backups, other } = listBackups(path.join(dataDir, "backups"));
  const byOrgMap = new Map<string, { count: number; bytes: number; newest: string | null }>();
  for (const b of backups) {
    const cur = byOrgMap.get(b.orgId) ?? { count: 0, bytes: 0, newest: null };
    cur.count++;
    cur.bytes += b.bytes;
    if (b.at && (cur.newest === null || b.at > cur.newest)) cur.newest = b.at;
    byOrgMap.set(b.orgId, cur);
  }
  const backupBytes = backups.reduce((n, b) => n + b.bytes, 0);
  const otherBackupBytes = other.reduce((n, f) => n + f.bytes, 0);
  const cacheBytes = pathBytes(path.join(dataDir, "embedding-cache"));
  const totalBytes = pathBytes(dataDir);
  const accounted =
    graphs.reduce((n, g) => n + g.bytes + g.walBytes, 0) +
    backupBytes +
    otherBackupBytes +
    cacheBytes;
  return {
    schemaVersion: 1,
    dataDir,
    totalBytes,
    graphs,
    backups: {
      count: backups.length,
      bytes: backupBytes,
      byOrg: [...byOrgMap.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([orgId, v]) => ({ orgId, count: v.count, bytes: v.bytes, newestAt: v.newest })),
      other: { count: other.length, bytes: otherBackupBytes },
    },
    embeddingCache: { bytes: cacheBytes },
    otherBytes: Math.max(0, totalBytes - accounted),
  };
}

function formatReport(r: StorageReport): string {
  const L: string[] = [];
  L.push(`sfgraph data: ${r.dataDir}  (${formatBytes(r.totalBytes)})`);
  L.push("");
  L.push(`Graphs (${r.graphs.length})`);
  for (const g of r.graphs) {
    const snaps =
      g.snapshots.auto === null
        ? "snapshots unknown (graph in use?)"
        : `${g.snapshots.auto} auto + ${g.snapshots.manual} manual snapshots`;
    L.push(
      `  ${g.alias ?? "(no alias)"}  ${g.orgId}  ${formatBytes(g.bytes)}${g.walBytes > 0 ? ` + ${formatBytes(g.walBytes)} wal` : ""}  free ${formatBytes(g.freeBytes)}  ${snaps}  synced ${g.lastSyncAt ?? "never"}${g.stale ? "  STALE" : ""}`,
    );
    for (const t of (g.tables ?? []).slice(0, 8))
      L.push(`      ${formatBytes(t.bytes).padStart(9)}  ${t.name}`);
  }
  L.push("");
  L.push(`Rebuild backups: ${r.backups.count} (${formatBytes(r.backups.bytes)})`);
  for (const b of r.backups.byOrg) {
    L.push(
      `  ${b.orgId}  ${b.count} backup${b.count === 1 ? "" : "s"}  ${formatBytes(b.bytes)}  newest ${b.newestAt ?? "?"}`,
    );
  }
  if (r.backups.other.count > 0) {
    L.push(
      `  ${r.backups.other.count} other file${r.backups.other.count === 1 ? "" : "s"} in backups/ (${formatBytes(r.backups.other.bytes)}), not rebuild backups`,
    );
  }
  L.push("");
  L.push(`Embedding cache: ${formatBytes(r.embeddingCache.bytes)}`);
  L.push(`Everything else: ${formatBytes(r.otherBytes)}`);
  const reclaim = r.graphs.reduce((n, g) => n + g.freeBytes, 0);
  L.push("");
  L.push(
    "Next: 'sfgraph storage clean' shows what it would remove (nothing changes without --apply).",
  );
  if (reclaim > 64 * 1024 * 1024) {
    L.push(
      `      ${formatBytes(reclaim)} of free pages: 'sfgraph storage clean --vacuum' gives them back.`,
    );
  }
  return L.join("\n");
}

export interface StorageOpts {
  json?: boolean | undefined;
  detail?: boolean | undefined;
}

export async function storageCmd(opts: StorageOpts): Promise<void> {
  try {
    const report = buildStorageReport(getSfgraphPaths().data, { detail: Boolean(opts.detail) });
    console.log(opts.json ? JSON.stringify(report, null, 2) : formatReport(report));
  } catch (e) {
    reportError(e);
  }
}

function reportError(e: unknown): void {
  if (e instanceof SfgraphError) console.error(`[${e.code}] ${e.message}`);
  else console.error((e as Error).message);
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------------------
// Clean and drop

export type CleanKind = "backup" | "other-file" | "snapshots" | "vacuum" | "graph";
export type CleanStatus =
  | "planned"
  | "done"
  | "skipped-in-use"
  | "skipped-busy"
  | "skipped-low-disk"
  | "failed";

export interface CleanAction {
  kind: CleanKind;
  orgId: string | null;
  path?: string;
  bytes: number;
  status: CleanStatus;
  detail?: string;
}

export interface CleanResult {
  schemaVersion: 1;
  applied: boolean;
  actions: CleanAction[];
  freedBytes: number;
}

export interface CleanOpts {
  backups?: boolean | undefined;
  snapshots?: boolean | undefined;
  vacuum?: boolean | undefined;
  keep?: number | undefined;
  org?: string | undefined;
  apply?: boolean | undefined;
  json?: boolean | undefined;
}

export interface StorageDeps {
  dataDir?: string;
  /** Free bytes on the volume holding `dir`; undefined when unknown. */
  freeDiskBytes?: (dir: string) => number | undefined;
  unlink?: (p: string) => void;
}

function defaultFreeDisk(dir: string): number | undefined {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return undefined;
  }
}

const IN_USE = new Set(["EBUSY", "EPERM", "EACCES"]);
const isInUse = (e: unknown): boolean => IN_USE.has((e as NodeJS.ErrnoException).code ?? "");

/**
 * Resolve an org id or alias to an org id using only local files: a graph file name, a
 * backup's org id, or the alias stored in a graph. A 15-character id also matches the
 * 18-character id that starts with it. Throws for a name nothing local carries.
 */
export function resolveLocalOrg(dataDir: string, name: string): string {
  const graphs = listGraphFiles(dataDir);
  const ids = new Set<string>([
    ...graphs.map((g) => g.orgId),
    ...listBackups(path.join(dataDir, "backups")).backups.map((b) => b.orgId),
  ]);
  if (ids.has(name)) return name;
  if (name.length === 15) {
    const m = [...ids].filter((i) => i.length === 18 && i.startsWith(name));
    if (m.length === 1) return m[0] as string;
  }
  const byAlias = graphs
    .map((g) => ({ id: g.orgId, alias: readGraph(g, Date.now(), false).alias }))
    .filter((g) => g.alias !== null && g.alias.toLowerCase() === name.toLowerCase());
  if (byAlias.length === 1) return (byAlias[0] as { id: string }).id;
  if (byAlias.length > 1) {
    throw new Error(
      `storage: the alias '${name}' names more than one graph (${byAlias.map((g) => g.id).join(", ")}); use the org id.`,
    );
  }
  throw new Error(
    `storage: no graph or backup for '${name}'. Run 'sfgraph storage' to see what is stored (org ids and aliases).`,
  );
}

function takeLock(dataDir: string, orgId: string): ReturnType<typeof acquireIngestLock> | null {
  try {
    return acquireIngestLock({ dir: dataDir, orgId });
  } catch (e) {
    if (e instanceof IngestLockedError) return null;
    throw e;
  }
}

const finish = (applied: boolean, actions: CleanAction[]): CleanResult => ({
  schemaVersion: 1,
  applied,
  actions,
  freedBytes: actions
    .filter((a) => a.status === "done")
    .reduce((n, a) => n + Math.max(0, a.bytes), 0),
});

function backupAction(
  b: BackupSet,
  status: CleanStatus,
  bytes = b.bytes,
  detail?: string,
): CleanAction {
  return {
    kind: "backup",
    orgId: b.orgId,
    path: b.path,
    bytes,
    status,
    ...(detail ? { detail } : {}),
  };
}

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * Plan (and with `apply` do) the clean-up. Without a category flag: backups + snapshots.
 * `--backups` removes every rebuild backup (all orgs, or --org); files in backups/ that are
 * not rebuild backups are listed, and removed only with --apply AND --backups. `--snapshots`
 * prunes auto snapshots to `keep` (default SFGRAPH_SNAPSHOTS_KEPT); manual ones stay.
 * `--vacuum` rewrites a graph file without its free pages. Each org is worked on under its
 * ingest lock; a held lock skips the org (skipped-busy).
 */
export async function runClean(opts: CleanOpts, deps: StorageDeps = {}): Promise<CleanResult> {
  const dataDir = deps.dataDir ?? getSfgraphPaths().data;
  const backupDir = path.join(dataDir, "backups");
  const apply = Boolean(opts.apply);
  const unlink = deps.unlink ?? unlinkSync;
  const freeDisk = deps.freeDiskBytes ?? defaultFreeDisk;
  const noCategory = !opts.backups && !opts.snapshots && !opts.vacuum;
  const doBackups = Boolean(opts.backups) || noCategory;
  const doSnaps = Boolean(opts.snapshots) || noCategory;
  const doVacuum = Boolean(opts.vacuum);
  const keep = opts.keep ?? snapshotsKept();
  if (!Number.isInteger(keep) || keep < 0) {
    throw new Error("storage clean: --keep needs a whole number, 0 or more");
  }
  const only = opts.org ? resolveLocalOrg(dataDir, opts.org) : null;

  const inv = listBackups(backupDir);
  const graphs = new Map(listGraphFiles(dataDir).map((g) => [g.orgId, g.file]));
  const orgIds = [...new Set([...graphs.keys(), ...inv.backups.map((b) => b.orgId)])]
    .filter((id) => only === null || id === only)
    .sort();
  const actions: CleanAction[] = [];

  for (const orgId of orgIds) {
    const orgBackups = doBackups ? inv.backups.filter((b) => b.orgId === orgId) : [];
    const graphFile = graphs.get(orgId);
    const snapsOrVac = graphFile !== undefined && (doSnaps || doVacuum);
    if (orgBackups.length === 0 && !snapsOrVac) continue;
    const lock = apply ? takeLock(dataDir, orgId) : undefined;
    if (apply && lock === null) {
      const why =
        "an ingest or another storage command holds this org's lock; run again when it ends";
      for (const b of orgBackups) actions.push(backupAction(b, "skipped-busy", b.bytes, why));
      if (graphFile && doSnaps) {
        actions.push({
          kind: "snapshots",
          orgId,
          path: graphFile,
          bytes: 0,
          status: "skipped-busy",
          detail: why,
        });
      }
      if (graphFile && doVacuum) {
        actions.push({
          kind: "vacuum",
          orgId,
          path: graphFile,
          bytes: 0,
          status: "skipped-busy",
          detail: why,
        });
      }
      continue;
    }
    try {
      for (const b of orgBackups) {
        if (!apply) {
          actions.push(
            backupAction(
              b,
              "planned",
              b.bytes,
              b.incomplete ? "backup of an unfinished rebuild" : undefined,
            ),
          );
          continue;
        }
        try {
          const r = removeBackupSet(b, unlink);
          actions.push(
            r.status === "done"
              ? backupAction(b, "done", r.freedBytes)
              : backupAction(b, "skipped-in-use", 0, "the file is in use by another process"),
          );
        } catch (e) {
          actions.push(backupAction(b, "failed", 0, (e as Error).message));
        }
      }
      if (snapsOrVac && graphFile) {
        await cleanGraph({
          orgId,
          graphFile,
          doSnaps,
          doVacuum,
          keep,
          apply,
          freeDisk,
          dataDir,
          actions,
        });
      }
    } finally {
      lock?.release();
    }
  }

  // Files in backups/ that are not rebuild backups: listed always, removed only by --backups --apply.
  if (doBackups && only === null) {
    for (const f of inv.other) {
      const explicit = Boolean(opts.backups);
      if (!(apply && explicit)) {
        actions.push({
          kind: "other-file",
          orgId: null,
          path: f.path,
          bytes: f.bytes,
          status: "planned",
          detail: explicit
            ? "not a rebuild backup"
            : "not a rebuild backup; only removed with --backups",
        });
        continue;
      }
      try {
        rmSync(f.path, { recursive: true, force: true });
        actions.push({
          kind: "other-file",
          orgId: null,
          path: f.path,
          bytes: f.bytes,
          status: "done",
        });
      } catch (e) {
        actions.push({
          kind: "other-file",
          orgId: null,
          path: f.path,
          bytes: 0,
          status: isInUse(e) ? "skipped-in-use" : "failed",
          detail: isInUse(e) ? "the file is in use by another process" : (e as Error).message,
        });
      }
    }
  }
  return finish(apply, actions);
}

async function cleanGraph(c: {
  orgId: string;
  graphFile: string;
  doSnaps: boolean;
  doVacuum: boolean;
  keep: number;
  apply: boolean;
  freeDisk: (dir: string) => number | undefined;
  dataDir: string;
  actions: CleanAction[];
}): Promise<void> {
  const { orgId, graphFile, keep, actions } = c;
  const fileAndWal = (): number => sizeOrZero(graphFile) + sizeOrZero(`${graphFile}-wal`);
  const lowDisk = (): string | null => {
    const free = c.freeDisk(c.dataDir);
    const need = 2 * sizeOrZero(graphFile);
    return free !== undefined && free < need
      ? `needs ${formatBytes(need)} free on the disk, ${formatBytes(free)} available`
      : null;
  };

  if (!c.apply) {
    const db = openReadonly(graphFile);
    if (!db) {
      actions.push({
        kind: c.doSnaps ? "snapshots" : "vacuum",
        orgId,
        path: graphFile,
        bytes: 0,
        status: "skipped-busy",
        detail: "the graph could not be opened (in use by another process?)",
      });
      return;
    }
    try {
      if (c.doSnaps) {
        const rows =
          tryAll<{ id: string; created_at: number; is_auto: number; seq: number }>(
            db,
            "SELECT id, created_at, is_auto, seq FROM _sfgraph_snapshots WHERE org_id = ?",
            orgId,
          ) ?? [];
        const drop = selectAutoToPrune(rows, { keep, retainDays: 0 });
        if (drop.length > 0) {
          actions.push({
            kind: "snapshots",
            orgId,
            path: graphFile,
            bytes: 0,
            status: "planned",
            detail: `${plural(drop.length, "auto snapshot")} would be removed, keeping the newest ${keep}; manual snapshots stay. The file shrinks only with --vacuum.`,
          });
        }
      }
      if (c.doVacuum) {
        const free = freeBytesOf(db as never);
        const low = lowDisk();
        actions.push({
          kind: "vacuum",
          orgId,
          path: graphFile,
          bytes: free,
          status: low ? "skipped-low-disk" : "planned",
          ...(low ? { detail: low } : {}),
        });
      }
    } finally {
      db.close();
    }
    return;
  }

  let store: SqliteGraphStore | undefined;
  try {
    store = new SqliteGraphStore({ dbPath: safeOrgDbPath(c.dataDir, orgId) });
    await store.init();
  } catch (e) {
    await store?.close().catch(() => {});
    actions.push({
      kind: c.doSnaps ? "snapshots" : "vacuum",
      orgId,
      path: graphFile,
      bytes: 0,
      status: "failed",
      detail: `could not open the graph: ${(e as Error).message}`,
    });
    return;
  }
  try {
    if (c.doSnaps) {
      const before = fileAndWal();
      try {
        const snaps = new SqliteSnapshotStore({
          dbPath: graphFile,
          db: store.db,
          skipMigrations: true,
        });
        await snaps.init();
        const n = snaps.pruneAuto(asOrgId(orgId), { keep, retainDays: 0 });
        if (n > 0) {
          actions.push({
            kind: "snapshots",
            orgId,
            path: graphFile,
            bytes: Math.max(0, before - fileAndWal()),
            status: "done",
            detail: `${plural(n, "auto snapshot")} removed, keeping the newest ${keep}; ${formatBytes(freeBytesOf(store.db))} of free pages inside the file (--vacuum gives them back)`,
          });
        }
      } catch (e) {
        actions.push({
          kind: "snapshots",
          orgId,
          path: graphFile,
          bytes: 0,
          status: "failed",
          detail: (e as Error).message,
        });
      }
    }
    if (c.doVacuum) {
      const free = freeBytesOf(store.db);
      const low = lowDisk();
      if (low) {
        actions.push({
          kind: "vacuum",
          orgId,
          path: graphFile,
          bytes: 0,
          status: "skipped-low-disk",
          detail: low,
        });
      } else if (free === 0) {
        actions.push({
          kind: "vacuum",
          orgId,
          path: graphFile,
          bytes: 0,
          status: "done",
          detail: "no free pages to give back",
        });
      } else {
        const before = fileAndWal();
        try {
          // A short wait: a second connection holding the file must refuse the VACUUM, not stall it.
          store.db.pragma("busy_timeout = 250");
          store.compactFile();
          actions.push({
            kind: "vacuum",
            orgId,
            path: graphFile,
            bytes: Math.max(0, before - fileAndWal()),
            status: "done",
          });
        } catch (e) {
          const msg = (e as Error).message;
          const busy = /WAL busy|SQLITE_BUSY|database is locked/i.test(msg);
          actions.push({
            kind: "vacuum",
            orgId,
            path: graphFile,
            bytes: 0,
            status: busy ? "skipped-busy" : "failed",
            detail: busy
              ? "another process has the graph open (sfgraph serve, an MCP client); stop it and run again"
              : msg,
          });
        }
      }
    }
  } finally {
    await store.close();
  }
}

function formatResult(r: CleanResult, verb: string): string {
  const L: string[] = [];
  if (r.actions.length === 0) L.push("Nothing to do.");
  for (const a of r.actions) {
    const where = a.orgId ?? "-";
    L.push(
      `${a.status.padEnd(16)} ${a.kind.padEnd(10)} ${where.padEnd(20)} ${formatBytes(a.bytes).padStart(9)}  ${a.path ?? ""}${a.detail ? `  (${a.detail})` : ""}`,
    );
  }
  if (r.applied) {
    L.push("", `Freed ${formatBytes(r.freedBytes)}.`);
  } else {
    const would = r.actions.filter((a) => a.status === "planned").reduce((n, a) => n + a.bytes, 0);
    L.push(
      "",
      `Dry run: nothing was changed. This would free about ${formatBytes(would)}. Run with --apply to ${verb}.`,
    );
  }
  return L.join("\n");
}

/** 3 when anything was skipped busy or in use; 1 when something failed; else 0. */
export function exitCodeFor(r: CleanResult): number {
  if (r.actions.some((a) => a.status === "failed")) return 1;
  if (r.actions.some((a) => a.status === "skipped-busy" || a.status === "skipped-in-use")) return 3;
  return 0;
}

export async function storageCleanCmd(opts: CleanOpts, deps: StorageDeps = {}): Promise<void> {
  try {
    const r = await runClean(opts, deps);
    console.log(opts.json ? JSON.stringify(r, null, 2) : formatResult(r, "do it"));
    process.exitCode = exitCodeFor(r);
  } catch (e) {
    reportError(e);
  }
}

export interface DropOpts {
  apply?: boolean | undefined;
  json?: boolean | undefined;
}

/**
 * Delete one whole graph: its file, -wal/-shm/-journal, its rebuild backups and its
 * unfinished-rebuild marker. Only for an org named explicitly (id or alias); a dry run unless
 * --apply; under the org's ingest lock. If the graph file itself is in use nothing else of the
 * org is removed.
 */
export async function runDrop(
  name: string,
  opts: DropOpts,
  deps: StorageDeps = {},
): Promise<CleanResult> {
  const dataDir = deps.dataDir ?? getSfgraphPaths().data;
  const unlink = deps.unlink ?? unlinkSync;
  const apply = Boolean(opts.apply);
  const orgId = resolveLocalOrg(dataDir, name);
  const file = listGraphFiles(dataDir).find((g) => g.orgId === orgId)?.file;
  const backups = listBackups(path.join(dataDir, "backups")).backups.filter(
    (b) => b.orgId === orgId,
  );
  const actions: CleanAction[] = [];
  const graphBytes = file
    ? [file, ...SQLITE_SIDECAR_SUFFIXES.map((s) => `${file}${s}`)].reduce(
        (n, p) => n + sizeOrZero(p),
        0,
      )
    : 0;
  const graphAction = (status: CleanStatus, bytes: number, detail?: string): CleanAction => ({
    kind: "graph",
    orgId,
    ...(file ? { path: file } : {}),
    bytes,
    status,
    ...(detail ? { detail } : {}),
  });
  if (!apply) {
    if (file) actions.push(graphAction("planned", graphBytes));
    for (const b of backups) actions.push(backupAction(b, "planned"));
    return finish(false, actions);
  }
  const lock = takeLock(dataDir, orgId);
  if (lock === null) {
    const why = "an ingest or another storage command holds this org's lock; nothing was removed";
    if (file) actions.push(graphAction("skipped-busy", graphBytes, why));
    for (const b of backups) actions.push(backupAction(b, "skipped-busy", b.bytes, why));
    return finish(true, actions);
  }
  try {
    if (file) {
      try {
        unlink(file);
        let freed = sizeOrZero(file) === 0 ? graphBytes : 0;
        for (const s of SQLITE_SIDECAR_SUFFIXES) {
          try {
            unlink(`${file}${s}`);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") freed -= sizeOrZero(`${file}${s}`);
          }
        }
        actions.push(graphAction("done", Math.max(0, freed)));
      } catch (e) {
        actions.push(
          graphAction(
            isInUse(e) ? "skipped-in-use" : "failed",
            0,
            isInUse(e)
              ? "the graph file is in use by another process; nothing else was removed"
              : (e as Error).message,
          ),
        );
        return finish(true, actions);
      }
    }
    for (const b of backups) {
      try {
        const r = removeBackupSet(b, unlink);
        actions.push(
          r.status === "done"
            ? backupAction(b, "done", r.freedBytes)
            : backupAction(b, "skipped-in-use", 0, "the file is in use by another process"),
        );
      } catch (e) {
        actions.push(backupAction(b, "failed", 0, (e as Error).message));
      }
    }
    clearRebuildPending(dataDir, orgId);
  } finally {
    lock.release();
  }
  return finish(true, actions);
}

export async function storageDropCmd(
  name: string,
  opts: DropOpts,
  deps: StorageDeps = {},
): Promise<void> {
  try {
    const r = await runDrop(name, opts, deps);
    console.log(opts.json ? JSON.stringify(r, null, 2) : formatResult(r, "delete them"));
    process.exitCode = exitCodeFor(r);
  } catch (e) {
    reportError(e);
  }
}
