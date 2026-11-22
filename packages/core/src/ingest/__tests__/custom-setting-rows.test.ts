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

describe("custom setting rows are opt-in", () => {
  it("default ingest keeps the setting's name and drops its row values", async () => {
    const { store } = await newStore();
    await liveIngest({ ...base, graphStore: store, preResolved: resolved(), skipSnapshot: true });
    const node = store.getNode(ORG, "CustomSetting:Acme_Settings__c" as never);
    expect(node).not.toBeNull();
    expect(node?.attributes.customSettingRows ?? null).toBeNull();
    expect(dump(store)).not.toContain(SECRET);
    expect(dump(store)).toContain("Acme_Settings__c");
  });

  it("storeCustomSettingRows stores them (the opt-in)", async () => {
    const { store } = await newStore();
    await liveIngest({
      ...base,
      graphStore: store,
      preResolved: resolved(),
      skipSnapshot: true,
      storeCustomSettingRows: true,
    });
    expect(dump(store)).toContain(SECRET);
  });

  it("the next default ingest purges rows an earlier ingest stored: graph, search index, snapshots", async () => {
    const { store, snaps } = await newStore();
    // An earlier (opt-in) ingest, then one more so a snapshot of that state exists.
    await liveIngest({
      ...base,
      graphStore: store,
      snapshotStore: snaps,
      preResolved: resolved(),
      storeCustomSettingRows: true,
    });
    await liveIngest({
      ...base,
      graphStore: store,
      snapshotStore: snaps,
      preResolved: resolved(),
      storeCustomSettingRows: true,
    });
    expect(dump(store)).toContain(SECRET);
    expect(
      (store.db.prepare("SELECT COUNT(*) AS c FROM _sfgraph_snap_nodes").get() as { c: number }).c,
    ).toBeGreaterThan(0);

    await liveIngest({ ...base, graphStore: store, snapshotStore: snaps, preResolved: resolved() });
    expect(dump(store)).not.toContain(SECRET);
    expect(store.getNode(ORG, "CustomSetting:Acme_Settings__c" as never)).not.toBeNull();
  });

  async function withRows() {
    const { store } = await newStore();
    await liveIngest({
      ...base,
      graphStore: store,
      preResolved: resolved(),
      skipSnapshot: true,
      storeCustomSettingRows: true,
    });
    return store;
  }
  const Q = "CustomSetting:Acme_Settings__c";

  it("purgeStoredCustomSettingRows removes rows without an ingest and drops their vectors", async () => {
    const store = await withRows();
    const dropped: string[] = [];
    const r = purgeStoredCustomSettingRows(store, ORG, {
      deleteNodeVector: (_o, q) => {
        dropped.push(String(q));
        return true;
      },
    });
    expect(r).toEqual({ settings: 1, vectorsPending: 0 });
    expect(dropped).toEqual([Q]);
    expect(dump(store)).not.toContain(SECRET);
    // Nothing left to purge.
    expect(purgeStoredCustomSettingRows(store, ORG)).toEqual({ settings: 0, vectorsPending: 0 });
  });

  it("with no vector store the vectors stay pending (marker kept); a rerun with a store deletes them", async () => {
    const store = await withRows();
    const first = purgeStoredCustomSettingRows(store, ORG);
    expect(first).toEqual({ settings: 1, vectorsPending: 1 });
    expect(dump(store)).not.toContain(SECRET);
    // The rows are gone, so only the marker can find this node again.
    expect(
      store.db.prepare("SELECT qualified_name AS q FROM _sfgraph_pending_vector_deletes").all(),
    ).toEqual([{ q: Q }]);
    const dropped: string[] = [];
    const second = purgeStoredCustomSettingRows(store, ORG, {
      deleteNodeVector: (_o, q) => {
        dropped.push(String(q));
        return true;
      },
    });
    expect(second).toEqual({ settings: 1, vectorsPending: 0 });
    expect(dropped).toEqual([Q]);
    expect(JSON.stringify(store.getNode(ORG, Q as never)?.attributes)).not.toContain(
      "customSettingRowsVectorsPending",
    );
    expect(purgeStoredCustomSettingRows(store, ORG)).toEqual({ settings: 0, vectorsPending: 0 });
  });

  it("a failing vector delete leaves the marker; the rerun completes", async () => {
    const store = await withRows();
    const failing = purgeStoredCustomSettingRows(store, ORG, {
      deleteNodeVector: () => {
        throw new Error("vec table locked");
      },
    });
    expect(failing).toEqual({ settings: 1, vectorsPending: 1 });
    const dropped: string[] = [];
    const rerun = purgeStoredCustomSettingRows(store, ORG, {
      deleteNodeVector: (_o, q) => {
        dropped.push(String(q));
        return true;
      },
    });
    expect(rerun).toEqual({ settings: 1, vectorsPending: 0 });
    expect(dropped).toEqual([Q]);
  });

  it("a default ingest with no vector store keeps the pending vector delete; a rerun with a store deletes it", async () => {
    const store = await withRows();
    // Default ingest, no vector store: the purge cannot delete the row-derived vector, and the
    // same ingest then rewrites the node's attributes (the old marker would be lost).
    await liveIngest({ ...base, graphStore: store, preResolved: resolved(), skipSnapshot: true });
    expect(dump(store)).not.toContain(SECRET);
    const dropped: string[] = [];
    const r = purgeStoredCustomSettingRows(store, ORG, {
      deleteNodeVector: (_o, q) => {
        dropped.push(String(q));
        return true;
      },
    });
    expect(dropped).toEqual([Q]);
    expect(r.vectorsPending).toBe(0);
    expect(purgeStoredCustomSettingRows(store, ORG)).toEqual({ settings: 0, vectorsPending: 0 });
  }, 30_000);
});
