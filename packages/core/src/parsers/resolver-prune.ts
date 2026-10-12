import type { OrgId } from "@ryanstark24/sfgraph-shared";
import type { EdgeFact } from "../domain/index.js";
import type { GraphStore } from "../storage/interfaces.js";

const edgeKey = (e: Pick<EdgeFact, "relType" | "srcQualifiedName" | "dstQualifiedName">) =>
  `${e.relType}|${String(e.srcQualifiedName)}|${String(e.dstQualifiedName)}`.toLowerCase();

/**
 * Post-merge resolvers re-derive their whole output on every run, but member
 * reconcile never deletes `resolvedBy` edges (they belong to no member). So
 * each resolver prunes its own stale output: every edge in `previous` tagged
 * `resolvedBy === owner` that this run did not produce again (`current`) is
 * deleted. `previous` must cover everything the resolver could have emitted
 * on an earlier run (its rel types / dst patterns / sources); edges from any
 * other owner are never touched. Returns the number of deleted edges.
 */
export function pruneStaleResolverEdges(
  store: GraphStore,
  orgId: OrgId,
  owner: string,
  previous: Iterable<EdgeFact>,
  current: Iterable<Pick<EdgeFact, "relType" | "srcQualifiedName" | "dstQualifiedName">>,
): number {
  const keep = new Set<string>();
  for (const e of current) keep.add(edgeKey(e));
  const done = new Set<string>();
  let deleted = 0;
  for (const e of previous) {
    if ((e.attributes as Record<string, unknown> | undefined)?.resolvedBy !== owner) continue;
    const k = edgeKey(e);
    if (keep.has(k) || done.has(k)) continue;
    done.add(k);
    store.deleteEdge(orgId, e.srcQualifiedName, e.dstQualifiedName, e.relType);
    deleted += 1;
  }
  return deleted;
}
