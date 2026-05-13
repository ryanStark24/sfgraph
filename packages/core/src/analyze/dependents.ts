import type { OrgId, QualifiedName } from "@sfgraph/shared";
import type { EdgeFact, NodeFact } from "../domain/index.js";
import type { GraphStore } from "../storage/interfaces.js";

export interface TraversalResult {
  nodes: NodeFact[];
  edges: EdgeFact[];
}

export function findDependents(
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
      const incoming = store.listEdgesTo(orgId, cur);
      for (const e of incoming) {
        edges.push(e);
        if (!visited.has(e.srcQualifiedName)) {
          visited.add(e.srcQualifiedName);
          const n = store.getNode(orgId, e.srcQualifiedName);
          if (n) nodes.push(n);
          next.push(e.srcQualifiedName);
        }
      }
    }
    frontier = next;
  }
  return { nodes, edges };
}
