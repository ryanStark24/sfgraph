import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { REL_TYPES } from "../../../domain/index.js";
import { SqliteGraphStore } from "../../../storage/sqlite/graph-store.js";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { resolveVlocityApex } from "../apex-resolver.js";

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

function edge(
  src: string,
  rel: keyof typeof REL_TYPES,
  dst: string,
  attrs: Record<string, unknown>,
) {
  const ts = Date.now();
  return {
    orgId,
    srcQualifiedName: asQualifiedName(src),
    dstQualifiedName: asQualifiedName(dst),
    relType: REL_TYPES[rel],
    attributes: attrs,
    firstSeenAt: ts,
    lastSeenAt: ts,
  };
}

async function seed() {
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
    node("ApexClass:Svc", "ApexClass", { vlocityDispatch: { go: "doGo" } }),
    node("ApexMethod:Svc.doGo(2)", "ApexMethod"),
    node("ApexMethod:Svc.doGo(3)", "ApexMethod"),
    node("ApexMethod:Svc.other(0)", "ApexMethod"),
    node("ApexClass:Plain", "ApexClass"),
    node("ApexMethod:Plain.run(1)", "ApexMethod"),
  ]);
  store.mergeEdges([
    edge("IntegrationProcedure:A_B", "IP_INVOKES_REMOTE", "Remote:Svc", {
      remoteClass: "Svc",
      remoteMethod: "go",
    }),
    edge("OmniScript:X_Y_English", "OS_INVOKES_REMOTE", "Remote:Plain", {
      remoteClass: "Plain",
      remoteMethod: "run",
    }),
    edge("VlocityCard:C", "VC_INVOKES_REMOTE", "Remote:ns.Managed", {
      remoteClass: "ns.Managed",
      remoteMethod: "x",
    }),
  ]);
  return store;
}

describe("resolveVlocityApex", () => {
  it("links remote actions to ApexClass and ApexMethod nodes, idempotently", async () => {
    const store = await seed();
    const result = resolveVlocityApex(store, orgId, makeTestCtx());
    expect(result).toEqual({
      scanned: 3,
      resolvedClass: 2,
      resolvedMethod: 2,
      ambiguous: 1,
      external: 1,
    });

    const ipMethods = store.listEdgesFrom(
      orgId,
      asQualifiedName("IntegrationProcedure:A_B"),
      REL_TYPES.VLOCITY_INVOKES_APEX_METHOD,
    );
    expect(ipMethods).toHaveLength(2);
    expect(ipMethods.every((e) => e.attributes.ambiguous === true)).toBe(true);
    expect(ipMethods[0]?.attributes).toMatchObject({
      resolvedBy: "vlocity-apex-resolver",
      via: "IP_INVOKES_REMOTE",
      remoteMethod: "go",
    });

    const osMethods = store.listEdgesFrom(
      orgId,
      asQualifiedName("OmniScript:X_Y_English"),
      REL_TYPES.VLOCITY_INVOKES_APEX_METHOD,
    );
    expect(osMethods).toHaveLength(1);
    expect(osMethods[0]?.dstQualifiedName).toBe("ApexMethod:Plain.run(1)");

    expect(
      store.listEdgesFrom(
        orgId,
        asQualifiedName("IntegrationProcedure:A_B"),
        REL_TYPES.IP_INVOKES_REMOTE,
      ),
    ).toHaveLength(1);
    expect(
      store.listEdgesFrom(orgId, asQualifiedName("VlocityCard:C"), REL_TYPES.VLOCITY_INVOKES_APEX),
    ).toHaveLength(0);

    const count = () => ({
      cls: store.listEdgesByDstLike(orgId, "ApexClass:%", REL_TYPES.VLOCITY_INVOKES_APEX).length,
      mth: store.listEdgesByDstLike(orgId, "ApexMethod:%", REL_TYPES.VLOCITY_INVOKES_APEX_METHOD)
        .length,
    });
    const before = count();
    expect(before).toEqual({ cls: 2, mth: 3 });
    resolveVlocityApex(store, orgId, makeTestCtx());
    expect(count()).toEqual(before);
  });

  it("emits no method edge when a dispatch table lacks the key; skips endpoints and unknown", async () => {
    const store = await seed();
    store.mergeEdges([
      edge("IntegrationProcedure:D_E", "IP_INVOKES_REMOTE", "Remote:Svc", {
        remoteClass: "Svc",
        remoteMethod: "missing",
      }),
      edge("IntegrationProcedure:F_G", "IP_INVOKES_REMOTE", "Remote:unknown", {
        remoteClass: "unknown",
      }),
      edge("IntegrationProcedure:H_I", "IP_INVOKES_REMOTE", "Remote:/services/x", {}),
    ]);
    const result = resolveVlocityApex(store, orgId, makeTestCtx());
    expect(result.scanned).toBe(6);
    expect(result.external).toBe(1);
    expect(result.resolvedClass).toBe(3);
    expect(
      store.listEdgesFrom(
        orgId,
        asQualifiedName("IntegrationProcedure:D_E"),
        REL_TYPES.VLOCITY_INVOKES_APEX_METHOD,
      ),
    ).toHaveLength(0);
    for (const src of ["IntegrationProcedure:F_G", "IntegrationProcedure:H_I"]) {
      expect(
        store.listEdgesFrom(orgId, asQualifiedName(src), REL_TYPES.VLOCITY_INVOKES_APEX),
      ).toHaveLength(0);
    }
  });

  it("ignores inherited Object.prototype keys as remoteMethod (no throw, no method edge)", async () => {
    const store = await seed();
    store.mergeEdges([
      edge("IntegrationProcedure:P_Q", "IP_INVOKES_REMOTE", "Remote:Svc", {
        remoteClass: "Svc",
        remoteMethod: "constructor",
      }),
    ]);
    expect(() => resolveVlocityApex(store, orgId, makeTestCtx())).not.toThrow();
    expect(
      store.listEdgesFrom(
        orgId,
        asQualifiedName("IntegrationProcedure:P_Q"),
        REL_TYPES.VLOCITY_INVOKES_APEX_METHOD,
      ),
    ).toHaveLength(0);
  });
});

describe("resolveVlocityApex: opaque dataSource remotes and inactive propagation", () => {
  async function run(edges: ReturnType<typeof edge>[]) {
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    store.upsertOrg({
      id: orgId,
      alias: "t",
      instanceUrl: "https://example.test",
      apiVersion: "59.0",
      createdAt: Date.now(),
    });
    store.mergeNodes([
      node("ApexClass:Svc", "ApexClass"),
      node("ApexMethod:Svc.go(0)", "ApexMethod"),
    ]);
    store.mergeEdges(edges);
    resolveVlocityApex(store, orgId, makeTestCtx());
    return store;
  }
  it("links VlocityUILayout-style REFERENCES -> Remote:Cls to ApexClass/ApexMethod", async () => {
    const store = await run([
      edge("VlocityUILayout:L", "REFERENCES", "Remote:Svc", {
        remoteClass: "Svc",
        remoteMethod: "go",
        via: "dataSource",
      }),
    ]);
    const out = store.listEdgesFrom(orgId, asQualifiedName("VlocityUILayout:L"));
    expect(out.map((e) => `${e.relType} ${e.dstQualifiedName}`)).toContain(
      `${REL_TYPES.VLOCITY_INVOKES_APEX} ApexClass:Svc`,
    );
    expect(out.map((e) => String(e.dstQualifiedName))).toContain("ApexMethod:Svc.go(0)");
  });
  it("copies inactive=true only when the source edge is inactive", async () => {
    const store = await run([
      edge("IntegrationProcedure:I1", "IP_INVOKES_REMOTE", "Remote:Svc", {
        remoteClass: "Svc",
        remoteMethod: "go",
        inactive: true,
      }),
      edge("IntegrationProcedure:I2", "IP_INVOKES_REMOTE", "Remote:Svc", {
        remoteClass: "Svc",
        remoteMethod: "go",
      }),
    ]);
    const get = (q: string) =>
      store
        .listEdgesFrom(orgId, asQualifiedName(q), REL_TYPES.VLOCITY_INVOKES_APEX)
        .map((e) => e.attributes);
    expect(get("IntegrationProcedure:I1")[0]).toMatchObject({ inactive: true });
    expect(get("IntegrationProcedure:I2")[0]?.inactive).toBeUndefined();
    const m = store.listEdgesFrom(
      orgId,
      asQualifiedName("IntegrationProcedure:I1"),
      REL_TYPES.VLOCITY_INVOKES_APEX_METHOD,
    );
    expect(m[0]?.attributes).toMatchObject({ inactive: true });
  });
  it("ANDs inactive when several source edges of one src collapse (opaque + typed)", async () => {
    const store = await run([
      edge("VlocityCard:C", "REFERENCES", "Remote:Svc", { remoteClass: "Svc", inactive: true }),
      edge("VlocityCard:C", "VC_INVOKES_REMOTE", "Remote:Svc", { remoteClass: "Svc" }),
    ]);
    const e = store.listEdgesFrom(
      orgId,
      asQualifiedName("VlocityCard:C"),
      REL_TYPES.VLOCITY_INVOKES_APEX,
    );
    expect(e).toHaveLength(1);
    expect(e[0]?.attributes.inactive).toBeUndefined();
  });
});
