import type { OrgId, QualifiedName } from "@ryanstark24/sfgraph-shared";
import { REL_TYPES } from "../domain/rel-types.js";
import type { GraphStore } from "../storage/interfaces.js";

export function hasTestCoverage(store: GraphStore, orgId: OrgId, qname: QualifiedName): boolean {
  return store.listEdgesTo(orgId, qname, REL_TYPES.IS_TEST_FOR).length > 0;
}
