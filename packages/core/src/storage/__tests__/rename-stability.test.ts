import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { REL_TYPES } from "../../domain/index.js";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../sqlite/graph-store.js";
import {
  lookupServiceId,
  recordServiceId,
  resetServiceIdMap,
  rewriteEdgesForRename,
} from "../sqlite/rename-stability.js";

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

function edge(src: string, rel: string, dst: string): EdgeFact {
  const ts = Date.now();
  return {
    orgId: ORG,
    srcQualifiedName: asQualifiedName(src),
    dstQualifiedName: asQualifiedName(dst),
    relType: rel as EdgeFact["relType"],
    attributes: {},
    firstSeenAt: ts,
    lastSeenAt: ts,
  };
}

function db(store: SqliteGraphStore) {
  return (store as unknown as { db: Parameters<typeof recordServiceId>[0] }).db;
}

describe("W3-05: service-id ↔ qname map", () => {
  it("first record() returns detected:false, recorded:true", async () => {
    const store = await setupStore();
    const result = recordServiceId(
      db(store),
      ORG,
      "01p000000001",
      "ApexClass:Foo",
      "ApexClass",
    );
    expect(result).toEqual({ detected: false, recorded: true });
    const lookup = lookupServiceId(db(store), ORG, "01p000000001");
    expect(lookup?.qualifiedName).toBe("ApexClass:Foo");
    await store.close();
  });

  it("same record() twice returns detected:false, recorded:false (just refreshes lastSeenAt)", async () => {
    const store = await setupStore();
    recordServiceId(db(store), ORG, "01p000000001", "ApexClass:Foo", "ApexClass");
    const result = recordServiceId(
      db(store),
      ORG,
      "01p000000001",
      "ApexClass:Foo",
      "ApexClass",
    );
    expect(result).toEqual({ detected: false, recorded: false });
    await store.close();
  });

  it("detects rename when same serviceId maps to a different qname", async () => {
    const store = await setupStore();
    recordServiceId(db(store), ORG, "01p000000001", "ApexClass:OldName", "ApexClass");
    const result = recordServiceId(
      db(store),
      ORG,
      "01p000000001",
      "ApexClass:NewName",
      "ApexClass",
    );
    expect(result).toEqual({
      detected: true,
      previousQname: "ApexClass:OldName",
      currentQname: "ApexClass:NewName",
    });
    // Lookup reflects the new qname
    expect(lookupServiceId(db(store), ORG, "01p000000001")?.qualifiedName).toBe(
      "ApexClass:NewName",
    );
    await store.close();
  });

  it("rewriteEdgesForRename migrates incoming + outgoing edges to the new qname", async () => {
    const store = await setupStore();
    store.mergeNodes([
      node("ApexClass", "ApexClass:OldName"),
      node("ApexClass", "ApexClass:Caller"),
      node("ApexClass", "ApexClass:Target"),
    ]);
    store.mergeEdges([
      edge("ApexClass:Caller", REL_TYPES.CALLS, "ApexClass:OldName"),
      edge("ApexClass:OldName", REL_TYPES.CALLS, "ApexClass:Target"),
    ]);

    const result = rewriteEdgesForRename(db(store), ORG, "ApexClass:OldName", "ApexClass:NewName");
    expect(result.srcRewritten).toBe(1);
    expect(result.dstRewritten).toBe(1);

    // Edges now point at the new qname
    const outgoing = store.listEdgesFrom(ORG, asQualifiedName("ApexClass:NewName"));
    expect(outgoing.find((e) => String(e.dstQualifiedName) === "ApexClass:Target")).toBeDefined();
    const incoming = store.listEdgesTo(ORG, asQualifiedName("ApexClass:NewName"));
    expect(incoming.find((e) => String(e.srcQualifiedName) === "ApexClass:Caller")).toBeDefined();
    // No edges reference the old qname anymore
    expect(store.listEdgesFrom(ORG, asQualifiedName("ApexClass:OldName"))).toEqual([]);
    expect(store.listEdgesTo(ORG, asQualifiedName("ApexClass:OldName"))).toEqual([]);
    await store.close();
  });

  it("rewriteEdgesForRename is idempotent on a no-op call", async () => {
    const store = await setupStore();
    store.mergeNodes([node("ApexClass", "ApexClass:Foo")]);
    // No edges touch OldName at all
    const result = rewriteEdgesForRename(db(store), ORG, "ApexClass:OldName", "ApexClass:NewName");
    expect(result.srcRewritten).toBe(0);
    expect(result.dstRewritten).toBe(0);
    await store.close();
  });

  it("resetServiceIdMap clears every entry for the given org only", async () => {
    const store = await setupStore();
    recordServiceId(db(store), ORG, "01p000000001", "ApexClass:Foo", "ApexClass");
    recordServiceId(db(store), ORG, "01p000000002", "ApexClass:Bar", "ApexClass");
    const result = resetServiceIdMap(db(store), ORG);
    expect(result.cleared).toBe(2);
    expect(lookupServiceId(db(store), ORG, "01p000000001")).toBeNull();
    await store.close();
  });

  it("composite PK (org_id, service_id) means two orgs can share serviceIds without collision", async () => {
    const store = await setupStore();
    const otherOrg = asOrgId("org_other");
    store.upsertOrg({
      id: otherOrg,
      alias: "other",
      instanceUrl: "https://other.test",
      apiVersion: "59.0",
      createdAt: Date.now(),
    });
    recordServiceId(db(store), ORG, "01p000000001", "ApexClass:Foo", "ApexClass");
    recordServiceId(db(store), otherOrg, "01p000000001", "ApexClass:Bar", "ApexClass");
    expect(lookupServiceId(db(store), ORG, "01p000000001")?.qualifiedName).toBe("ApexClass:Foo");
    expect(lookupServiceId(db(store), otherOrg, "01p000000001")?.qualifiedName).toBe(
      "ApexClass:Bar",
    );
    await store.close();
  });
});
