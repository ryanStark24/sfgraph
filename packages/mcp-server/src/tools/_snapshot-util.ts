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
