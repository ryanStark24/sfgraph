import type { BetterSqlite3Database } from "./interfaces.js";

/**
 * Storage retention settings, read from the environment (like every other sfgraph
 * setting). Each value is a non-negative integer; anything else (empty, negative,
 * fractional, text) falls back to the default instead of failing an ingest.
 */

/** Rebuild backups kept per org (each is a full copy of the graph file). */
export const DEFAULT_REBUILD_BACKUPS_KEPT = 1;
/** Auto snapshots kept per org, newest first. */
export const DEFAULT_SNAPSHOTS_KEPT = 5;
/** Auto snapshots beyond the newest N are removed once older than this many days. 0 = no age grace. */
export const DEFAULT_SNAPSHOT_RETAIN_DAYS = 30;
/** Free pages above this many bytes are worth a `sfgraph storage clean --vacuum`. */
export const RECLAIMABLE_NOTICE_BYTES = 256 * 1024 * 1024;

/** A non-negative integer from env var `name`, or `fallback`. */
export function envNonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return fallback;
  const n = Number.parseInt(t, 10);
  return Number.isSafeInteger(n) ? n : fallback;
}

/** `SFGRAPH_REBUILD_BACKUPS_KEPT` (default 1; 0 keeps none). */
export const rebuildBackupsKept = (): number =>
  envNonNegativeInt("SFGRAPH_REBUILD_BACKUPS_KEPT", DEFAULT_REBUILD_BACKUPS_KEPT);

/** `SFGRAPH_SNAPSHOTS_KEPT` (default 5). */
export const snapshotsKept = (): number =>
  envNonNegativeInt("SFGRAPH_SNAPSHOTS_KEPT", DEFAULT_SNAPSHOTS_KEPT);

/** `SFGRAPH_SNAPSHOT_RETAIN_DAYS` (default 30; 0 = no age grace). */
export const snapshotRetainDays = (): number =>
  envNonNegativeInt("SFGRAPH_SNAPSHOT_RETAIN_DAYS", DEFAULT_SNAPSHOT_RETAIN_DAYS);

/** Bytes held by free pages of an open database (freelist_count x page_size). */
export function freeBytesOf(db: Pick<BetterSqlite3Database, "pragma">): number {
  const free = Number(db.pragma("freelist_count", { simple: true }));
  const size = Number(db.pragma("page_size", { simple: true }));
  return Number.isFinite(free) && Number.isFinite(size) ? free * size : 0;
}

/** The one line printed when free pages are worth reclaiming, or null. */
export function reclaimableNotice(orgId: string, freeBytes: number): string | null {
  if (freeBytes <= RECLAIMABLE_NOTICE_BYTES) return null;
  return `reclaimable ${(freeBytes / 1024 ** 3).toFixed(1)} GB in ${orgId}: run "sfgraph storage clean --vacuum"`;
}

/**
 * Of an org's snapshot rows, the auto ones {@link SqliteSnapshotStore.pruneAuto} deletes.
 * Manual snapshots (`is_auto` 0) are never candidates. The newest `keep` auto snapshots
 * (by created_at, then seq) always stay. Of the rest, those older than `retainDays` go;
 * `retainDays` 0 means no age grace, so all of them go.
 */
export function selectAutoToPrune<
  T extends { is_auto: number; created_at: number; seq?: number | null },
>(rows: readonly T[], o: { keep: number; retainDays: number; now?: number }): T[] {
  const auto = rows
    .filter((r) => r.is_auto === 1)
    .sort((a, b) => b.created_at - a.created_at || (b.seq ?? 0) - (a.seq ?? 0));
  const cutoff = (o.now ?? Date.now()) - o.retainDays * 86_400_000;
  return auto.slice(Math.max(0, o.keep)).filter((r) => o.retainDays === 0 || r.created_at < cutoff);
}
