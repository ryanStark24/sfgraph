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
  /** Dangling edges whose dst is a platform built-in that can never have a
   *  metadata source: standard tabs (`CustomTab:standard-*`) and fields /
   *  objects of standard-schema entities (no `__c`/`__mdt`/… suffix).
   *  These are *expected* — the reference data is real and useful (e.g.
   *  profile tab visibility), the target just isn't org metadata. Included
   *  in `danglingCount`; broken out so the headline number isn't dominated
   *  by ~60k standard-tab grants on a vanilla org. */
  platformRefCount: number;
  /** danglingCount - platformRefCount: the subset worth investigating. */
  unexpectedCount: number;
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

const CUSTOM_SUFFIX_RE = /__(?:c|e|b|mdt|x|kav)$/i;

/** True when a dangling dst names a platform built-in that no extractor can
 *  ever materialize: standard tabs, or fields/objects of standard-schema
 *  entities (Incident, Location, Case, …) the org metadata pass doesn't
 *  enumerate. Custom-suffixed targets are NEVER platform refs — a missing
 *  `__c` target is a real gap worth surfacing. */
export function isPlatformBuiltinRef(dst: string): boolean {
  if (dst.startsWith("CustomTab:standard-")) return true;
  if (dst.startsWith("CustomField:")) {
    const rest = dst.slice("CustomField:".length);
    const dot = rest.indexOf(".");
    if (dot <= 0) return false;
    const obj = rest.slice(0, dot);
    const field = rest.slice(dot + 1);
    return !CUSTOM_SUFFIX_RE.test(obj) && !CUSTOM_SUFFIX_RE.test(field);
  }
  if (dst.startsWith("CustomObject:")) {
    return !CUSTOM_SUFFIX_RE.test(dst.slice("CustomObject:".length));
  }
  return false;
}

export function auditDanglingEdges(
  store: GraphStore,
  orgIdIn: OrgId | string,
  opts: AuditOpts = {},
): AuditResult {
  const orgId = typeof orgIdIn === "string" ? asOrgId(orgIdIn) : orgIdIn;
  // Clamp to ≥0; a negative slice index would silently return a tail of the
  // dangling array rather than an empty sample.
  const sampleSize = Math.max(0, opts.sampleSize ?? 25);

  const totalEdges = store.countEdges(orgId);
  const dangling = store.listDanglingEdges(orgId, opts.scanLimit);

  const byRel: Record<string, number> = {};
  const byDstPrefix: Record<string, number> = {};
  let platformRefCount = 0;
  for (const e of dangling) {
    byRel[e.relType] = (byRel[e.relType] ?? 0) + 1;
    const dst = String(e.dstQualifiedName);
    const p = prefix(dst);
    byDstPrefix[p] = (byDstPrefix[p] ?? 0) + 1;
    if (isPlatformBuiltinRef(dst)) platformRefCount += 1;
  }

  // Sample the *unexpected* dangling edges first — those are the ones a
  // user can act on; platform refs only pad the sample once the unexpected
  // set is smaller than sampleSize.
  const unexpectedFirst = [...dangling].sort((a, b) => {
    const ap = isPlatformBuiltinRef(String(a.dstQualifiedName)) ? 1 : 0;
    const bp = isPlatformBuiltinRef(String(b.dstQualifiedName)) ? 1 : 0;
    return ap - bp;
  });
  const sample: DanglingEdgeSample[] = unexpectedFirst.slice(0, sampleSize).map((e) => ({
    src: String(e.srcQualifiedName),
    rel: String(e.relType),
    dst: String(e.dstQualifiedName),
  }));

  return {
    totalEdges,
    danglingCount: dangling.length,
    platformRefCount,
    unexpectedCount: dangling.length - platformRefCount,
    byRel,
    byDstPrefix,
    sample,
  };
}

/**
 * Destructive companion to `auditDanglingEdges`: deletes dangling edges.
 * Reserved for the CLI `--delete-dangling --yes` flag; callers must own the
 * authorization decision (we just do the work).
 *
 * Platform-builtin references (standard-tab grants, standard-schema field
 * grants) are KEPT by default — they're real, queryable security data whose
 * target simply has no metadata source. Pass `includePlatformRefs: true` to
 * delete those too.
 */
export function deleteDanglingEdges(
  store: GraphStore,
  orgIdIn: OrgId | string,
  opts: { includePlatformRefs?: boolean } = {},
): { deleted: number; keptPlatformRefs: number } {
  const orgId = typeof orgIdIn === "string" ? asOrgId(orgIdIn) : orgIdIn;
  const dangling = store.listDanglingEdges(orgId);
  let deleted = 0;
  let keptPlatformRefs = 0;
  store.transaction(() => {
    for (const e of dangling) {
      if (!opts.includePlatformRefs && isPlatformBuiltinRef(String(e.dstQualifiedName))) {
        keptPlatformRefs += 1;
        continue;
      }
      store.deleteEdge(
        orgId,
        e.srcQualifiedName as QualifiedName,
        e.dstQualifiedName as QualifiedName,
        e.relType as RelType,
      );
      deleted += 1;
    }
  });
  return { deleted, keptPlatformRefs };
}

export type { EdgeFact };
