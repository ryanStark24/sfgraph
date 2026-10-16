import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { REL_TYPES } from "../../../domain/index.js";
import { SqliteGraphStore } from "../../../storage/sqlite/graph-store.js";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { resolveVlocityApex } from "../apex-resolver.js";
import { remoteMethodsOf } from "../common.js";
import { scanDataPackRefs } from "../datapack-refs.js";
import { OmniScriptParser } from "../omni-script.js";

/**
 * Audit corecorr-03: collectRefEdges dedups remote refs by (rel,dst) with
 * first-wins attrs, so only the first remoteMethod per class survives and
 * the apex resolver links just that one method.
 */
describe("audit corecorr-03: every remoteMethod on a class gets a method edge", () => {
  it("links both Svc.go and Svc.run when one OmniScript calls both", async () => {
    const ctx = makeTestCtx();
    const orgId = asOrgId(ctx.orgId);
    const dp = {
      elements: [
        { Type: "Remote Action", propertySet: { remoteClass: "Svc", remoteMethod: "go" } },
        { Type: "Remote Action", propertySet: { remoteClass: "Svc", remoteMethod: "run" } },
      ],
    };
    const parsed = await new OmniScriptParser().parse(
      { name: "T_S_English", datapack: dp } as never,
      ctx,
    );
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    store.upsertOrg({
      id: orgId,
      alias: "t",
      instanceUrl: "https://example.test",
      apiVersion: "59.0",
      createdAt: 1,
    });
    const ts = Date.now();
    const node = (qn: string, label: string) => ({
      orgId,
      qualifiedName: asQualifiedName(qn),
      label,
      attributes: {},
      sourceHash: asSha256(qn),
      firstSeenAt: ts,
      lastSeenAt: ts,
      lastModifiedAt: ts,
    });
    store.mergeNodes([
      ...parsed.nodes,
      node("ApexClass:Svc", "ApexClass"),
      node("ApexMethod:Svc.go(0)", "ApexMethod"),
      node("ApexMethod:Svc.run(0)", "ApexMethod"),
    ]);
    store.mergeEdges(parsed.edges);
    resolveVlocityApex(store, orgId, ctx);
    const src = parsed.nodes[0]?.qualifiedName;
    expect(src).toBeDefined();
    const methods = store
      .listEdgesFrom(orgId, src as never, REL_TYPES.VLOCITY_INVOKES_APEX_METHOD)
      .map((e) => String(e.dstQualifiedName))
      .sort();
    expect(methods).toEqual(["ApexMethod:Svc.go(0)", "ApexMethod:Svc.run(0)"]);
  });

  it("review M-1: class spellings differing only in case merge into one method list", async () => {
    const dp = {
      elements: [
        {
          Type: "Remote Action",
          propertySet: { remoteClass: "CPQAppHandler", remoteMethod: "getCart" },
        },
        {
          Type: "Remote Action",
          propertySet: { remoteClass: "CpqAppHandler", remoteMethod: "putCart" },
        },
      ],
    };
    const parsed = await new OmniScriptParser().parse(
      { name: "T_S_English", datapack: dp } as never,
      makeTestCtx(),
    );
    const remote = parsed.edges.filter((e) =>
      String(e.dstQualifiedName).toLowerCase().endsWith(":cpqapphandler"),
    );
    expect(remote).toHaveLength(1);
    expect(remoteMethodsOf(remote[0]?.attributes ?? {}).sort()).toEqual(["getCart", "putCart"]);

    const refs = scanDataPackRefs({
      a: {
        dataSource: {
          type: "Custom",
          value: { remoteClass: "CPQAppHandler", remoteMethod: "getCart" },
        },
      },
      b: {
        dataSource: {
          type: "Custom",
          value: { remoteClass: "CpqAppHandler", remoteMethod: "putCart" },
        },
      },
    });
    const ds = refs.filter((r) => r.dst.toLowerCase().endsWith(":cpqapphandler"));
    expect(ds).toHaveLength(1);
    expect(remoteMethodsOf(ds[0]?.attrs ?? {}).sort()).toEqual(["getCart", "putCart"]);
  });
});
