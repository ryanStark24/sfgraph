import { ConsoleLogger, asOrgId } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { buildJsforceMock } from "../../extractors/live-org/__tests__/_jsforce-mock.js";
import { wrapConnectionReadOnly } from "../../extractors/live-org/read-only-proxy.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { SqliteSnapshotStore } from "../../storage/sqlite/snapshot-store.js";
import { liveIngest, purgeStoredCustomSettingRows } from "../live-ingest.js";

const SECRET = "s3cr3t-token-value-0042";
const ORG = asOrgId("00Dxx0000000ABCEAA");

function mockConn() {
  return buildJsforceMock({
    toolingQueryResults: {
      "SELECT QualifiedApiName FROM EntityDefinition WHERE IsCustomSetting = true": {
        records: [{ QualifiedApiName: "Acme_Settings__c" }],
        done: true,
      },
    },
    queryResults: {
      "SELECT FIELDS(ALL) FROM Acme_Settings__c LIMIT 200": {
        records: [{ Id: "a01x0000000001", Name: "Default", Api_Key__c: SECRET }],
        done: true,
      },
    },
  });
}

function resolved() {
  return {
    orgId: ORG,
    alias: "test",
    username: "test@example.com",
    instanceUrl: "https://example.my.salesforce.com",
    apiVersion: "60.0",
    conn: wrapConnectionReadOnly(mockConn()),
  };
}

async function newStore() {
  const store = new SqliteGraphStore({ dbPath: ":memory:" });
  await store.init();
  const snaps = new SqliteSnapshotStore({ dbPath: ":memory:", db: store.db, skipMigrations: true });
  await snaps.init();
  return { store, snaps };
}

const base = { alias: "test", mode: "full" as const, logger: new ConsoleLogger("error") };

describe("name-only custom settings survive repeated default ingests", () => {
  it("a default ingest of name-only settings is not purged by the next default ingest", async () => {
    const { store } = await newStore();
    await liveIngest({ ...base, graphStore: store, preResolved: resolved(), skipSnapshot: true });
    const tbl = (
      store.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%CustomSetting%'",
        )
        .all() as Array<{ name: string }>
    ).find((t) => !t.name.startsWith("_sfgraph"))?.name;
    expect(tbl).toBeTruthy();
    const read = () =>
      store.db
        .prepare(`SELECT attributes AS a, source_hash AS h FROM "${tbl}" WHERE org_id = ?`)
        .all(ORG);
    const before = read();
    expect(before).toHaveLength(1);
    expect((before[0] as { h: string }).h).not.toBe("purged-custom-setting-rows");

    const dropped: string[] = [];
    const sink = {
      deleteNodeVector: (_o: unknown, q: unknown) => {
        dropped.push(String(q));
        return true;
      },
    };
    await liveIngest({
      ...base,
      graphStore: store,
      preResolved: resolved(),
      skipSnapshot: true,
    });
    expect(purgeStoredCustomSettingRows(store, ORG, sink)).toEqual({
      settings: 0,
      vectorsPending: 0,
    });
    expect(dropped).toEqual([]);
    const after = read();
    expect((after[0] as { h: string }).h).toBe((before[0] as { h: string }).h);
    expect(JSON.parse((after[0] as { a: string }).a)).not.toHaveProperty(
      "customSettingRowsVectorsPending",
    );
  });
});
