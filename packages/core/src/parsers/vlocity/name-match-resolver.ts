import { asOrgId } from "@ryanstark24/sfgraph-shared";
import type { OrgId } from "@ryanstark24/sfgraph-shared";
import type { EdgeFact } from "../../domain/index.js";
import { REL_TYPES } from "../../domain/index.js";
import type { GraphStore } from "../../storage/interfaces.js";
import { makeEdge } from "../common.js";
import type { ParseContext } from "../contract.js";
import { pruneStaleResolverEdges } from "../resolver-prune.js";

/**
 * Resolve DataPack string values that are exactly the name of one existing
 * IntegrationProcedure / DataRaptor / OmniScript (recorded by the DataPack
 * scanner as `nameMatchCandidates` on the opaque member node) into REFERENCES
 * edges tagged `inferred="name-match"`. Only exact (case-sensitive) matches
 * that identify exactly one component across the three labels are emitted;
 * ambiguous or unknown names produce nothing. Edges merge by key, so
 * re-running is idempotent, and earlier edges the run no longer derives are
 * pruned.
 */
export interface NameMatchResolveResult {
  scanned: number;
  matched: number;
  ambiguous: number;
  edgesEmitted: number;
}

const SKIP_LABELS = new Set([
  "ApexClass",
  "ApexMethod",
  "ApexTrigger",
  "CustomField",
  "CustomObject",
  "LWC",
  "Flow",
  "FlowElement",
]);
const TARGET_LABELS = ["IntegrationProcedure", "DataRaptor", "OmniScript"] as const;
/** Target labels that are also candidate sources (Set Values literals). */
const SOURCE_COMPONENT_LABELS = new Set(["IntegrationProcedure", "OmniScript"]);

export function resolveVlocityNameMatches(
  store: GraphStore,
  orgIdIn: OrgId | string,
  ctx: ParseContext,
): NameMatchResolveResult {
  const orgId = typeof orgIdIn === "string" ? asOrgId(orgIdIn) : orgIdIn;
  const result: NameMatchResolveResult = { scanned: 0, matched: 0, ambiguous: 0, edgesEmitted: 0 };

  // name -> qualified names of all IP/DR/OS nodes with that exact name
  const byName = new Map<string, string[]>();
  for (const label of TARGET_LABELS) {
    for (const n of store.listNodesByLabel(orgId, label)) {
      const qn = String(n.qualifiedName);
      const name = qn.slice(label.length + 1);
      const l = byName.get(name) ?? [];
      l.push(qn);
      byName.set(name, l);
    }
  }
  const owner = "vlocity-name-match-resolver";
  const edges: EdgeFact[] = [];
  const seen = new Set<string>();
  // Candidates live on opaque DataPack member nodes of arbitrary labels; skip
  // the target labels and the high-volume source-metadata labels.
  for (const label of byName.size === 0 ? [] : store.listAllLabels()) {
    // OmniScript / IP nodes carry Set Values literals as candidates; DataRaptors none.
    const componentSource = SOURCE_COMPONENT_LABELS.has(label);
    if (
      (!componentSource && (TARGET_LABELS as readonly string[]).includes(label)) ||
      SKIP_LABELS.has(label)
    )
      continue;
    for (const n of store.listNodesByLabel(orgId, label)) {
      const cands = (n.attributes as Record<string, unknown>).nameMatchCandidates;
      if (!Array.isArray(cands)) continue;
      const src = String(n.qualifiedName);
      // Never overwrite an explicit edge with the same key (this resolver's
      // own earlier output is re-derived, not "explicit"; nor is the
      // reflection walker's, which runs after this pass and yields to it).
      // Lower-cased: the store's edge key is NOCASE.
      const existing = new Set(
        store
          // A component source's typed edge (OS_CALLS_IP, …) to the same
          // target already says it: any rel counts there.
          .listEdgesFrom(orgId, n.qualifiedName, componentSource ? undefined : REL_TYPES.REFERENCES)
          .filter((e) => {
            const a = e.attributes as Record<string, unknown> | undefined;
            return a?.resolvedBy !== owner && a?.source !== "reflection";
          })
          .map((e) => String(e.dstQualifiedName).toLowerCase()),
      );
      for (const c of cands) {
        if (typeof c !== "string") continue;
        result.scanned += 1;
        const hits = byName.get(c);
        if (!hits) continue;
        if (hits.length !== 1) {
          result.ambiguous += 1;
          continue;
        }
        const dst = hits[0] as string;
        if (dst === src || existing.has(dst.toLowerCase()) || seen.has(`${src}|${dst}`)) continue;
        seen.add(`${src}|${dst}`);
        result.matched += 1;
        edges.push({
          ...makeEdge(ctx, src, REL_TYPES.REFERENCES, dst, {
            inferred: "name-match",
            resolvedBy: owner,
          }),
          orgId,
          firstSeenAt: n.firstSeenAt,
        });
      }
    }
  }
  // Drop earlier name-match edges this run no longer derives (candidate
  // removed from the source, target renamed or now ambiguous).
  const previous = TARGET_LABELS.flatMap((l) =>
    store.listEdgesByDstLike(orgId, `${l}:%`, REL_TYPES.REFERENCES),
  );
  pruneStaleResolverEdges(store, orgId, owner, previous, edges);
  if (edges.length > 0) store.mergeEdges(edges);
  result.edgesEmitted = edges.length;
  return result;
}
