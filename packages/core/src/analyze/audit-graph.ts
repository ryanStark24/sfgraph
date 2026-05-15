import { asOrgId } from "@ryanstark24/sfgraph-shared";
import type { OrgId, QualifiedName } from "@ryanstark24/sfgraph-shared";
import type { EdgeFact, RelType } from "../domain/index.js";
import type { GraphStore } from "../storage/interfaces.js";

/**
 * Edges whose `dst` qualified name has no matching node row. Surfaced
 * post-ingest so the user can see what the parsers reference but the
 * extractors never materialized (managed-package methods, third-party
 * imports, dotted refs to fields whose CustomObject was filtered out).
 *
 * Counts are emitted in two histograms:
 *   - byRel: which relationship types are most affected (e.g. CALLS,
 *     GRANTS_APEX_ACCESS) — points at parsers that emit speculative targets.
 *   - byDstPrefix: which qname prefixes are most common (e.g. `ApexMethod:`,
 *     `Remote:`, `CustomField:`) — points at unparsed metadata categories.
 *
 * A bounded `sample` of the actual dangling edges is included so users can
 * eyeball whether they're "expected" (managed packages, ghost references)
 * or "fixable" (an extractor that should have emitted a target node).
 */
export interface DanglingEdgeSample {
  src: string;
  rel: string;
  dst: string;
}

export interface AuditResult {
  totalEdges: number;
  danglingCount: number;
  byRel: Record<string, number>;
  byDstPrefix: Record<string, number>;
  sample: DanglingEdgeSample[];
}

export interface AuditOpts {
  /** How many dangling edges to keep in `sample`. Default 25. */
  sampleSize?: number;
  /** Hard upper bound on rows scanned per edge table. Default unlimited. */
  scanLimit?: number;
}

function prefix(qname: string): string {
  const idx = qname.indexOf(":");
  return idx > 0 ? qname.slice(0, idx) : "(unlabeled)";
}

export function auditDanglingEdges(
  store: GraphStore,
  orgIdIn: OrgId | string,
  opts: AuditOpts = {},
): AuditResult {
  const orgId = typeof orgIdIn === "string" ? asOrgId(orgIdIn) : orgIdIn;
  const sampleSize = opts.sampleSize ?? 25;

  const totalEdges = store.countEdges(orgId);
  const dangling = store.listDanglingEdges(orgId, opts.scanLimit);

  const byRel: Record<string, number> = {};
  const byDstPrefix: Record<string, number> = {};
  for (const e of dangling) {
    byRel[e.relType] = (byRel[e.relType] ?? 0) + 1;
    const p = prefix(String(e.dstQualifiedName));
    byDstPrefix[p] = (byDstPrefix[p] ?? 0) + 1;
  }

  const sample: DanglingEdgeSample[] = dangling.slice(0, sampleSize).map((e) => ({
    src: String(e.srcQualifiedName),
    rel: String(e.relType),
    dst: String(e.dstQualifiedName),
  }));

  return {
    totalEdges,
    danglingCount: dangling.length,
    byRel,
    byDstPrefix,
    sample,
  };
}

/**
 * Destructive companion to `auditDanglingEdges`: deletes every dangling edge.
 * Reserved for the CLI `--delete-dangling --yes` flag; callers must own the
 * authorization decision (we just do the work).
 */
export function deleteDanglingEdges(
  store: GraphStore,
  orgIdIn: OrgId | string,
): { deleted: number } {
  const orgId = typeof orgIdIn === "string" ? asOrgId(orgIdIn) : orgIdIn;
  const dangling = store.listDanglingEdges(orgId);
  let deleted = 0;
  store.transaction(() => {
    for (const e of dangling) {
      store.deleteEdge(
        orgId,
        e.srcQualifiedName as QualifiedName,
        e.dstQualifiedName as QualifiedName,
        e.relType as RelType,
      );
      deleted += 1;
    }
  });
  return { deleted };
}

export type { EdgeFact };
