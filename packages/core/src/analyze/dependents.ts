import type { OrgId, QualifiedName } from "@ryanstark24/sfgraph-shared";
import type { EdgeFact, NodeFact } from "../domain/index.js";
import type { GraphStore } from "../storage/interfaces.js";

export interface TraversalResult {
  nodes: NodeFact[];
  edges: EdgeFact[];
  /** Set when the traversal hit `NODE_CAP` before exhausting the graph. */
  truncated?: boolean;
}

/**
 * Hard ceiling on visited nodes per traversal. Prevents an agent — or a
 * crafted call — from blowing memory by asking for depth=5 on a hub like
 * `CustomObject:Account` or a heavily-referenced custom field.
 *
 * Override via `TRAVERSAL_NODE_CAP` env var if you really need more.
 */
export const TRAVERSAL_NODE_CAP_DEFAULT = 500;
function nodeCap(): number {
  const raw = process.env.SFGRAPH_TRAVERSAL_NODE_CAP;
  if (!raw) return TRAVERSAL_NODE_CAP_DEFAULT;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : TRAVERSAL_NODE_CAP_DEFAULT;
}

export function findDependents(
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
      const incoming = store.listEdgesTo(orgId, cur);
      for (const e of incoming) {
        edges.push(e);
        if (!visited.has(e.srcQualifiedName)) {
          visited.add(e.srcQualifiedName);
          const n = store.getNode(orgId, e.srcQualifiedName);
          if (n) nodes.push(n);
          next.push(e.srcQualifiedName);
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
