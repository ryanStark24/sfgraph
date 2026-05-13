import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { beforeEach, describe, expect, it } from "vitest";
import type { NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { generateManifest } from "../deployment-manifest/generate.js";
import { formatMemberName } from "../deployment-manifest/member-name-formatters.js";

const A = asOrgId("orgA");
const B = asOrgId("orgB");

function n(orgId: ReturnType<typeof asOrgId>, label: string, qname: string, hash = "h"): NodeFact {
  return {
    orgId,
    label,
    qualifiedName: asQualifiedName(qname),
    attributes: { sourceUri: "x" },
    sourceHash: asSha256(hash),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
}

let store: SqliteGraphStore;

beforeEach(async () => {
  store = new SqliteGraphStore({ dbPath: ":memory:" });
  await store.init();
  store.upsertOrg({ id: A, alias: "a", instanceUrl: "u", apiVersion: "60.0", createdAt: 1 });
  store.upsertOrg({ id: B, alias: "b", instanceUrl: "u", apiVersion: "60.0", createdAt: 1 });
});

describe("deployment manifest", () => {
  it("emits well-formed package.xml with sorted types and members", () => {
    store.mergeNodes([
      n(A, "ApexClass", "ApexClass:NewFoo"),
      n(A, "ApexClass", "ApexClass:Bar", "h2"),
      n(B, "ApexClass", "ApexClass:Bar", "h1"), // changed
    ]);
    const m = generateManifest(store, A, B);
    expect(m.packageXml).toContain("<name>ApexClass</name>");
    expect(m.packageXml).toContain("<members>NewFoo</members>");
    expect(m.packageXml).toContain("<members>Bar</members>");
    expect(m.packageXml).toContain("<version>60.0</version>");
  });

  it("emits destructiveChanges.xml for nodes only in target", () => {
    store.mergeNodes([n(B, "ApexClass", "ApexClass:DeletedOne")]);
    const m = generateManifest(store, A, B);
    expect(m.destructiveXml).toContain("<members>DeletedOne</members>");
  });

  it("member-name formatters strip label prefixes", () => {
    expect(formatMemberName("ApexClass", "ApexClass:Foo")).toBe("Foo");
    expect(formatMemberName("CustomField", "CustomField:Account.Foo__c")).toBe("Account.Foo__c");
    expect(formatMemberName("SharingRule", "SharingRule:Account.Rule1")).toBe("Account");
  });

  it("api version falls back to 59.0 when org missing apiVersion", async () => {
    const s2 = new SqliteGraphStore({ dbPath: ":memory:" });
    await s2.init();
    // Don't create org A; from generate path
    const m = generateManifest(s2, asOrgId("noSuchOrg"), asOrgId("noSuchOrg2"));
    expect(m.packageXml).toContain("<version>59.0</version>");
    await s2.close();
  });

  it("returns empty content blocks for empty diff", () => {
    const m = generateManifest(store, A, B);
    expect(m.summary.addedOrChanged).toBe(0);
    expect(m.summary.removed).toBe(0);
    expect(m.packageXml).toContain("<Package");
    expect(m.destructiveXml).toContain("<Package");
  });
});
