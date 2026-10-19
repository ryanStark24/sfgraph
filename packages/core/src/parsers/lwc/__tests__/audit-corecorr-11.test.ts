import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { REL_TYPES } from "../../../domain/index.js";
import { SqliteGraphStore } from "../../../storage/sqlite/graph-store.js";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { LwcBundleParser } from "../bundle.js";
import { resolveLwcFieldKeys } from "../field-key-resolver.js";

/**
 * Audit corecorr-11: the LWC field-key resolver indexes bare field names
 * across every object (including __mdt), so common keys are ambiguous and
 * never bind; and its `bound` Set is case-sensitive, so an explicit
 * LWC_BINDS_FIELD edge whose dst differs only in case gets overwritten with
 * {inferred:true, via:'object-key'}.
 */
const orgId = asOrgId("org_test");

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

async function newStore() {
  const store = new SqliteGraphStore({ dbPath: ":memory:" });
  await store.init();
  store.upsertOrg({
    id: orgId,
    alias: "test",
    instanceUrl: "https://example.test",
    apiVersion: "59.0",
    createdAt: Date.now(),
  });
  return store;
}

describe("audit corecorr-11: LWC field-key resolver", () => {
  it("keeps an explicit binding whose dst differs only in case", async () => {
    const store = await newStore();
    store.mergeNodes([
      node("LWC:cmp", "LWC", { recordFieldKeys: ["Foo__c"] }),
      node("CustomField:Lead.Foo__c", "CustomField"),
    ]);
    const ts = Date.now();
    store.mergeEdges([
      {
        orgId,
        srcQualifiedName: asQualifiedName("LWC:cmp"),
        dstQualifiedName: asQualifiedName("CustomField:lead.foo__c"),
        relType: REL_TYPES.LWC_BINDS_FIELD,
        attributes: { via: "schema-import", line: 3 },
        firstSeenAt: ts,
        lastSeenAt: ts,
      },
    ]);
    resolveLwcFieldKeys(store, orgId, makeTestCtx());
    const edges = store.listEdgesFrom(orgId, asQualifiedName("LWC:cmp"), REL_TYPES.LWC_BINDS_FIELD);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.attributes).toMatchObject({ via: "schema-import", line: 3 });
    expect(edges[0]?.attributes.inferred).toBeUndefined();
  });

  it("does not let a same-named __mdt field make a record field key ambiguous", async () => {
    const store = await newStore();
    store.mergeNodes([
      node("LWC:cmp", "LWC", { recordFieldKeys: ["Txn_Kind__c"] }),
      node("CustomField:Quote.Txn_Kind__c", "CustomField"),
      node("CustomField:Txn_Setting__mdt.Txn_Kind__c", "CustomField"),
    ]);
    resolveLwcFieldKeys(store, orgId, makeTestCtx());
    const dsts = store
      .listEdgesFrom(orgId, asQualifiedName("LWC:cmp"), REL_TYPES.LWC_BINDS_FIELD)
      .map((e) => String(e.dstQualifiedName));
    expect(dsts).toEqual(["CustomField:Quote.Txn_Kind__c"]);
  });

  it("prunes an inferred binding once the key is removed from the component", async () => {
    const store = await newStore();
    store.mergeNodes([
      node("LWC:cmp", "LWC", { recordFieldKeys: ["Foo__c"] }),
      node("CustomField:Lead.Foo__c", "CustomField"),
    ]);
    resolveLwcFieldKeys(store, orgId, makeTestCtx());
    const qn = asQualifiedName("LWC:cmp");
    expect(store.listEdgesFrom(orgId, qn, REL_TYPES.LWC_BINDS_FIELD)).toHaveLength(1);
    // Re-sync with new content (a new sourceHash, as a re-parse would carry).
    store.mergeNodes([
      { ...node("LWC:cmp", "LWC", { recordFieldKeys: [] }), sourceHash: asSha256("cmp-v2") },
    ]);
    resolveLwcFieldKeys(store, orgId, makeTestCtx());
    expect(store.listEdgesFrom(orgId, qn, REL_TYPES.LWC_BINDS_FIELD)).toEqual([]);
  });

  it("review I-4: the parser records statically present object context", async () => {
    const { nodes } = await new LwcBundleParser().parse(
      {
        bundleName: "ctxCmp",
        files: {
          "ctxCmp.js": [
            "import NAME_FIELD from '@salesforce/schema/Account.Name';",
            "import ORDER_OBJECT from '@salesforce/schema/Order';",
            "export default class C { build() { return { Shared_Flag__c: true }; } }",
          ].join("\n"),
          "ctxCmp.js-meta.xml": `<?xml version="1.0" encoding="UTF-8"?>
<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata">
  <isExposed>true</isExposed>
  <targets><target>lightning__RecordPage</target></targets>
  <targetConfigs>
    <targetConfig targets="lightning__RecordPage"><objects><object>Case</object></objects></targetConfig>
  </targetConfigs>
</LightningComponentBundle>`,
        },
      },
      makeTestCtx(),
    );
    const lwc = nodes.find((n) => String(n.qualifiedName) === "LWC:ctxCmp");
    expect(lwc?.attributes.recordObjects).toEqual(["Account", "Case", "Order"]);
  });

  it("review I-4: binds an ambiguous key inside the component's object context only", async () => {
    const store = await newStore();
    store.mergeNodes([
      node("LWC:imports", "LWC", { recordFieldKeys: ["Shared_Flag__c"], recordObjects: ["Order"] }),
      node("LWC:placed", "LWC", { recordFieldKeys: ["Shared_Flag__c"] }),
      node("LWC:noCtx", "LWC", { recordFieldKeys: ["Shared_Flag__c"] }),
      node("FlexiPage:Quote_Page", "FlexiPage", { sobjectType: "Quote" }),
      node("CustomField:Quote.Shared_Flag__c", "CustomField"),
      node("CustomField:Order.Shared_Flag__c", "CustomField"),
      node("CustomField:Lead.Shared_Flag__c", "CustomField"),
    ]);
    const ts = Date.now();
    store.mergeEdges([
      {
        orgId,
        srcQualifiedName: asQualifiedName("FlexiPage:Quote_Page"),
        dstQualifiedName: asQualifiedName("LWC:placed"),
        relType: REL_TYPES.EMBEDS_LWC,
        attributes: {},
        firstSeenAt: ts,
        lastSeenAt: ts,
      },
    ]);
    const res = resolveLwcFieldKeys(store, orgId, makeTestCtx());
    const dsts = (qn: string) =>
      store
        .listEdgesFrom(orgId, asQualifiedName(qn), REL_TYPES.LWC_BINDS_FIELD)
        .map((e) => String(e.dstQualifiedName));
    expect(dsts("LWC:imports")).toEqual(["CustomField:Order.Shared_Flag__c"]);
    expect(dsts("LWC:placed")).toEqual(["CustomField:Quote.Shared_Flag__c"]);
    // No object context: left unresolved and counted, never fanned out.
    expect(dsts("LWC:noCtx")).toEqual([]);
    expect(res).toMatchObject({ scanned: 3, resolved: 2, ambiguous: 1 });
  });
});
