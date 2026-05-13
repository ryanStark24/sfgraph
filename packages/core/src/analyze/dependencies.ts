import type { OrgId, QualifiedName } from "@ryanstark24/sfgraph-shared";
import type { EdgeFact, NodeFact } from "../domain/index.js";
import type { GraphStore } from "../storage/interfaces.js";
import type { TraversalResult } from "./dependents.js";

export function findDependencies(
  store: GraphStore,
  orgId: OrgId,
  qname: QualifiedName,
  depth = 3,
): TraversalResult {
  const visited = new Set<string>();
  const nodes: NodeFact[] = [];
  const edges: EdgeFact[] = [];
  let frontier: QualifiedName[] = [qname];
  visited.add(qname);
  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const next: QualifiedName[] = [];
    for (const cur of frontier) {
      const outgoing = store.listEdgesFrom(orgId, cur);
      for (const e of outgoing) {
        edges.push(e);
        if (!visited.has(e.dstQualifiedName)) {
          visited.add(e.dstQualifiedName);
          const n = store.getNode(orgId, e.dstQualifiedName);
          if (n) nodes.push(n);
          next.push(e.dstQualifiedName);
        }
      }
    }
    frontier = next;
  }
  return { nodes, edges };
}
