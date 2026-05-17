import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import type { NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { walkBlobsForReferences } from "../generic/reflection-walker.js";
import { makeTestCtx } from "./_harness.js";

const ORG = asOrgId("org_reflection");

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

describe("W6-01: reflection-based generic walker", () => {
  it("emits a REFERENCES edge when a nested blob string matches an existing qname's bare name", async () => {
    const store = await setupStore();
    store.mergeNodes([
      node("OmniProcess", "OmniProcess:GetAccount", {
        propertySet: {
          dataRaptorBundleName: "AccountDR",
          someUnrelatedField: "hello world",
        },
      }),
      node("DataRaptor", "DataRaptor:AccountDR"),
    ]);

    const result = walkBlobsForReferences(store, { orgId: ORG, ctx: makeTestCtx() });
    expect(result.scanned).toBeGreaterThan(0);
    expect(result.edgesEmitted).toBe(1);

    const edge = store
      .listEdgesFrom(ORG, asQualifiedName("OmniProcess:GetAccount"), "REFERENCES" as never)
      .find((e) => String(e.dstQualifiedName) === "DataRaptor:AccountDR");
    expect(edge).toBeDefined();
    expect(edge?.attributes.source).toBe("reflection");
    expect(edge?.attributes.confidence).toBe("pattern-match");
    expect(edge?.attributes.viaKey).toBe("dataRaptorBundleName");
    await store.close();
  });

  it("flags ambiguous matches when one bare name matches multiple labels", async () => {
    const store = await setupStore();
    store.mergeNodes([
      node("OmniProcess", "OmniProcess:Driver", { config: { name: "SharedName" } }),
      node("ApexClass", "ApexClass:SharedName"),
      node("Flow", "Flow:SharedName"),
    ]);
    const result = walkBlobsForReferences(store, { orgId: ORG, ctx: makeTestCtx() });
    const edges = store
      .listEdgesFrom(ORG, asQualifiedName("OmniProcess:Driver"), "REFERENCES" as never)
      .filter((e) => e.attributes.ambiguous === true);
    expect(edges.length).toBe(2);
    expect(edges.every((e) => e.attributes.source === "reflection")).toBe(true);
    expect(result.ambiguousMatches).toBeGreaterThan(0);
    await store.close();
  });

  it("skips self-references when a node's blob contains its own bare name", async () => {
    const store = await setupStore();
    store.mergeNodes([
      node("OmniProcess", "OmniProcess:GetAccount", {
        propertySet: { name: "GetAccount" },
      }),
    ]);
    const result = walkBlobsForReferences(store, { orgId: ORG, ctx: makeTestCtx() });
    expect(result.edgesEmitted).toBe(0);
    await store.close();
  });

  it("ignores reserved words even when an identically-named node exists", async () => {
    const store = await setupStore();
    store.mergeNodes([
      node("OmniProcess", "OmniProcess:Driver", {
        config: { someFlag: "true", anotherFlag: "string" },
      }),
      // Pathological nodes whose bare names collide with reserved words.
      node("CustomField", "CustomField:Object.true"),
      node("ApexClass", "ApexClass:string"),
    ]);
    const result = walkBlobsForReferences(store, { orgId: ORG, ctx: makeTestCtx() });
    expect(result.edgesEmitted).toBe(0);
    await store.close();
  });

  it("ignores strings shorter than minStringLength (default 4)", async () => {
    const store = await setupStore();
    store.mergeNodes([
      node("OmniProcess", "OmniProcess:Driver", { config: { id: "Foo" } }),
      node("ApexClass", "ApexClass:Foo"),
    ]);
    const result = walkBlobsForReferences(store, { orgId: ORG, ctx: makeTestCtx() });
    expect(result.edgesEmitted).toBe(0); // "Foo" is length 3
    await store.close();
  });

  it("respects maxEdgesPerSource cap and increments truncatedSources", async () => {
    const store = await setupStore();
    // Source node whose blob references 5 distinct existing dsts.
    const blob: Record<string, string> = {};
    for (let i = 0; i < 5; i += 1) blob[`ref${i}`] = `Target${i}_Class`;
    store.mergeNodes([
      node("OmniProcess", "OmniProcess:Driver", { config: blob }),
      ...[0, 1, 2, 3, 4].map((i) => node("ApexClass", `ApexClass:Target${i}_Class`)),
    ]);
    const result = walkBlobsForReferences(store, {
      orgId: ORG,
      ctx: makeTestCtx(),
      maxEdgesPerSource: 2,
    });
    expect(result.edgesEmitted).toBe(2);
    expect(result.truncatedSources).toBe(1);
    await store.close();
  });

  it("scopeToLabels restricts the source-and-index node set", async () => {
    const store = await setupStore();
    store.mergeNodes([
      node("OmniProcess", "OmniProcess:Driver", { config: { foo: "AccountDR" } }),
      node("DataRaptor", "DataRaptor:AccountDR"),
      // ApexClass should be IGNORED entirely when scopeToLabels excludes it.
      node("ApexClass", "ApexClass:AccountDR_Class", { body: { ref: "AccountDR" } }),
    ]);
    const result = walkBlobsForReferences(store, {
      orgId: ORG,
      ctx: makeTestCtx(),
      scopeToLabels: ["OmniProcess", "DataRaptor"],
    });
    // OmniProcess:Driver → DataRaptor:AccountDR is in-scope and emits.
    // ApexClass:AccountDR_Class is out-of-scope (not scanned as source AND
    // not in the bare-name index), so no edge from it.
    expect(result.edgesEmitted).toBe(1);
    await store.close();
  });

  it("skips multi-word / sentence strings (Salesforce identifiers don't contain whitespace)", async () => {
    const store = await setupStore();
    store.mergeNodes([
      node("OmniProcess", "OmniProcess:Driver", {
        propertySet: {
          description: "AccountDR is the helper that does the thing",
        },
      }),
      node("DataRaptor", "DataRaptor:AccountDR"),
    ]);
    const result = walkBlobsForReferences(store, { orgId: ORG, ctx: makeTestCtx() });
    // The string contains whitespace, so the whole value is rejected — we
    // do NOT tokenise and match per-word, by design.
    expect(result.edgesEmitted).toBe(0);
    await store.close();
  });
});
