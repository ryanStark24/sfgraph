import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { normalizeKey, resolveCrossFlavor } from "../cross-flavor-resolver.js";
import { makeTestCtx } from "./_harness.js";

describe("cross-flavor resolver", () => {
  it("emits CANONICAL_OF edges and merges flavors[] for matching pairs", async () => {
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();

    const orgId = asOrgId("org_test");
    store.upsertOrg({
      id: orgId,
      alias: "test",
      instanceUrl: "https://example.test",
      apiVersion: "59.0",
      createdAt: Date.now(),
    });

    const ts = Date.now();
    store.mergeNodes([
      {
        orgId,
        qualifiedName: asQualifiedName("DataRaptor:GetAccount"),
        label: "DataRaptor",
        attributes: { name: "GetAccount", flavor: "DR" },
        sourceHash: asSha256("a"),
        firstSeenAt: ts,
        lastSeenAt: ts,
        lastModifiedAt: ts,
      },
      {
        orgId,
        qualifiedName: asQualifiedName("OmniDataTransform:GetAccount"),
        label: "OmniDataTransform",
        attributes: { name: "GetAccount", flavor: "OMNI" },
        sourceHash: asSha256("b"),
        firstSeenAt: ts,
        lastSeenAt: ts,
        lastModifiedAt: ts,
      },
    ]);

    const ctx = makeTestCtx();
    const count = resolveCrossFlavor(store, { orgId, ctx, namespace: null });
    expect(count).toBe(2);

    const edges = store.listEdgesFrom(orgId, asQualifiedName("DataRaptor:GetAccount"));
    expect(
      edges.some(
        (e) =>
          e.relType === "CANONICAL_OF" && e.dstQualifiedName === "OmniDataTransform:GetAccount",
      ),
    ).toBe(true);

    const drNode = store.getNode(orgId, asQualifiedName("DataRaptor:GetAccount"));
    expect(drNode?.attributes.flavors).toEqual(["DataRaptor", "OmniDataTransform"]);

    await store.close();
  });

  it("normalizeKey strips label, namespace and flavor prefixes", () => {
    expect(normalizeKey("DataRaptor:DR_GetAccount", "ns")).toBe("getaccount");
    expect(normalizeKey("OmniDataTransform:ns__GetAccount", "ns")).toBe("getaccount");
    expect(normalizeKey("VlocityCard:OS_OrderCard")).toBe("ordercard");
  });
});
