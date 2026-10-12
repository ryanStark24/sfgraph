import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { REL_TYPES } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { OmniProcessParser } from "../omnistudio/process.js";
import { resolveVlocityApex } from "../vlocity/apex-resolver.js";
import { makeTestCtx } from "./_harness.js";

/**
 * Audit corecorr-12: the native OmniStudio (OmniProcess) parser ignores
 * remoteClass/remoteMethod and always emits OMNI_INVOKES_REMOTE -> Remote:unknown,
 * so Apex is never linked from OmniProcess-based scripts.
 */
describe("audit corecorr-12: OmniProcess remote actions name their Apex class", () => {
  it("emits OMNI_INVOKES_REMOTE -> Remote:Foo carrying remoteMethod=bar", async () => {
    const result = await new OmniProcessParser().parse(
      {
        name: "T_S_English",
        metadata: {
          elements: [
            { Type: "Remote Action", propertySet: { remoteClass: "Foo", remoteMethod: "bar" } },
          ],
        },
      },
      makeTestCtx(),
    );
    const remotes = result.edges.filter((e) => e.relType === "OMNI_INVOKES_REMOTE");
    expect(remotes.map((e) => String(e.dstQualifiedName))).toEqual(["Remote:Foo"]);
    expect(remotes[0]?.attributes).toMatchObject({ remoteClass: "Foo", remoteMethod: "bar" });
  });

  it("lets the vlocity-apex resolver bind the OmniProcess remote to the Apex method", async () => {
    const ctx = makeTestCtx();
    const orgId = asOrgId(ctx.orgId);
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    store.upsertOrg({
      id: orgId,
      alias: "t",
      instanceUrl: "https://example.test",
      apiVersion: "59.0",
      createdAt: Date.now(),
    });
    const parsed = await new OmniProcessParser().parse(
      {
        name: "T_S_English",
        metadata: {
          elements: [
            { Type: "Remote Action", propertySet: { remoteClass: "Foo", remoteMethod: "bar" } },
          ],
        },
      },
      ctx,
    );
    const ts = Date.now();
    store.mergeNodes([
      ...parsed.nodes,
      ...["ApexClass:Foo", "ApexMethod:Foo.bar(2)"].map((qn) => ({
        orgId,
        qualifiedName: asQualifiedName(qn),
        label: qn.split(":")[0] as string,
        attributes: {},
        sourceHash: asSha256(qn),
        firstSeenAt: ts,
        lastSeenAt: ts,
        lastModifiedAt: ts,
      })),
    ]);
    store.mergeEdges(parsed.edges);
    resolveVlocityApex(store, orgId, ctx);
    const src = parsed.edges.find((e) => e.relType === "OMNI_INVOKES_REMOTE")?.srcQualifiedName;
    expect(src).toBeDefined();
    const m = store.listEdgesFrom(orgId, src as never, REL_TYPES.VLOCITY_INVOKES_APEX_METHOD);
    expect(m.map((e) => String(e.dstQualifiedName))).toEqual(["ApexMethod:Foo.bar(2)"]);
  });
});
