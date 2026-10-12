import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { REL_TYPES } from "../../../domain/index.js";
import { SqliteGraphStore } from "../../../storage/sqlite/graph-store.js";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { resolveLwcFieldKeys } from "../field-key-resolver.js";

const orgId = asOrgId("00Dxx0000000ABCEAA");

function node(qn: string, label: string, attrs: Record<string, unknown> = {}) {
  const ts = Date.now();
  return {
    orgId,
    qualifiedName: asQualifiedName(qn),
    label,
    attributes: attrs,
    sourceHash: asSha256(qn),
    firstSeenAt: ts,
    lastSeenAt: ts,
    lastModifiedAt: ts,
  };
}

async function seed() {
  const store = new SqliteGraphStore({ dbPath: ":memory:" });
  await store.init();
  store.upsertOrg({
    id: orgId,
    alias: "test",
    instanceUrl: "https://example.test",
    apiVersion: "59.0",
    createdAt: Date.now(),
  });
  store.mergeNodes([
    node("LWC:payloadBuilder", "LWC", {
      recordFieldKeys: ["Unique_Remarks__c", "Shared_Flag__c", "Missing__c", "Already_Bound__c"],
    }),
    node("LWC:plain", "LWC", {}),
    node("CustomField:Quote.Unique_Remarks__c", "CustomField"),
    node("CustomField:Quote.Shared_Flag__c", "CustomField"),
    node("CustomField:Order.Shared_Flag__c", "CustomField"),
    node("CustomField:Case.Already_Bound__c", "CustomField"),
  ]);
  const ts = Date.now();
  store.mergeEdges([
    {
      orgId,
      srcQualifiedName: asQualifiedName("LWC:payloadBuilder"),
      dstQualifiedName: asQualifiedName("CustomField:Case.Already_Bound__c"),
      relType: REL_TYPES.LWC_BINDS_FIELD,
      attributes: { binding: "rec.Already_Bound__c" },
      firstSeenAt: ts,
      lastSeenAt: ts,
    },
  ]);
  return store;
}

describe("resolveLwcFieldKeys", () => {
  it("binds only keys whose field API name is unique in the graph", async () => {
    const store = await seed();
    const res = resolveLwcFieldKeys(store, orgId, makeTestCtx());
    expect(res).toEqual({ scanned: 4, resolved: 1, ambiguous: 1, missing: 1, existing: 1 });
    const out = store
      .listEdgesFrom(orgId, asQualifiedName("LWC:payloadBuilder"), REL_TYPES.LWC_BINDS_FIELD)
      .map((e) => [String(e.dstQualifiedName), e.attributes])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(out).toEqual([
      ["CustomField:Case.Already_Bound__c", { binding: "rec.Already_Bound__c" }],
      [
        "CustomField:Quote.Unique_Remarks__c",
        {
          inferred: true,
          via: "object-key",
          resolvedBy: "lwc-field-key-resolver",
          sourceUri: "test://uri",
        },
      ],
    ]);
  });

  it("is idempotent", async () => {
    const store = await seed();
    resolveLwcFieldKeys(store, orgId, makeTestCtx());
    resolveLwcFieldKeys(store, orgId, makeTestCtx());
    expect(
      store.listEdgesFrom(orgId, asQualifiedName("LWC:payloadBuilder"), REL_TYPES.LWC_BINDS_FIELD),
    ).toHaveLength(2);
  });
});
