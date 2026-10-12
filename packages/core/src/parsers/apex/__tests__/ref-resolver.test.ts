import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { REL_TYPES } from "../../../domain/index.js";
import { SqliteGraphStore } from "../../../storage/sqlite/graph-store.js";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { resolveApexReferences } from "../ref-resolver.js";

/**
 * Task 14 batch P: the post-merge Apex reference resolver turns the parser's
 * `apexRelationshipPaths` (SOQL / member-access relationship traversals) and
 * `testTargetCandidates` (lowercase-initial test targets) into edges, using
 * only graph metadata (lookup referenceTo / relationshipName, known classes)
 * and the standard relationship names; anything else is skipped and counted.
 */
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

function edge(rel: string, src: string, dst: string, attrs: Record<string, unknown> = {}) {
  const ts = Date.now();
  return {
    orgId,
    srcQualifiedName: asQualifiedName(src),
    dstQualifiedName: asQualifiedName(dst),
    relType: rel as typeof REL_TYPES.DEFINES_FIELD,
    attributes: attrs,
    firstSeenAt: ts,
    lastSeenAt: ts,
  };
}

const R = "READS_FIELD";
const W = "WRITES_FIELD";

async function seed(
  paths: Array<{ object: string; path: string; rel: string }>,
  cands: string[] = [],
) {
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
    node("ApexMethod:Svc.run(0)", "ApexMethod", { apexRelationshipPaths: paths }),
    node("ApexClass:showProductTest", "ApexClass", { isTest: true, testTargetCandidates: cands }),
    node("ApexClass:ShowProductController", "ApexClass"),
    node("ApexInterface:fooApi", "ApexInterface"),
    node("CustomObject:Widget__c", "CustomObject"),
    node("CustomObject:Maker__c", "CustomObject"),
    node("CustomField:Widget__c.Built_By__c", "CustomField", {
      referenceTo: ["Maker__c"],
      relationshipName: "Builder",
    }),
    node("CustomField:Widget__c.Maker__c", "CustomField", {
      referenceTo: ["Maker__c"],
      relationshipName: "Maker",
    }),
    node("CustomField:Widget__c.Either__c", "CustomField", {
      referenceTo: ["Maker__c", "Account"],
      relationshipName: "Either",
    }),
    node("CustomField:Maker__c.Region__c", "CustomField"),
  ]);
  store.mergeEdges([
    edge("DEFINES_FIELD", "CustomObject:Widget__c", "CustomField:Widget__c.Built_By__c"),
    edge("DEFINES_FIELD", "CustomObject:Widget__c", "CustomField:Widget__c.Maker__c"),
    edge("DEFINES_FIELD", "CustomObject:Widget__c", "CustomField:Widget__c.Either__c"),
    edge("DEFINES_FIELD", "CustomObject:Maker__c", "CustomField:Maker__c.Region__c"),
  ]);
  return store;
}

const out = (store: SqliteGraphStore, src: string, rel?: string) =>
  store
    .listEdgesFrom(orgId, asQualifiedName(src), rel as typeof REL_TYPES.READS_FIELD | undefined)
    .filter((e) => e.relType !== "DEFINES_FIELD")
    .map((e) => `${e.relType} ${String(e.dstQualifiedName)}`)
    .sort();

describe("resolveApexReferences: relationship paths", () => {
  it("resolves custom lookups via referenceTo / relationshipName and standard names", async () => {
    const store = await seed([
      { object: "Widget__c", path: "Maker__r.Region__c", rel: R },
      { object: "Widget__c", path: "Builder__r.Region__c", rel: W },
      { object: "OrderItem", path: "Product2.ObjectTypeName__c", rel: R },
      { object: "OrderItem", path: "Order.Account.Industry", rel: R },
      { object: "Case", path: "Owner.Email", rel: R },
      { object: "Case", path: "CreatedBy.Name", rel: R },
      { object: "Account", path: "Parent.Name", rel: R },
    ]);
    const res = resolveApexReferences(store, orgId, makeTestCtx());
    expect(out(store, "ApexMethod:Svc.run(0)")).toEqual([
      "READS_FIELD CustomField:Account.Industry",
      "READS_FIELD CustomField:Account.Name",
      "READS_FIELD CustomField:Maker__c.Region__c",
      "READS_FIELD CustomField:Product2.ObjectTypeName__c",
      "READS_FIELD CustomField:User.Email",
      "READS_FIELD CustomField:User.Name",
      "REFERENCES CustomObject:Account",
      "REFERENCES CustomObject:Maker__c",
      "REFERENCES CustomObject:Order",
      "REFERENCES CustomObject:Product2",
      "REFERENCES CustomObject:User",
      "WRITES_FIELD CustomField:Maker__c.Region__c",
    ]);
    expect(res.pathsResolved).toBe(7);
    expect(res.pathsUnresolved).toBe(0);
    const e = store
      .listEdgesFrom(orgId, asQualifiedName("ApexMethod:Svc.run(0)"), REL_TYPES.READS_FIELD)
      .find((x) => String(x.dstQualifiedName) === "CustomField:Maker__c.Region__c");
    expect(e?.attributes).toMatchObject({
      resolvedBy: "apex-ref-resolver",
      path: "Maker__r.Region__c",
    });
  });

  it("skips (and counts) polymorphic, unknown and non-hierarchy Parent hops", async () => {
    const store = await seed([
      { object: "Widget__c", path: "Either__r.Region__c", rel: R },
      { object: "Widget__c", path: "Nope__r.Region__c", rel: R },
      { object: "Widget__c", path: "Parent.Name", rel: R },
      { object: "Widget__c", path: "Thing.Name", rel: R },
    ]);
    const res = resolveApexReferences(store, orgId, makeTestCtx());
    expect(out(store, "ApexMethod:Svc.run(0)")).toEqual([]);
    expect(res.pathsUnresolved).toBe(4);
  });

  it("keeps an explicit parser edge with the same key, and prunes its own stale output", async () => {
    const store = await seed([{ object: "Widget__c", path: "Maker__r.Region__c", rel: R }]);
    store.mergeEdges([
      edge("READS_FIELD", "ApexMethod:Svc.run(0)", "CustomField:Maker__c.Region__c", {
        via: "member-access",
      }),
    ]);
    resolveApexReferences(store, orgId, makeTestCtx());
    const reads = store.listEdgesFrom(
      orgId,
      asQualifiedName("ApexMethod:Svc.run(0)"),
      REL_TYPES.READS_FIELD,
    );
    expect(reads.map((e) => e.attributes)).toEqual([{ via: "member-access" }]);
    expect(out(store, "ApexMethod:Svc.run(0)", "REFERENCES")).toEqual([
      "REFERENCES CustomObject:Maker__c",
    ]);
    // The path goes away: the resolver's REFERENCES is pruned, the parser edge stays.
    store.mergeNodes([
      {
        ...node("ApexMethod:Svc.run(0)", "ApexMethod", { apexRelationshipPaths: [] }),
        sourceHash: asSha256("changed"),
      },
    ]);
    const n = store.getNode(orgId, asQualifiedName("ApexMethod:Svc.run(0)"));
    expect((n?.attributes as Record<string, unknown>).apexRelationshipPaths).toEqual([]);
    resolveApexReferences(store, orgId, makeTestCtx());
    expect(out(store, "ApexMethod:Svc.run(0)")).toEqual([
      "READS_FIELD CustomField:Maker__c.Region__c",
    ]);
  });
});

describe("resolveApexReferences: a relationship as the last segment", () => {
  it("reads the relationship's known lookup field, and skips (counts) an unknown one", async () => {
    const store = await seed([
      { object: "Account", path: "Widget__r.Maker__r", rel: R },
      { object: "Contact", path: "Account.Owner", rel: R },
      { object: "Account", path: "Widget__r.Nope__r", rel: R },
      { object: "Account", path: "Parent.RecordType", rel: R },
    ]);
    store.mergeNodes([
      node("CustomField:Account.Widget__c", "CustomField", {
        referenceTo: ["Widget__c"],
        relationshipName: "Widget",
      }),
      node("CustomField:Account.OwnerId", "CustomField", { referenceTo: ["User"] }),
    ]);
    store.mergeEdges([
      edge("DEFINES_FIELD", "CustomObject:Account", "CustomField:Account.Widget__c"),
      edge("DEFINES_FIELD", "CustomObject:Account", "CustomField:Account.OwnerId"),
    ]);
    const res = resolveApexReferences(store, orgId, makeTestCtx());
    expect(out(store, "ApexMethod:Svc.run(0)")).toEqual([
      "READS_FIELD CustomField:Account.OwnerId",
      "READS_FIELD CustomField:Widget__c.Maker__c",
      "REFERENCES CustomObject:Account",
      "REFERENCES CustomObject:Widget__c",
    ]);
    expect(res.pathsResolved).toBe(2);
    expect(res.pathsUnresolved).toBe(2);
  });
});

describe("resolveApexReferences: a <Seg>Id leaf must be a lookup (T15 leafField)", () => {
  it("reads <Seg>Id only when it has referenceTo; a plain FooId is not the Foo relationship", async () => {
    const store = await seed([
      { object: "Account", path: "Foo", rel: R },
      { object: "Account", path: "Bar", rel: R },
    ]);
    store.mergeNodes([
      node("CustomField:Account.FooId", "CustomField", { type: "Text" }),
      node("CustomField:Account.BarId", "CustomField", { referenceTo: ["Bar__c"] }),
    ]);
    store.mergeEdges([
      edge("DEFINES_FIELD", "CustomObject:Account", "CustomField:Account.FooId"),
      edge("DEFINES_FIELD", "CustomObject:Account", "CustomField:Account.BarId"),
    ]);
    resolveApexReferences(store, orgId, makeTestCtx());
    expect(out(store, "ApexMethod:Svc.run(0)")).toEqual([
      "READS_FIELD CustomField:Account.BarId",
      "READS_FIELD CustomField:Account.Foo",
    ]);
  });
});

describe("resolveApexReferences: lowercase test targets", () => {
  it("links candidates case-insensitively to existing ApexClass nodes only", async () => {
    const store = await seed(
      [],
      ["showProductController", "missingThing", "fooApi", "showProductTest"],
    );
    const res = resolveApexReferences(store, orgId, makeTestCtx());
    expect(out(store, "ApexClass:showProductTest")).toEqual([
      "IS_TEST_FOR ApexClass:ShowProductController",
    ]);
    expect(res.testTargetsResolved).toBe(1);
    expect(res.testTargetsUnresolved).toBe(3);
  });
});
