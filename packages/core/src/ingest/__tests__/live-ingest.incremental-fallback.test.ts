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

function makeConn(state: { body: string; sourceMembers: SmRow[]; failApex?: boolean }) {
  const conn = buildJsforceMock({
    toolingDescribeResults: { SourceMember: true },
    toolingQueryResults: {
      [APEX_SOQL]: { records: [], done: true },
    },
    metadataList: {},
  });
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
