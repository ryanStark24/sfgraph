import type { OrgId, QualifiedName } from "@sfgraph/shared";
import type { NodeFact } from "../domain/index.js";
import { REL_TYPES } from "../domain/rel-types.js";
import type { GraphStore } from "../storage/interfaces.js";

export function findTestsFor(store: GraphStore, orgId: OrgId, qname: QualifiedName): NodeFact[] {
  const edges = store.listEdgesTo(orgId, qname, REL_TYPES.IS_TEST_FOR);
  const out: NodeFact[] = [];
  for (const e of edges) {
    const n = store.getNode(orgId, e.srcQualifiedName);
    if (n) out.push(n);
  }
  return out;
}

export function hasTestCoverage(store: GraphStore, orgId: OrgId, qname: QualifiedName): boolean {
  return store.listEdgesTo(orgId, qname, REL_TYPES.IS_TEST_FOR).length > 0;
}
