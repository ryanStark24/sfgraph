import { statSync } from "node:fs";
import type { ToolContext } from "../context.js";

/** Diffs bigger than this skip the mermaid block (it would be unreadable and
 *  megabytes of markdown on a real org). */
export const DIFF_MERMAID_MAX_NODES = 100;

type Db = { prepare: (s: string) => { get: (...a: unknown[]) => unknown } };

function dbOf(ctx: ToolContext): Db | null {
  const db = (ctx.db ?? (ctx.snapshotStore as unknown as { db?: unknown }).db) as Db | undefined;
  return db && typeof db.prepare === "function" ? db : null;
}

/**
 * True when the snapshot holds no node rows (e.g. the auto "pre-sync"
 * snapshot taken before an org's first ingest), so diffing against it reports
 * the whole graph as added. Null when it can't be determined.
 */
export function isSnapshotEmpty(ctx: ToolContext, snapshotId: string): boolean | null {
  const db = dbOf(ctx);
  if (!db) return null;
  try {
    const row = db
      .prepare(
        "SELECT 1 AS x FROM _sfgraph_node_snapshots WHERE snapshot_id = ? AND org_id = ? LIMIT 1",
      )
      .get(snapshotId, String(ctx.orgId));
    return row === undefined;
  } catch {
    return null;
  }
}

// --- diff cache ---------------------------------------------------------
// The first point_in_time_diff on a big org spends its time in SQL (the edge
// anti-joins), not in parsing, and an agent often repeats the same diff. The
// finished diff is kept in-process, for the last two (org, from, to, limit)
// asks, and dropped the moment the graph file changes.

const DIFF_CACHE_MAX = 2;

type StatDb = {
  name?: string;
  prepare: (s: string) => { get: (...a: unknown[]) => unknown };
};

interface DiffEntry {
  key: string;
  ctx: ToolContext;
  signature: string;
  value: unknown;
}

const diffCache: DiffEntry[] = [];
let diffLoads = 0;

/** How many times a diff was computed (not served from the cache). */
export function diffLoadCount(): number {
  return diffLoads;
}

/** Empties the cache (tests, and a store being closed). */
export function clearDiffCache(): void {
  diffCache.length = 0;
}

/**
 * Fingerprint of everything that can change a diff: the graph file and its
 * write-ahead log (mtime and size), writes on this connection and writes by
 * another connection. Null when it cannot be read (an in-memory database), in
 * which case nothing is cached.
 */
function diffSignature(ctx: ToolContext): string | null {
  const db = dbOf(ctx) as StatDb | null;
  if (!db || typeof db.name !== "string" || db.name === "" || db.name === ":memory:") return null;
  try {
    const parts: string[] = [];
    for (const f of [db.name, `${db.name}-wal`]) {
      try {
        const s = statSync(f, { bigint: true });
        parts.push(`${s.mtimeNs}:${s.size}`);
      } catch {
        parts.push("none");
      }
    }
    const total = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const ver = (db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
    return `${parts.join("|")}|${total}|${ver}`;
  } catch {
    return null;
  }
}

/**
 * Returns `compute()` for `key`, reusing the last result for the same key
 * while the graph file is unchanged. Bounded to two entries (least recently
 * used goes first). A changed file, or a different store, is a miss.
 */
export function cachedDiff<T>(ctx: ToolContext, key: string, compute: () => T): T {
  const signature = diffSignature(ctx);
  if (signature !== null) {
    const i = diffCache.findIndex((e) => e.key === key);
    if (i >= 0) {
      const hit = diffCache[i] as DiffEntry;
      diffCache.splice(i, 1);
      if (hit.ctx === ctx && hit.signature === signature) {
        diffCache.unshift(hit);
        return hit.value as T;
      }
    }
  }
  diffLoads++;
  const value = compute();
  if (signature !== null) {
    // Re-read after computing: a write during the compute must not be cached under the old print.
    const after = diffSignature(ctx);
    if (after === signature) {
      diffCache.unshift({ key, ctx, signature, value });
      diffCache.length = Math.min(diffCache.length, DIFF_CACHE_MAX);
    }
  }
  return value;
}
