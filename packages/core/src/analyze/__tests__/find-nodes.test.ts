import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import type { NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { findNodesByGlob } from "../find-nodes.js";

const ORG = asOrgId("org_test");

async function setupStore() {
  const store = new SqliteGraphStore({ dbPath: ":memory:" });
  await store.init();
  store.upsertOrg({
    id: ORG,
    alias: "test",
    instanceUrl: "https://example.test",
    apiVersion: "59.0",
    createdAt: Date.now(),
  });
  return store;
}

function node(label: string, qname: string): NodeFact {
  const ts = Date.now();
  return {
    orgId: ORG,
    qualifiedName: asQualifiedName(qname),
    label,
    attributes: {},
    sourceHash: asSha256(qname),
    firstSeenAt: ts,
    lastSeenAt: ts,
    lastModifiedAt: ts,
  };
}

describe("W3-04: findNodesByGlob", () => {
  it("matches every Apex class with a label-anchored pattern", async () => {
    const store = await setupStore();
    store.mergeNodes([
      node("ApexClass", "ApexClass:AccountController"),
      node("ApexClass", "ApexClass:ContactController"),
      node("ApexClass", "ApexClass:UtilityClass"),
      node("CustomField", "CustomField:Account.Name"),
    ]);
    const result = findNodesByGlob(store, ORG, "ApexClass:*");
    expect(result.matches.map((n) => String(n.qualifiedName)).sort()).toEqual([
      "ApexClass:AccountController",
      "ApexClass:ContactController",
      "ApexClass:UtilityClass",
    ]);
    expect(result.truncated).toBe(false);
    expect(result.total).toBe(3);
    await store.close();
  });

  it("treats `.` as the segment separator: `CustomField:Account.*` matches all Account fields", async () => {
    const store = await setupStore();
    store.mergeNodes([
      node("CustomField", "CustomField:Account.Name"),
      node("CustomField", "CustomField:Account.Phone"),
      node("CustomField", "CustomField:Contact.Email"),
    ]);
    const result = findNodesByGlob(store, ORG, "CustomField:Account.*");
    expect(result.matches.map((n) => String(n.qualifiedName)).sort()).toEqual([
      "CustomField:Account.Name",
      "CustomField:Account.Phone",
    ]);
    await store.close();
  });

  it("supports brace expansion: `Flow:{Lead,Account}_*`", async () => {
    const store = await setupStore();
    store.mergeNodes([
      node("Flow", "Flow:Lead_Convert"),
      node("Flow", "Flow:Lead_Score"),
      node("Flow", "Flow:Account_Sync"),
      node("Flow", "Flow:Opportunity_Close"),
    ]);
    const result = findNodesByGlob(store, ORG, "Flow:{Lead,Account}_*");
    expect(result.matches.map((n) => String(n.qualifiedName)).sort()).toEqual([
      "Flow:Account_Sync",
      "Flow:Lead_Convert",
      "Flow:Lead_Score",
    ]);
    await store.close();
  });

  it("returns truncated=true and caps results when matches exceed limit", async () => {
    const store = await setupStore();
    const nodes: NodeFact[] = [];
    for (let i = 0; i < 600; i += 1) {
      nodes.push(node("ApexClass", `ApexClass:Class${String(i).padStart(4, "0")}`));
    }
    store.mergeNodes(nodes);
    const result = findNodesByGlob(store, ORG, "ApexClass:*", { limit: 500 });
    expect(result.matches.length).toBe(500);
    expect(result.total).toBe(600);
    expect(result.truncated).toBe(true);
    await store.close();
  });

  it("explicit label option short-circuits cross-label scan", async () => {
    const store = await setupStore();
    store.mergeNodes([
      node("ApexClass", "ApexClass:Foo"),
      node("CustomField", "CustomField:Account.Foo"),
    ]);
    const labelResult = findNodesByGlob(store, ORG, "*:Foo*", { label: "ApexClass" });
    expect(labelResult.matches.length).toBe(1);
    expect(String(labelResult.matches[0]?.qualifiedName)).toBe("ApexClass:Foo");
    await store.close();
  });

  it("returns empty result with truncated=false when no matches", async () => {
    const store = await setupStore();
    store.mergeNodes([node("ApexClass", "ApexClass:Foo")]);
    const result = findNodesByGlob(store, ORG, "Flow:*");
    expect(result.matches).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.truncated).toBe(false);
    await store.close();
  });

  it("returns matches sorted lexicographically by qualifiedName", async () => {
    const store = await setupStore();
    store.mergeNodes([
      node("ApexClass", "ApexClass:Zeta"),
      node("ApexClass", "ApexClass:Alpha"),
      node("ApexClass", "ApexClass:Beta"),
    ]);
    const result = findNodesByGlob(store, ORG, "ApexClass:*");
    expect(result.matches.map((n) => String(n.qualifiedName))).toEqual([
      "ApexClass:Alpha",
      "ApexClass:Beta",
      "ApexClass:Zeta",
    ]);
    await store.close();
  });
});
