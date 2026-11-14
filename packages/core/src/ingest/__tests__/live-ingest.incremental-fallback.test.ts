import { ConsoleLogger, asOrgId, asQualifiedName } from "@ryanstark24/sfgraph-shared";
import { beforeEach, describe, expect, it } from "vitest";
import { limiter, metadataPool } from "../../extractors/live-org/rate-limit.js";

import { buildJsforceMock } from "../../extractors/live-org/__tests__/_jsforce-mock.js";
import { wrapConnectionReadOnly } from "../../extractors/live-org/read-only-proxy.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { liveIngest } from "../live-ingest.js";

/**
 * F03 / S-1.8.2-003. Incremental sync applies deletions only. After a first
 * sync, `auto` must not stop at deletions: when SourceMember reports additions,
 * modifications or types sfgraph cannot map, it runs a full refresh in the same
 * run and says so. Explicit `incremental` keeps its deletions-only behaviour,
 * says so, and holds the watermark.
 */

// The shared API pools meter calls with a reservoir that refills slowly; after
// a few full syncs in one process the later tests waited ~8 s on it. Top it up.
beforeEach(async () => {
  await limiter.incrementReservoir(10_000);
  await metadataPool.incrementReservoir(10_000);
});

const ORG_ID = asOrgId("00Dxx0000000ABCEAA");
const APEX_SOQL =
  "SELECT Id, Name, Body, NamespacePrefix, LastModifiedDate, ApiVersion, Status FROM ApexClass";

interface SmRow {
  MemberType: string;
  MemberName: string;
  IsNameObsolete?: boolean;
}

function makeConn(state: {
  body: string;
  sourceMembers: SmRow[];
  failApex?: boolean;
  discoveryFails?: boolean;
  withObjectAndLwc?: boolean;
  workflow?: "ok" | "fail" | undefined;
}) {
  const conn = buildJsforceMock({
    toolingDescribeResults: { SourceMember: true },
    toolingQueryResults: {
      [APEX_SOQL]: { records: [], done: true },
    },
    metadataList: {},
    metadataDescribe: [],
  });
  const baseDescribe = conn.metadata.describe;
  const baseList = conn.metadata.list;
  conn.metadata.list = async (req: unknown) => {
    const first = (Array.isArray(req) ? req[0] : req) as { type?: string };
    if (first?.type === "Workflow" && state.workflow) {
      if (state.workflow === "fail") throw new Error("socket hang up (ECONNRESET)");
      return [{ fullName: "Account" }];
    }
    return baseList(req);
  };
  conn.metadata.describe = async (v?: string) => {
    if (state.discoveryFails) throw new Error("socket hang up (ECONNRESET)");
    if (state.workflow) return { metadataObjects: [{ xmlName: "Workflow" }] };
    return baseDescribe(v);
  };
  const baseDescribeGlobal = conn.describeGlobal;
  const baseSobject = conn.sobject;
  if (state.withObjectAndLwc !== undefined) {
    conn.describeGlobal = async () =>
      state.withObjectAndLwc
        ? {
            sobjects: [
              {
                name: "Account",
                label: "Account",
                custom: false,
                queryable: true,
                deprecatedAndHidden: false,
              },
            ],
          }
        : baseDescribeGlobal();
    conn.sobject = (name: string) =>
      state.withObjectAndLwc && name === "Account"
        ? {
            describe: async () => ({
              name: "Account",
              label: "Account",
              fields: [
                { name: "Id", type: "id", label: "Id" },
                { name: "Tier__c", type: "string", label: "Tier", custom: true },
              ],
            }),
          }
        : baseSobject(name);
  }
  const baseQuery = conn.tooling.query;
  conn.tooling.query = async (soql: string) => {
    if (/FROM SourceMember/.test(soql)) {
      return {
        done: true,
        records: state.sourceMembers.map((r, i) => ({
          Id: `SM${i}`,
          RevisionCounter: i + 1,
          IsNameObsolete: false,
          LastModifiedDate: new Date().toISOString(),
          ...r,
        })),
      };
    }
    if (state.withObjectAndLwc && /FROM EntityDefinition/.test(soql)) {
      return {
        done: true,
        records: [
          {
            QualifiedApiName: "Account",
            IsCustomizable: true,
            IsApexTriggerable: true,
            IsDeprecatedAndHidden: false,
            IsCustomSetting: false,
          },
        ],
      };
    }
    if (state.withObjectAndLwc && /FROM LightningComponentBundle$/.test(soql)) {
      return {
        done: true,
        records: [
          { Id: "0Rb1", DeveloperName: "acmeCard", LastModifiedDate: "2025-01-01T00:00:00Z" },
        ],
      };
    }
    if (/FROM LightningComponentResource/.test(soql)) {
      return {
        done: true,
        records: [
          { FilePath: "lwc/acmeCard/acmeCard.js", Source: "export default class AcmeCard {}" },
        ],
      };
    }
    if (soql === APEX_SOQL && state.failApex) throw new Error("socket hang up (ECONNRESET)");
    if (soql === APEX_SOQL) {
      return {
        done: true,
        records: [
          {
            Id: "01p1",
            Name: "Billing",
            Body: state.body,
            LastModifiedDate: "2025-01-01T00:00:00Z",
          },
        ],
      };
    }
    return baseQuery(soql);
  };
  return conn;
}

function resolved(conn: unknown) {
  return {
    orgId: ORG_ID,
    alias: "acme",
    username: "dev@example.invalid",
    instanceUrl: "https://example.invalid",
    apiVersion: "60.0",
    conn: wrapConnectionReadOnly(conn as never),
  };
}

async function run(store: SqliteGraphStore, conn: unknown, mode: "auto" | "incremental" | "full") {
  return liveIngest({
    alias: "acme",
    graphStore: store,
    mode,
    preResolved: resolved(conn),
    logger: new ConsoleLogger("error"),
    skipSnapshot: true,
  });
}

async function seeded() {
  const store = new SqliteGraphStore({ dbPath: ":memory:" });
  await store.init();
  const state = {
    body: "public class Billing { public void a() {} }",
    sourceMembers: [] as SmRow[],
    failApex: false,
    discoveryFails: false,
    withObjectAndLwc: false,
    workflow: undefined as "ok" | "fail" | undefined,
  };
  const conn = makeConn(state);
  const first = await run(store, conn, "full");
  expect(first.mode).toBe("full");
  const hash = () => store.getNode(ORG_ID, asQualifiedName("ApexClass:Billing"))?.sourceHash;
  expect(hash()).toBeTruthy();
  // Make the stored watermark strictly older than "now" so SourceMember rows
  // (stamped now) fall after it.
  const org = store.getOrg(ORG_ID);
  store.upsertOrg({ ...org!, lastSyncedAt: Date.now() - 60_000 });
  return { store, state, conn, hash };
}

describe("live sync: auto falls back to a full refresh when content changed", () => {
  it("a modified Apex class under auto gets its new body and hash", async () => {
    const { store, state, conn, hash } = await seeded();
    const oldHash = hash();
    state.body = "public class Billing { public void a() {} public void b() {} }";
    state.sourceMembers = [{ MemberType: "ApexClass", MemberName: "Billing" }];
    const result = await run(store, conn, "auto");
    expect(result.mode).toBe("full");
    expect(hash()).not.toBe(oldHash);
    expect(result.membersProcessed).toBeGreaterThan(0);
    expect(result.warnings).toContain("incremental:fellBackToFull:changed=1");
    expect(result.warnings.some((w) => w.includes("contentNotFetched"))).toBe(false);
    // A full sync advances the watermark.
    expect(store.getOrg(ORG_ID)!.lastSyncedAt!).toBeGreaterThan(Date.now() - 30_000);
    await store.close();
  });

  it("a deletion seen alongside a modification is still applied in the fallback full run", async () => {
    const { store, state, conn, hash } = await seeded();
    const oldHash = hash();
    // A second class exists in the graph and is deleted in the org.
    store.mergeNodes([
      {
        orgId: ORG_ID,
        label: "ApexClass",
        qualifiedName: asQualifiedName("ApexClass:Gone"),
        attributes: { name: "Gone" },
        sourceHash: "gone-hash" as never,
        firstSeenAt: 1,
        lastSeenAt: 1,
        lastModifiedAt: 1,
      },
    ]);
    state.body = "public class Billing { public void changed() {} }";
    state.sourceMembers = [
      { MemberType: "ApexClass", MemberName: "Billing" },
      { MemberType: "ApexClass", MemberName: "Gone", IsNameObsolete: true },
    ];
    const result = await run(store, conn, "auto"); // detectDeletions unset
    expect(result.mode).toBe("full");
    expect(store.getNode(ORG_ID, asQualifiedName("ApexClass:Gone"))).toBeFalsy();
    expect(hash()).not.toBe(oldHash);
    await store.close();
  });

  it("a fallback whose Apex retrieval fails holds the watermark; the next auto run refreshes", async () => {
    const { store, state, conn, hash } = await seeded();
    const oldHash = hash();
    const before = store.getOrg(ORG_ID)!.lastSyncedAt;
    state.body = "public class Billing { public void changed() {} }";
    state.sourceMembers = [{ MemberType: "ApexClass", MemberName: "Billing" }];
    state.failApex = true;
    const r1 = await run(store, conn, "auto");
    expect(r1.mode).toBe("full");
    expect(r1.warnings.some((w) => w.startsWith("incremental:fallbackIncomplete:"))).toBe(true);
    expect(hash()).toBe(oldHash);
    expect(store.getOrg(ORG_ID)!.lastSyncedAt).toBe(before);
    state.failApex = false;
    const r2 = await run(store, conn, "auto");
    expect(r2.mode).toBe("full");
    expect(hash()).not.toBe(oldHash);
    expect(store.getOrg(ORG_ID)!.lastSyncedAt!).toBeGreaterThan(before!);
    await store.close();
  });

  it("a modified Aura bundle with metadata discovery failing holds the watermark", async () => {
    const { store, state, conn } = await seeded();
    const before = store.getOrg(ORG_ID)!.lastSyncedAt;
    state.sourceMembers = [{ MemberType: "AuraDefinitionBundle", MemberName: "AcmeCard" }];
    state.discoveryFails = true;
    const r = await run(store, conn, "auto");
    expect(r.mode).toBe("full");
    const w = r.warnings.find((x) => x.startsWith("incremental:fallbackIncomplete:"));
    expect(w).toContain("unrefreshed=AuraDefinitionBundle:AcmeCard");
    expect(w).toContain("discoverySkipped");
    expect(store.getOrg(ORG_ID)!.lastSyncedAt).toBe(before);
    await store.close();
  });

  it("a change that no written node matches (child type) holds and is named", async () => {
    const { store, state, conn } = await seeded();
    const before = store.getOrg(ORG_ID)!.lastSyncedAt;
    state.sourceMembers = [{ MemberType: "CustomField", MemberName: "Account.Tier__c" }];
    const r = await run(store, conn, "auto");
    expect(r.warnings.some((x) => x.includes("unrefreshed=CustomField:Account.Tier__c"))).toBe(
      true,
    );
    expect(store.getOrg(ORG_ID)!.lastSyncedAt).toBe(before);
    await store.close();
  });

  it("unrelated skips do not hold the watermark when every change was refreshed", async () => {
    const { store, state, conn } = await seeded();
    const before = store.getOrg(ORG_ID)!.lastSyncedAt;
    state.body = "public class Billing { public void z() {} }";
    state.sourceMembers = [{ MemberType: "ApexClass", MemberName: "billing" }];
    const r = await run(store, conn, "auto");
    // the mock always skips the `object` source (no describeGlobal)
    expect(r.warnings.some((x) => x.includes("object"))).toBe(true);
    expect(r.warnings.some((x) => x.startsWith("incremental:fallbackIncomplete:"))).toBe(false);
    expect(store.getOrg(ORG_ID)!.lastSyncedAt!).toBeGreaterThan(before!);
    await store.close();
  });

  it("a modified CustomField and LWC bundle written by the extractors let the watermark advance", async () => {
    const { store, state, conn } = await seeded();
    const before = store.getOrg(ORG_ID)!.lastSyncedAt;
    state.withObjectAndLwc = true;
    // SourceMember names: field as `Obj.Field` (any case), bundle by DeveloperName.
    state.sourceMembers = [
      { MemberType: "CustomField", MemberName: "account.tier__c" },
      { MemberType: "LightningComponentBundle", MemberName: "AcmeCard" },
    ];
    const r = await run(store, conn, "auto");
    expect(r.mode).toBe("full");
    expect(store.getNode(ORG_ID, asQualifiedName("CustomField:Account.Tier__c"))).toBeTruthy();
    expect(store.getNode(ORG_ID, asQualifiedName("LWC:acmeCard"))).toBeTruthy();
    expect(r.warnings.filter((x) => x.startsWith("incremental:fallbackIncomplete:"))).toEqual([]);
    expect(store.getOrg(ORG_ID)!.lastSyncedAt!).toBeGreaterThan(before!);
    await store.close();
  });

  it("a modified Workflow whose generic retrieval fails holds the watermark and names it", async () => {
    const { store, state, conn } = await seeded();
    const before = store.getOrg(ORG_ID)!.lastSyncedAt;
    state.sourceMembers = [{ MemberType: "Workflow", MemberName: "Account" }];
    state.workflow = "fail";
    const r = await run(store, conn, "auto");
    expect(r.mode).toBe("full");
    expect(r.warnings.some((x) => x.includes("unrefreshed=Workflow:Account"))).toBe(true);
    expect(store.getOrg(ORG_ID)!.lastSyncedAt).toBe(before);
    await store.close();
  });

  it("a modified Workflow written by the generic extractor lets the watermark advance", async () => {
    const { store, state, conn } = await seeded();
    const before = store.getOrg(ORG_ID)!.lastSyncedAt;
    state.sourceMembers = [{ MemberType: "Workflow", MemberName: "Account" }];
    state.workflow = "ok";
    const r = await run(store, conn, "auto");
    expect(r.mode).toBe("full");
    expect(r.warnings).toContain("incremental:unsupportedTypes:Workflow=1");
    expect(r.warnings.filter((x) => x.startsWith("incremental:fallbackIncomplete:"))).toEqual([]);
    expect(store.getOrg(ORG_ID)!.lastSyncedAt!).toBeGreaterThan(before!);
    await store.close();
  });

  it("a Workflow SourceMember change under auto falls back to full and names the type", async () => {
    const { store, state, conn } = await seeded();
    state.sourceMembers = [{ MemberType: "Workflow", MemberName: "Account" }];
    const result = await run(store, conn, "auto");
    expect(result.mode).toBe("full");
    expect(result.warnings).toContain("incremental:unsupportedTypes:Workflow=1");
    expect(result.warnings).toContain("incremental:fellBackToFull:changed=1");
    await store.close();
  });

  it("pure deletions and no changes keep the incremental path", async () => {
    const { store, state, conn, hash } = await seeded();
    const oldHash = hash();
    const none = await run(store, conn, "auto");
    expect(none.mode).toBe("incremental");
    expect(none.warnings).toEqual([]);
    state.sourceMembers = [
      { MemberType: "ApexClass", MemberName: "Billing", IsNameObsolete: true },
    ];
    const del = await run(store, conn, "auto");
    expect(del.mode).toBe("incremental");
    expect(del.deletions).toBe(1);
    expect(del.warnings).toEqual([]);
    expect(hash()).not.toBe(oldHash);
    await store.close();
  });
});

describe("live sync: explicit incremental says what it did not do", () => {
  it("an unsupported type holds the watermark and warns", async () => {
    const { store, state, conn } = await seeded();
    const before = store.getOrg(ORG_ID)!.lastSyncedAt;
    state.sourceMembers = [{ MemberType: "Workflow", MemberName: "Account" }];
    const result = await run(store, conn, "incremental");
    expect(result.mode).toBe("incremental");
    expect(result.warnings).toContain("incremental:unsupportedTypes:Workflow=1");
    expect(store.getOrg(ORG_ID)!.lastSyncedAt).toBe(before);
    await store.close();
  });

  it("a modified class is not fetched, is reported, and the watermark is held", async () => {
    const { store, state, conn, hash } = await seeded();
    const oldHash = hash();
    const before = store.getOrg(ORG_ID)!.lastSyncedAt;
    state.body = "public class Billing { public void changed() {} }";
    state.sourceMembers = [{ MemberType: "ApexClass", MemberName: "Billing" }];
    const result = await run(store, conn, "incremental");
    expect(result.mode).toBe("incremental");
    expect(result.warnings).toContain("incremental:contentNotFetched:count=1");
    expect(hash()).toBe(oldHash);
    expect(store.getOrg(ORG_ID)!.lastSyncedAt).toBe(before);
    await store.close();
  });
});
