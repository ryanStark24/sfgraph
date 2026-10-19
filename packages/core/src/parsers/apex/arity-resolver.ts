import { asOrgId, asQualifiedName } from "@ryanstark24/sfgraph-shared";
import type { OrgId, QualifiedName } from "@ryanstark24/sfgraph-shared";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import type { GraphStore } from "../../storage/interfaces.js";
import { makeEdge } from "../common.js";
import type { ParseContext } from "../contract.js";

/**
 * Rewrites Apex CALLS edges whose `dst` is `ApexMethod:Class.name(?)` —
 * a placeholder emitted at parse time because the regex-based extractor
 * can't determine arity from the call site — by matching against real
 * `ApexMethod` nodes in the graph and emitting edges to every overload.
 *
 * Pragmatic semantics:
 *   - exactly one overload found → edge rewritten to that target, `ambiguous=false`.
 *   - multiple overloads → one edge per overload, all marked `ambiguous=true`.
 *   - zero overloads → original edge left in place so the dangling-edge audit
 *     surfaces it (managed-package targets, typos, third-party imports).
 *
 * The new edges carry `arityResolvedFrom: "<the (?) qname>"` so consumers can
 * tell them from extractor-emitted ones. Deliberately NOT `resolvedBy`:
 * member reconcile exempts `resolvedBy` edges, and these must stay owned by
 * their source method. When the caller is re-parsed, reconcile drops the
 * resolved edge (the parser re-emits only the `(?)` placeholder), and this
 * pass re-derives it if the call still exists — so a deleted call never
 * leaves a stale CALLS edge behind (audit corecorr-09).
 */
export interface ArityResolveOpts {
  orgId: OrgId | string;
  ctx: ParseContext;
  /** When true, compute the result but do not mutate the graph. */
  dryRun?: boolean;
  /** Maximum stranded edges to inspect per call (safety valve for huge orgs).
   *  Default Number.POSITIVE_INFINITY. */
  limit?: number;
  /**
   * Task 11c (delta ingest): inspect only the stranded edges FROM `srcs`
   * (re-parsed members) plus those whose target class is in `classNames`
   * (classes that gained or lost methods). Unset: every stranded edge.
   */
  scope?: { srcs: ReadonlySet<string>; classNames: ReadonlySet<string> };
}

export interface ArityResolveResult {
  /** Stranded edges examined. */
  scanned: number;
  /** Stranded edges that found ≥1 target. Counts inputs, not outputs. */
  resolved: number;
  /** Stranded edges that found >1 target (subset of `resolved`). */
  ambiguous: number;
  /** Stranded edges with no candidate target — left in place. */
  unresolved: number;
  /** Total new edges emitted across all rewrites. */
  edgesEmitted: number;
}

const STRANDED_PATTERN = "ApexMethod:%(?)";
const QNAME_RE = /^ApexMethod:(.+)\.([A-Za-z_][\w]*)\(\?\)$/;
const REAL_QNAME_RE = /^ApexMethod:(.+)\.([A-Za-z_][\w]*)\((\d+)\)$/;

interface MethodKey {
  className: string;
  methodName: string;
}

function parseStranded(qname: string): MethodKey | null {
  const m = QNAME_RE.exec(qname);
  if (!m) return null;
  return { className: m[1] ?? "", methodName: m[2] ?? "" };
}

function parseResolved(
  qname: string,
): { className: string; methodName: string; arity: number } | null {
  const m = REAL_QNAME_RE.exec(qname);
  if (!m) return null;
  return {
    className: m[1] ?? "",
    methodName: m[2] ?? "",
    arity: Number.parseInt(m[3] ?? "0", 10),
  };
}

function scopedStranded(
  store: GraphStore,
  orgId: OrgId,
  scope: NonNullable<ArityResolveOpts["scope"]>,
): EdgeFact[] {
  const out: EdgeFact[] = [];
  const seen = new Set<string>();
  const add = (e: EdgeFact): void => {
    const dst = String(e.dstQualifiedName);
    if (!parseStranded(dst)) return;
    const k = `${e.relType}|${String(e.srcQualifiedName).toLowerCase()}|${dst.toLowerCase()}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(e);
  };
  for (const src of scope.srcs) {
    for (const e of store.listEdgesFrom(orgId, asQualifiedName(src))) add(e);
  }
  for (const cls of scope.classNames) {
    // LIKE: `_` is a wildcard and matching is case-insensitive; the exact
    // class is confirmed below.
    for (const e of store.listEdgesByDstLike(orgId, `ApexMethod:${cls}.%(?)`)) {
      if (parseStranded(String(e.dstQualifiedName))?.className.toLowerCase() === cls.toLowerCase())
        add(e);
    }
  }
  return out;
}

export function resolveApexMethodArity(
  store: GraphStore,
  opts: ArityResolveOpts,
): ArityResolveResult {
  const orgId = typeof opts.orgId === "string" ? asOrgId(opts.orgId) : opts.orgId;

  // ---- Build the index of real ApexMethod nodes -------------------------
  const apexMethods = store.listNodesByLabel(orgId, "ApexMethod");
  const testMethods = store.listNodesByLabel(orgId, "TestMethod");
  const all: NodeFact[] = [...apexMethods, ...testMethods];

  // className -> methodName -> NodeFact[]
  const index = new Map<string, Map<string, NodeFact[]>>();
  for (const n of all) {
    const parsed = parseResolved(String(n.qualifiedName));
    if (!parsed) continue;
    const byMethod = index.get(parsed.className) ?? new Map<string, NodeFact[]>();
    const bucket = byMethod.get(parsed.methodName) ?? [];
    bucket.push(n);
    byMethod.set(parsed.methodName, bucket);
    index.set(parsed.className, byMethod);
  }

  // ---- Find stranded edges ---------------------------------------------
  const stranded = opts.scope
    ? scopedStranded(store, orgId, opts.scope)
    : store.listEdgesByDstLike(orgId, STRANDED_PATTERN, undefined, opts.limit);

  const result: ArityResolveResult = {
    scanned: stranded.length,
    resolved: 0,
    ambiguous: 0,
    unresolved: 0,
    edgesEmitted: 0,
  };

  if (stranded.length === 0) return result;

  const apply = (): void => {
    for (const edge of stranded) {
      const dst = String(edge.dstQualifiedName);
      const key = parseStranded(dst);
      if (!key) {
        result.unresolved += 1;
        continue;
      }
      const candidates = index.get(key.className)?.get(key.methodName) ?? [];
      if (candidates.length === 0) {
        result.unresolved += 1;
        continue;
      }
      result.resolved += 1;
      if (candidates.length > 1) result.ambiguous += 1;

      const newEdges = candidates.map((cand) => {
        const e = makeEdge(
          opts.ctx,
          String(edge.srcQualifiedName),
          edge.relType,
          String(cand.qualifiedName),
          {
            ...edge.attributes,
            unresolvedArity: undefined,
            arityResolvedFrom: dst,
            ambiguous: candidates.length > 1,
            overloadCount: candidates.length,
          },
        );
        // makeEdge stamps firstSeenAt = now; preserve the original to keep
        // freshness signals intact. Force orgId to match the stranded
        // edge in case the caller passed a ParseContext bound to a
        // different org (defensive — in production they always match).
        return { ...e, orgId: edge.orgId, firstSeenAt: edge.firstSeenAt };
      });

      // Delete the stranded edge, insert real ones in the same transaction.
      store.deleteEdge(
        orgId,
        edge.srcQualifiedName as QualifiedName,
        asQualifiedName(dst),
        edge.relType,
      );
      store.mergeEdges(newEdges);
      result.edgesEmitted += newEdges.length;
    }
  };

  if (opts.dryRun) {
    // Compute counts without mutating: walk the same logic but skip writes.
    for (const edge of stranded) {
      const dst = String(edge.dstQualifiedName);
      const key = parseStranded(dst);
      if (!key) {
        result.unresolved += 1;
        continue;
      }
      const candidates = index.get(key.className)?.get(key.methodName) ?? [];
      if (candidates.length === 0) {
        result.unresolved += 1;
        continue;
      }
      result.resolved += 1;
      if (candidates.length > 1) result.ambiguous += 1;
      result.edgesEmitted += candidates.length;
    }
    return result;
  }

  apply();
  return result;
}
