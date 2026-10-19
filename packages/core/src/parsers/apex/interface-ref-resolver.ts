import { asOrgId, asQualifiedName } from "@ryanstark24/sfgraph-shared";
import type { OrgId } from "@ryanstark24/sfgraph-shared";
import type { GraphStore } from "../../storage/interfaces.js";

/**
 * An Apex interface is deployed as ApexClass metadata, so references that
 * only know the member name (Profile / PermissionSet `classAccesses`, and any
 * other `ApexClass:<name>` emitter) target `ApexClass:<name>` even when the
 * node is `ApexInterface:<name>`. For every interface whose `ApexClass:` twin
 * does not exist, move those inbound edges onto the interface node (same
 * src / rel / attrs, plus `retargetedFrom`).
 *
 * The moved edge deliberately carries no `resolvedBy` / `source`: it stays
 * owned by its source member, so member reconcile drops it when the source
 * stops emitting the reference (and re-parsing re-emits the `ApexClass:` edge,
 * which the next run moves again). Idempotent. Returns the number moved.
 *
 * Each delete + re-merge runs in one store transaction, so a failure cannot
 * lose the reference. An interface edge that already exists keeps its
 * `first_seen_at` (the store's merge only updates attributes / last_seen_at).
 * When the source member is re-parsed, reconcile drops the moved copy and the
 * parser re-emits the `ApexClass:` guess; the store's mergeEdges gives that
 * guess the moved edge's `first_seen_at` (the edge it was rewritten to, found
 * by `retargetedFrom`), so the move here keeps it too.
 *
 * Gating: live-ingest calls this as its own post-merge pass, independent of
 * `--no-arity-resolve` (`disableInterfaceRetarget` switches it off), and logs
 * the moved count as `interfaceRefsRetargeted`. `interfaceNames` limits the
 * pass to those interface names, lower-cased (delta ingest).
 */
export function retargetApexInterfaceRefs(
  store: GraphStore,
  orgIdIn: OrgId | string,
  opts: { interfaceNames?: ReadonlySet<string> } = {},
): number {
  const orgId = typeof orgIdIn === "string" ? asOrgId(orgIdIn) : orgIdIn;
  const only = opts.interfaceNames;
  let moved = 0;
  for (const iface of store.listNodesByLabel(orgId, "ApexInterface")) {
    const name = String(iface.qualifiedName).slice("ApexInterface:".length);
    if (!name) continue;
    if (only && !only.has(name.toLowerCase())) continue;
    const classQn = `ApexClass:${name}`;
    if (store.getNode(orgId, asQualifiedName(classQn))) continue;
    // LIKE treats `_` as a wildcard (no ESCAPE clause): the exact
    // case-insensitive dst is confirmed below.
    const refs = store
      .listEdgesByDstLike(orgId, classQn)
      .filter((e) => String(e.dstQualifiedName).toLowerCase() === classQn.toLowerCase());
    if (refs.length === 0) continue;
    store.transaction(() => {
      for (const e of refs) {
        store.deleteEdge(orgId, e.srcQualifiedName, e.dstQualifiedName, e.relType);
        store.mergeEdges([
          {
            ...e,
            dstQualifiedName: iface.qualifiedName,
            attributes: { ...e.attributes, retargetedFrom: String(e.dstQualifiedName) },
          },
        ]);
      }
    });
    moved += refs.length;
  }
  return moved;
}
