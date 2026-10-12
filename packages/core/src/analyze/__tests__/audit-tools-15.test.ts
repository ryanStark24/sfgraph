import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import type { NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { SECURITY_PER_LABEL_CAP, securityAudit } from "../security.js";

// audit tools-15: the object/field filter must apply before the per-label cap,
// so narrowing finds FLS gaps on fields that sit past the first cap rows.
const ORG = asOrgId("org_tools15");

function field(qname: string): NodeFact {
  return {
    orgId: ORG,
    qualifiedName: asQualifiedName(qname),
    label: "CustomField",
    attributes: {},
    sourceHash: asSha256(qname),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
}

describe("audit tools-15: security_audit filter before cap", () => {
  it("object filter finds an ungranted field beyond the first cap rows", async () => {
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    const filler: NodeFact[] = [];
    for (let i = 0; i < SECURITY_PER_LABEL_CAP; i++) {
      filler.push(field(`CustomField:Account.F${i}__c`));
    }
    store.mergeNodes(filler);
    store.mergeNodes([field("CustomField:Response_Log__c.Error_Text__c")]);
    const r = securityAudit(store, ORG, { object: "Response_Log__c" });
    expect(r.flsGaps).toContain("CustomField:Response_Log__c.Error_Text__c");
    expect(r.truncated).toBe(false);
    const f = securityAudit(store, ORG, { field: "CustomField:Response_Log__c.Error_Text__c" });
    expect(f.flsGaps).toEqual(["CustomField:Response_Log__c.Error_Text__c"]);
    await store.close();
  });
});
