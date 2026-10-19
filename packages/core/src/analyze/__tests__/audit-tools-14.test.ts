import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import type { NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { findNodesByGlob } from "../find-nodes.js";

// audit tools-14: find_nodes pattern and label are case-insensitive like the
// other lookups.
const ORG = asOrgId("org_tools14");

function node(label: string, qname: string): NodeFact {
  return {
    orgId: ORG,
    qualifiedName: asQualifiedName(qname),
    label,
    attributes: {},
    sourceHash: asSha256(qname),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
}

describe("audit tools-14: case-insensitive find_nodes", () => {
  it("matches a lower-case pattern and a lower-case label", async () => {
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    store.mergeNodes([
      node("ApexClass", "ApexClass:Acme_BillingCtrl"),
      node("ApexClass", "ApexClass:Other"),
    ]);
    const byPattern = findNodesByGlob(store, ORG, "apexclass:acme_billing*");
    expect(byPattern.matches.map((n) => String(n.qualifiedName))).toEqual([
      "ApexClass:Acme_BillingCtrl",
    ]);
    const byLabel = findNodesByGlob(store, ORG, "**:Acme_Billing*", { label: "apexclass" });
    expect(byLabel.matches.map((n) => String(n.qualifiedName))).toEqual([
      "ApexClass:Acme_BillingCtrl",
    ]);
    await store.close();
  });
});
