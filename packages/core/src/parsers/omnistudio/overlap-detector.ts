import { asOrgId } from "@ryanstark24/sfgraph-shared";
import type { OrgId, QualifiedName } from "@ryanstark24/sfgraph-shared";
import type { EdgeFact } from "../../domain/index.js";
import { REL_TYPES } from "../../domain/index.js";
import type { GraphStore } from "../../storage/interfaces.js";
import { makeEdge } from "../common.js";
import type { ParseContext } from "../contract.js";
import { normalizeKey } from "../cross-flavor-resolver.js";

/**
 * Post-merge pass that annotates CANONICAL_OF pairs with a structural
 * comparison. The cross-flavor resolver (cross-flavor-resolver.ts) tells us
 * that `DataRaptor:Foo` and `OmniDataTransform:Foo` share a name; this pass
 * tells us whether they actually *do the same thing* — useful when an org
 * is mid-migration from Vlocity-CMT to OmniStudio-on-Core and a stakeholder
 * needs to know which "same-named pair" is a true duplicate (cleanup
 * candidate) versus a diverged implementation (needs manual reconciliation).
 *
 * Signature shape per node = sorted multiset of `(relType, normalisedDstLabel)`
 * across the node's *outgoing* edges, with CANONICAL_OF self-edges excluded.
 * Normalised dst label strips the `OmniDataTransform:` vs `DataRaptor:` etc.
 * prefix family so the same downstream link is treated as the same in both
 * flavours. We don't bake dst qname into the signature — that would treat
 * "calls DR_Foo" and "calls OmniDataTransform:Foo" as different even when
 * those two are themselves a CANONICAL_OF pair.
 *
 * Output: same CANONICAL_OF edges, but with `signaturesMatch:boolean` and
 * `divergencePoints:string[]` attributes added. The edge identity
 * (src/dst/relType) is unchanged, so mergeEdges idempotently updates the
 * attributes in place.
 *
 * Feature-flagged off by default in live-ingest (`disableOverlapDetect: true`)
 * because the false-positive recovery cost is high — a wrong "diverged"
 * label on a real duplicate sends an engineer chasing a non-issue.
 */

export interface OverlapDetectOpts {
  orgId: OrgId | string;
  ctx: ParseContext;
  /** When true, do not write annotated edges back to the store. */
  dryRun?: boolean;
}

export interface OverlapDetectResult {
  /** CANONICAL_OF pairs whose endpoints share an identical signature. */
  matched: number;
  /** CANONICAL_OF pairs whose signatures diverge. */
  diverged: number;
  /** CANONICAL_OF pairs whose endpoint nodes have no outgoing non-canonical
   *  edges on either side — comparison is vacuous, treated neither as
   *  matched nor diverged. */
  empty: number;
  /** Total edges annotated (one per CANONICAL_OF edge inspected). */
  annotated: number;
}

const FLAVOR_LABEL_PREFIXES: Array<[RegExp, string]> = [
  // Group the four pairs the cross-flavor resolver matches so they collapse
  // to a single canonical token in the signature multiset.
  [/^DataRaptor:|^OmniDataTransform:/i, "dr_or_odt"],
  [/^IntegrationProcedure:|^OmniIntegrationProcedure:/i, "ip_or_oip"],
  [/^OmniScript:|^OmniProcess:/i, "os_or_op"],
  [/^VlocityCard:|^OmniUiCard:/i, "vc_or_ouc"],
];

function normaliseLabel(dstQname: string): string {
  for (const [re, token] of FLAVOR_LABEL_PREFIXES) {
    if (re.test(dstQname)) return token;
  }
  // Fall back to the raw label prefix (everything before the first `:`),
  // lowercased. We do NOT include the dst's qualified name because two
  // different OmniScripts that both happen to call a DataRaptor named "X"
  // should produce the same signature shape if they call the same number of
  // DataRaptors and the same number of other things.
  const colon = dstQname.indexOf(":");
  return (colon >= 0 ? dstQname.slice(0, colon) : dstQname).toLowerCase();
}

function buildSignature(edges: EdgeFact[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of edges) {
    if (e.relType === REL_TYPES.CANONICAL_OF) continue;
    const key = `${e.relType}|${normaliseLabel(String(e.dstQualifiedName))}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function diffSignatures(a: Map<string, number>, b: Map<string, number>): string[] {
  const out: string[] = [];
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of [...keys].sort()) {
    const av = a.get(k) ?? 0;
    const bv = b.get(k) ?? 0;
    if (av !== bv) out.push(`${k}: ${av} vs ${bv}`);
  }
  return out;
}

export function detectOmnistudioOverlap(
  store: GraphStore,
  opts: OverlapDetectOpts,
): OverlapDetectResult {
  const orgId = typeof opts.orgId === "string" ? asOrgId(opts.orgId) : opts.orgId;
  const result: OverlapDetectResult = { matched: 0, diverged: 0, empty: 0, annotated: 0 };

  // Walk every CANONICAL_OF edge. We deliberately read them via the
  // listNodesByLabel + listEdgesFrom path rather than a wildcard scan —
  // we already know the canonical pairs come from the four flavour
  // labels listed in cross-flavor-resolver.PAIRS, so we iterate those
  // and read each node's outgoing CANONICAL_OF edges to find the pair.
  // This avoids scanning the whole edge table.
  const FLAVOR_LABELS = [
    "DataRaptor",
    "IntegrationProcedure",
    "OmniScript",
    "VlocityCard",
  ];

  // Cache outgoing edges per node so we don't re-fetch them when a node
  // appears in multiple CANONICAL_OF pairs (rare but possible if a name
  // collides across flavours).
  const outgoingCache = new Map<string, EdgeFact[]>();
  const outgoingOf = (qname: QualifiedName): EdgeFact[] => {
    const key = String(qname);
    const hit = outgoingCache.get(key);
    if (hit) return hit;
    const all = store.listEdgesFrom(orgId, qname);
    outgoingCache.set(key, all);
    return all;
  };

  // Pairs we've already inspected (both directions of the same logical pair
  // produce two CANONICAL_OF edges — annotate both but only count once).
  const seenPairs = new Set<string>();
  const pendingEdges: EdgeFact[] = [];

  for (const label of FLAVOR_LABELS) {
    const nodes = store.listNodesByLabel(orgId, label);
    for (const n of nodes) {
      const canonEdges = store
        .listEdgesFrom(orgId, n.qualifiedName, REL_TYPES.CANONICAL_OF)
        .filter((e) => e.relType === REL_TYPES.CANONICAL_OF);
      for (const ce of canonEdges) {
        const pairKey = [String(ce.srcQualifiedName), String(ce.dstQualifiedName)]
          .sort()
          .join("|");
        const alreadySeen = seenPairs.has(pairKey);

        const sigA = buildSignature(outgoingOf(ce.srcQualifiedName));
        const sigB = buildSignature(outgoingOf(ce.dstQualifiedName));
        const divergence = diffSignatures(sigA, sigB);
        const signaturesMatch = divergence.length === 0;
        const isEmpty = sigA.size === 0 && sigB.size === 0;

        if (!alreadySeen) {
          seenPairs.add(pairKey);
          if (isEmpty) result.empty += 1;
          else if (signaturesMatch) result.matched += 1;
          else result.diverged += 1;
        }

        // Re-emit the same CANONICAL_OF edge with the new attributes in
        // BOTH directions. mergeEdges is idempotent on (orgId, src, dst,
        // relType), so this updates the existing rows' attributes in
        // place. We iterate Vlocity-side labels only (the FLAVOR_LABELS
        // list above is intentionally one-sided), so without this both-
        // direction emit the Omni→Vlocity edge would never be annotated.
        const annotationAttrs = {
          ...ce.attributes,
          signaturesMatch,
          divergencePoints: divergence,
          overlapEvaluatedAt: opts.ctx.parseTimestamp,
        };
        pendingEdges.push(
          makeEdge(
            opts.ctx,
            String(ce.srcQualifiedName),
            REL_TYPES.CANONICAL_OF,
            String(ce.dstQualifiedName),
            annotationAttrs,
          ),
        );
        pendingEdges.push(
          makeEdge(
            opts.ctx,
            String(ce.dstQualifiedName),
            REL_TYPES.CANONICAL_OF,
            String(ce.srcQualifiedName),
            annotationAttrs,
          ),
        );
        result.annotated += 2;
      }
    }
  }

  if (!opts.dryRun && pendingEdges.length > 0) {
    store.transaction(() => {
      store.mergeEdges(pendingEdges);
    });
  }

  return result;
}
