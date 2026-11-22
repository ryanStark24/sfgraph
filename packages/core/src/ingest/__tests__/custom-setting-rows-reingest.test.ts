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

/** Every place the store keeps text, as one string. */
function dump(store: SqliteGraphStore): string {
  const db = store.db;
  const parts: string[] = [];
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%CustomSetting%'")
    .all() as Array<{ name: string }>;
  for (const t of tables) {
    for (const r of db.prepare(`SELECT attributes FROM "${t.name}"`).all() as Array<{
      attributes: string;
    }>)
      parts.push(r.attributes);
  }
  for (const r of db.prepare("SELECT body FROM _sfgraph_node_fts").all() as Array<{
    body: string;
  }>)
    parts.push(r.body);
  for (const t of ["_sfgraph_snap_nodes"]) {
    for (const r of db.prepare(`SELECT attributes FROM ${t}`).all() as Array<{
      attributes: string;
    }>)
      parts.push(r.attributes);
  }
  return parts.join("\n");
}

describe("custom setting purge then re-ingest", () => {
  it("opt-in ingest, purge, opt-in ingest of unchanged settings, purge leaves no row text anywhere", async () => {
    const { store } = await newStore();
    const optIn = () =>
      liveIngest({
        ...base,
        graphStore: store,
        preResolved: resolved(),
        skipSnapshot: true,
        storeCustomSettingRows: true,
      });
    await optIn();
    purgeStoredCustomSettingRows(store, ORG, { deleteNodeVector: () => true });
    expect(dump(store)).not.toContain(SECRET);
    await optIn(); // same rows again: the node must be rewritten with them, not left stripped
    expect(dump(store)).toContain(SECRET);
    const r = purgeStoredCustomSettingRows(store, ORG, { deleteNodeVector: () => true });
    expect(r.settings).toBe(1);
    expect(dump(store)).not.toContain(SECRET);
  });
});
