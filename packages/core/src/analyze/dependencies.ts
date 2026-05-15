import type { OrgId, QualifiedName } from "@ryanstark24/sfgraph-shared";
import type { EdgeFact, NodeFact } from "../domain/index.js";
import type { GraphStore } from "../storage/interfaces.js";
import { TRAVERSAL_NODE_CAP_DEFAULT, type TraversalResult } from "./dependents.js";

function nodeCap(): number {
  const raw = process.env.SFGRAPH_TRAVERSAL_NODE_CAP;
  if (!raw) return TRAVERSAL_NODE_CAP_DEFAULT;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : TRAVERSAL_NODE_CAP_DEFAULT;
}

export function findDependencies(
  store: GraphStore,
  orgId: OrgId,
  qname: QualifiedName,
  depth = 3,
): TraversalResult {
  const cap = nodeCap();
  const visited = new Set<string>();
  const nodes: NodeFact[] = [];
  const edges: EdgeFact[] = [];
  let frontier: QualifiedName[] = [qname];
  visited.add(qname);
  let truncated = false;
  bfs: for (let d = 0; d < depth && frontier.length > 0; d++) {
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
          if (visited.size >= cap) {
            truncated = true;
            break bfs;
          }
        }
      }
    }
    frontier = next;
  }
  return { nodes, edges, truncated };
}
