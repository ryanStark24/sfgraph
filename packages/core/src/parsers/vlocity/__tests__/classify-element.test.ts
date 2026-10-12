import { describe, expect, it } from "vitest";
import { classifyElement } from "../common.js";

describe("classifyElement", () => {
  it("remote action keeps class + method", () => {
    expect(
      classifyElement({
        Type: "Remote Action",
        propertySet: { remoteClass: "Svc", remoteMethod: "go" },
      }),
    ).toEqual([
      { kind: "remote", target: "Svc", attrs: { remoteClass: "Svc", remoteMethod: "go" } },
    ]);
  });
  it("whitespace-variant IP type", () => {
    expect(
      classifyElement({
        Type: "Integration Procedure Action",
        propertySet: { integrationProcedureKey: "Shop_Checkout" },
      })[0],
    ).toMatchObject({ kind: "ip", target: "Shop_Checkout" });
  });
  it("embedded OmniScript and LWC", () => {
    expect(
      classifyElement({
        Type: "OmniScript",
        propertySet: { Type: "Change", "Sub Type": "Bulk", Language: "English" },
      })[0],
    ).toMatchObject({ kind: "omniscript", target: "Change_Bulk_English" });
    expect(
      classifyElement({
        Type: "Custom Lightning Web Component",
        propertySet: { lwcName: "myCmp" },
      })[0],
    ).toMatchObject({ kind: "lwc", target: "myCmp" });
  });
  it("transform bundles inside remoteOptions add DR refs with role", () => {
    const refs = classifyElement({
      Type: "Remote Action",
      propertySet: {
        remoteClass: "Svc",
        remoteMethod: "m",
        remoteOptions: { preTransformBundle: "DR_Pre", postTransformBundle: "" },
      },
    });
    expect(refs).toContainEqual({
      kind: "dataraptor",
      target: "DR_Pre",
      attrs: { role: "preTransform" },
    });
    expect(refs.filter((r) => r.kind === "dataraptor")).toHaveLength(1);
  });
  it("rest action named credential; empty named credential falls back to endpoint", () => {
    expect(
      classifyElement({
        Type: "Rest Action",
        propertySet: { namedCredential: "NC1", restMethod: "POST" },
      })[0],
    ).toEqual({ kind: "rest", target: "NC1", attrs: { restMethod: "POST" } });
    expect(
      classifyElement({
        Type: "Rest Action",
        propertySet: { namedCredential: "", restPath: "/x" },
      })[0],
    ).toMatchObject({ kind: "remote", target: "/x" });
  });
  it("no Type, raw propertySet, nested remoteOptions object -> nothing", () => {
    expect(classifyElement({ remoteOptions: {} })).toEqual([]);
    expect(classifyElement({ Type: "Remote Action", propertySet: { _raw: "{bad" } })).toEqual([]);
  });

  it("any element type with a remoteClass produces a remote ref (once)", () => {
    expect(
      classifyElement({
        Type: "Try Catch Block",
        propertySet: { remoteClass: "Svc", remoteMethod: "fail" },
      }),
    ).toEqual([
      { kind: "remote", target: "Svc", attrs: { remoteClass: "Svc", remoteMethod: "fail" } },
    ]);
    expect(
      classifyElement({
        Type: "Remote Action",
        propertySet: { remoteClass: "Svc", remoteMethod: "go" },
      }),
    ).toHaveLength(1);
  });
  it("emits remoteClass on explicitly inactive elements, tagged inactive=true", () => {
    for (const flag of [{ IsActive: false }, { Active: "false" }, { isActive: false }]) {
      expect(
        classifyElement({
          Type: "Log Catch Block",
          ...flag,
          propertySet: { remoteClass: "Svc", remoteMethod: "x" },
        }),
      ).toEqual([
        {
          kind: "remote",
          target: "Svc",
          attrs: { remoteClass: "Svc", remoteMethod: "x", inactive: true },
        },
      ]);
    }
  });
  it("tags every ref of an inactive typed element and never tags active ones", () => {
    const refs = classifyElement({
      Type: "Integration Procedure Action",
      Active: false,
      propertySet: { integrationProcedureKey: "IP_X", preTransformBundle: "DR_Pre" },
    });
    expect(refs).toHaveLength(2);
    for (const r of refs) expect(r.attrs.inactive).toBe(true);
    const active = classifyElement({
      Type: "Integration Procedure Action",
      Active: true,
      propertySet: { integrationProcedureKey: "IP_X" },
    });
    expect(active[0]?.attrs.inactive).toBeUndefined();
  });
});

describe("OS/IP/Card parsers: per-(rel,dst) dedupe and inactive AND rule, via the store", () => {
  const mk = (active: boolean | undefined, cls = "Svc") => ({
    Type: "Remote Action",
    ...(active === undefined ? {} : { Active: active }),
    propertySet: { remoteClass: cls, remoteMethod: "go" },
  });
  async function stored(dp: unknown, order = false) {
    const { OmniScriptParser } = await import("../omni-script.js");
    const { SqliteGraphStore } = await import("../../../storage/sqlite/graph-store.js");
    const { makeTestCtx } = await import("../../__tests__/_harness.js");
    const ctx = makeTestCtx();
    const r = await new OmniScriptParser().parse({ name: "T_S_English", datapack: dp } as any, ctx);
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    store.upsertOrg({
      id: ctx.orgId as any,
      alias: "t",
      instanceUrl: "https://example.test",
      apiVersion: "59.0",
      createdAt: 1,
    });
    store.mergeNodes(r.nodes);
    store.mergeEdges(r.edges);
    return store.listEdgesFrom(ctx.orgId as any, r.nodes[0]!.qualifiedName as any);
  }
  it("inactive element alone: stored edge has inactive=true", async () => {
    const e = await stored({ elements: [mk(false)] });
    expect(e).toHaveLength(1);
    expect(e[0]?.attributes.inactive).toBe(true);
  });
  it("any active contributor makes the edge active, in either order", async () => {
    for (const els of [
      [mk(false), mk(true)],
      [mk(true), mk(false)],
      [mk(false), mk(undefined)],
    ]) {
      const e = await stored({ elements: els });
      expect(e).toHaveLength(1);
      expect(e[0]?.attributes.inactive).toBeUndefined();
    }
  });
  it("refs nested under an inactive ancestor are tagged inactive", async () => {
    const e = await stored({
      elements: [{ Type: "Block", Active: false, children: [mk(undefined, "Nested")] }],
    });
    expect(e).toHaveLength(1);
    expect(e[0]?.attributes.inactive).toBe(true);
  });
});
