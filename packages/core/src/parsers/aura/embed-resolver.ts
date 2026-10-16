import type { OrgId } from "@ryanstark24/sfgraph-shared";
import { asQualifiedName } from "@ryanstark24/sfgraph-shared";
import { type EdgeFact, REL_TYPES } from "../../domain/index.js";
import type { GraphStore } from "../../storage/interfaces.js";

/**
 * review I4: the Aura parser sees one bundle, so for `<c:name>` it can only
 * guess Aura vs LWC from the first letter. Aura bundle names may start
 * lowercase (`aura/exportRowsCsv`), so after the merge this pass re-targets
 * each embed from an Aura component against the bundles that exist:
 * `AuraComponent:name` if that node exists, else `LWC:name` if that exists,
 * else the parser's first-letter guess. The result depends only on the final
 * graph (tag name + node set), so delta and full ingests agree.
 */
export interface AuraEmbedResolveResult {
  scanned: number;
  retargeted: number;
}

export function resolveAuraEmbeds(store: GraphStore, orgId: OrgId): AuraEmbedResolveResult {
  const result: AuraEmbedResolveResult = { scanned: 0, retargeted: 0 };
  const fromAura = (e: EdgeFact) => String(e.srcQualifiedName).startsWith("AuraComponent:");
  const edges = [
    ...store.listEdgesByDstLike(orgId, "LWC:%", REL_TYPES.EMBEDS_LWC),
    ...store.listEdgesByDstLike(orgId, "AuraComponent:%", REL_TYPES.EMBEDS_AURA),
  ].filter(fromAura);
  if (edges.length === 0) return result;
  const known = new Map<string, boolean>();
  const exists = (qname: string): boolean => {
    let hit = known.get(qname);
    if (hit === undefined) {
      hit = store.getNode(orgId, asQualifiedName(qname)) !== null;
      known.set(qname, hit);
    }
    return hit;
  };
  // review R1-4: plan first, then delete + re-merge in one transaction so a
  // failure part-way can't leave a bundle without its embed edges.
  const moved: Array<{ from: EdgeFact; to: EdgeFact }> = [];
  for (const e of edges) {
    result.scanned += 1;
    const dst = String(e.dstQualifiedName);
    const name = dst.slice(dst.indexOf(":") + 1);
    const aura = `AuraComponent:${name}`;
    const lwc = `LWC:${name}`;
    const first = name.charAt(0);
    const want: { rel: EdgeFact["relType"]; dst: string } = exists(aura)
      ? { rel: REL_TYPES.EMBEDS_AURA, dst: aura }
      : exists(lwc)
        ? { rel: REL_TYPES.EMBEDS_LWC, dst: lwc }
        : // Neither exists: the parser's first-letter guess (so a bundle deleted
          // under an unchanged parent reverts exactly as a rebuild would).
          first >= "a" && first <= "z"
          ? { rel: REL_TYPES.EMBEDS_LWC, dst: lwc }
          : { rel: REL_TYPES.EMBEDS_AURA, dst: aura };
    if (want.rel === e.relType && want.dst === dst) continue;
    moved.push({
      from: e,
      to: { ...e, relType: want.rel, dstQualifiedName: asQualifiedName(want.dst) },
    });
  }
  if (moved.length === 0) return result;
  store.transaction(() => {
    for (const { from } of moved) {
      store.deleteEdge(orgId, from.srcQualifiedName, from.dstQualifiedName, from.relType);
    }
    store.mergeEdges(moved.map((m) => m.to));
  });
  result.retargeted = moved.length;
  return result;
}
