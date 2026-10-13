import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import type { NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { walkBlobsForReferences } from "../generic/reflection-walker.js";
import { makeTestCtx } from "./_harness.js";

/**
 * Audit corecorr-10: the reflection walker's `explicit` Set is keyed on the
 * exact-case dst, so an explicit edge whose dst differs only in case from the
 * node qname is not recognised and gets overwritten with source:reflection.
 */
const ORG = asOrgId("org_test");

function node(label: string, qname: string, attributes: Record<string, unknown> = {}): NodeFact {
  const ts = Date.now();
  return {
    orgId: ORG,
    qualifiedName: asQualifiedName(qname),
    label,
    attributes,
    sourceHash: asSha256(qname),
    firstSeenAt: ts,
    lastSeenAt: ts,
    lastModifiedAt: ts,
  };
}

describe("audit corecorr-10: explicit edges survive the reflection walk regardless of case", () => {
  it("keeps the explicit attrs when the explicit dst differs in case from the node", async () => {
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    store.upsertOrg({
      id: ORG,
      alias: "test",
      instanceUrl: "https://example.test",
      apiVersion: "59.0",
      createdAt: Date.now(),
    });
    store.mergeNodes([
      node("VlocityAction", "VlocityAction:VA", { target: "quoteServ" }),
      node("LWC", "LWC:quoteServ"),
    ]);
    const ts = Date.now();
    store.mergeEdges([
      {
        orgId: ORG,
        srcQualifiedName: asQualifiedName("VlocityAction:VA"),
        dstQualifiedName: asQualifiedName("LWC:QuoteServ"),
        relType: "REFERENCES" as never,
        attributes: { via: "URL" },
        firstSeenAt: ts,
        lastSeenAt: ts,
      },
    ]);
    walkBlobsForReferences(store, { orgId: ORG, ctx: makeTestCtx() });
    const refs = store.listEdgesFrom(
      ORG,
      asQualifiedName("VlocityAction:VA"),
      "REFERENCES" as never,
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]?.attributes.via).toBe("URL");
    expect(refs[0]?.attributes.source).toBeUndefined();
    await store.close();
  });
});
