import type Database from "better-sqlite3";
import type { OrgId } from "@ryanstark24/sfgraph-shared";

/** Alias for better-sqlite3's Database handle — kept local rather than
 *  re-exported from load-better-sqlite3 so the dep graph stays one-way. */
type BetterSqlite3Database = Database.Database;

/**
 * Rename stability: maintains a `(org_id, service_id) → qualified_name`
 * map so that when a metadata component's underlying Salesforce ID is
 * unchanged but its developer name changes (the common shape of a rename
 * in Salesforce — same ApexClass.Id, new fullName), sfgraph can rewrite
 * incoming edges to point at the new qname instead of treating the rename
 * as a delete+add. The delete+add path silently breaks the call graph
 * until the next full sync — see PITFALLS.md for the rationale.
 *
 * Pitfalls research called this out as schema-irreversible on first
 * commit: get the composite key wrong (e.g. forget `org_id`) and a
 * follow-up migration to add it is destructive. Schema lives at
 * migrations.ts version 7 and is locked in this shape.
 *
 * Feature-flagged off by default in live-ingest (see
 * `enableElemIdRenameStability`); shipping flagged off bounds the
 * blast-radius of any false-positive rename detection (e.g. serviceId
 * collisions across two managed packages) until the feature has been
 * dogfooded.
 *
 * Escape hatch: the `resetServiceIdMap(db, orgId)` helper below is
 * exposed by the `sfgraph reset-elemid-map` CLI command. After running
 * it, the next ingest re-populates the map from scratch.
 */

export interface ServiceIdRecord {
  orgId: string;
  serviceId: string;
  qualifiedName: string;
  label: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface RenameDetection {
  detected: false;
  /** First-time mapping: store now so future ingests can detect renames. */
  recorded: boolean;
}
export interface RenameDetectedDetection {
  detected: true;
  /** Previous qualifiedName the map had for this serviceId. */
  previousQname: string;
  /** New qualifiedName the caller passed in. */
  currentQname: string;
}
export type RenameResult = RenameDetection | RenameDetectedDetection;

/**
 * Read-only lookup: what qname did we last see for this serviceId on this
 * org? Returns null if the serviceId is unknown.
 */
export function lookupServiceId(
  db: BetterSqlite3Database,
  orgId: OrgId | string,
  serviceId: string,
): ServiceIdRecord | null {
  const row = db
    .prepare(
      "SELECT org_id, service_id, qualified_name, label, first_seen_at, last_seen_at FROM _sfgraph_service_ids WHERE org_id = ? AND service_id = ?",
    )
    .get(String(orgId), serviceId) as
    | {
        org_id: string;
        service_id: string;
        qualified_name: string;
        label: string;
        first_seen_at: number;
        last_seen_at: number;
      }
    | undefined;
  if (!row) return null;
  return {
    orgId: row.org_id,
    serviceId: row.service_id,
    qualifiedName: row.qualified_name,
    label: row.label,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

/**
 * Record (or update) the serviceId → qname mapping. Returns a result
 * describing whether a rename was detected (i.e. the same serviceId
 * mapped to a different qname previously). The caller is responsible
 * for rewriting edges — `rewriteEdgesForRename()` below does that.
 */
export function recordServiceId(
  db: BetterSqlite3Database,
  orgId: OrgId | string,
  serviceId: string,
  qualifiedName: string,
  label: string,
): RenameResult {
  const orgIdStr = String(orgId);
  const now = Date.now();
  const existing = lookupServiceId(db, orgIdStr, serviceId);
  if (!existing) {
    db.prepare(
      `INSERT INTO _sfgraph_service_ids
       (org_id, service_id, qualified_name, label, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(orgIdStr, serviceId, qualifiedName, label, now, now);
    return { detected: false, recorded: true };
  }
  if (existing.qualifiedName !== qualifiedName) {
    db.prepare(
      "UPDATE _sfgraph_service_ids SET qualified_name = ?, label = ?, last_seen_at = ? WHERE org_id = ? AND service_id = ?",
    ).run(qualifiedName, label, now, orgIdStr, serviceId);
    return {
      detected: true,
      previousQname: existing.qualifiedName,
      currentQname: qualifiedName,
    };
  }
  // Same mapping seen before — just refresh last_seen_at.
  db.prepare(
    "UPDATE _sfgraph_service_ids SET last_seen_at = ? WHERE org_id = ? AND service_id = ?",
  ).run(now, orgIdStr, serviceId);
  return { detected: false, recorded: false };
}

/**
 * Migrate every edge that points at `oldQname` (as src OR dst) to point
 * at `newQname` instead. Walks every known edge table once. Returns
 * counts per direction for visibility / telemetry.
 *
 * Implementation notes:
 * - Idempotent: running twice with the same args is a no-op the second
 *   time because there are no more matches on the old qname.
 * - We DON'T delete the old node; the orchestrator can do that via the
 *   normal detect-deletions path when the rename is real (the next
 *   ingest won't touch the old qname so it'll surface there).
 * - The label cache is read from the public `listAllLabels()` helper
 *   on the GraphStore (W3-04). For edge tables we read the
 *   `_sfgraph_edge_types` table directly since the GraphStore doesn't
 *   currently expose that listing.
 */
export function rewriteEdgesForRename(
  db: BetterSqlite3Database,
  orgId: OrgId | string,
  oldQname: string,
  newQname: string,
): { srcRewritten: number; dstRewritten: number } {
  const orgIdStr = String(orgId);
  const edgeTables = db
    .prepare("SELECT table_name FROM _sfgraph_edge_types")
    .all() as Array<{ table_name: string }>;
  let srcRewritten = 0;
  let dstRewritten = 0;
  for (const { table_name } of edgeTables) {
    const srcResult = db
      .prepare(
        `UPDATE ${table_name} SET src_qname = ? WHERE org_id = ? AND src_qname = ?`,
      )
      .run(newQname, orgIdStr, oldQname);
    srcRewritten += srcResult.changes;
    const dstResult = db
      .prepare(
        `UPDATE ${table_name} SET dst_qname = ? WHERE org_id = ? AND dst_qname = ?`,
      )
      .run(newQname, orgIdStr, oldQname);
    dstRewritten += dstResult.changes;
  }
  return { srcRewritten, dstRewritten };
}

/**
 * Drop every service-id mapping for the given org. Used by
 * `sfgraph reset-elemid-map` as a recovery escape hatch when the rename-
 * stability layer has produced incorrect inferences (e.g. serviceId
 * collisions across two managed packages with the same DeveloperName).
 * The next ingest re-populates from scratch.
 */
export function resetServiceIdMap(
  db: BetterSqlite3Database,
  orgId: OrgId | string,
): { cleared: number } {
  const result = db
    .prepare("DELETE FROM _sfgraph_service_ids WHERE org_id = ?")
    .run(String(orgId));
  return { cleared: result.changes };
}
