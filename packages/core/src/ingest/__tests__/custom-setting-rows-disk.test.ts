import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
  const snaps = new SqliteSnapshotStore({
    dbPath: ":memory:",
    db: store.db,
    skipMigrations: true,
  });
  await snaps.init();
  return { store, snaps };
}

const base = {
  alias: "test",
  mode: "full" as const,
  logger: new ConsoleLogger("error"),
};
const Q = "CustomSetting:Acme_Settings__c";

/** Raw bytes of the database file and its WAL, as a string, like `strings` would see them. */
function raw(dbPath: string): string {
  let out = "";
  for (const f of [dbPath, `${dbPath}-wal`]) if (existsSync(f)) out += readFileSync(f, "latin1");
  return out;
}

async function openFile(dir: string) {
  const dbPath = path.join(dir, "g.sqlite");
  const store = new SqliteGraphStore({ dbPath });
  await store.init();
  const snaps = new SqliteSnapshotStore({
    dbPath,
    db: store.db,
    skipMigrations: true,
  });
  await snaps.init();
  return { store, snaps, dbPath };
}

describe("custom setting row purge reaches the file", () => {
  it("after opt-in ingest and a default ingest the raw file and WAL no longer hold the value", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sfg-purge-"));
    try {
      const { store, snaps, dbPath } = await openFile(dir);
      const opt = {
        ...base,
        graphStore: store,
        snapshotStore: snaps,
        storeCustomSettingRows: true,
      };
      await liveIngest({ ...opt, preResolved: resolved() });
      await liveIngest({ ...opt, preResolved: resolved() });
      store.db.pragma("wal_checkpoint(TRUNCATE)");
      expect(raw(dbPath)).toContain(SECRET); // the check can see it when it is there

      await liveIngest({
        ...base,
        graphStore: store,
        snapshotStore: snaps,
        preResolved: resolved(),
      });
      expect(raw(dbPath)).not.toContain(SECRET);
      await store.close();
      expect(raw(dbPath)).not.toContain(SECRET);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("purgeStoredCustomSettingRows alone compacts the file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sfg-purge-"));
    try {
      const { store, dbPath } = await openFile(dir);
      await liveIngest({
        ...base,
        graphStore: store,
        preResolved: resolved(),
        skipSnapshot: true,
        storeCustomSettingRows: true,
      });
      const r = purgeStoredCustomSettingRows(store, ORG, {
        deleteNodeVector: () => true,
      });
      expect(r.compactError).toBeUndefined();
      expect(raw(dbPath)).not.toContain(SECRET);
      await store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("a malformed stored value is purged and counted, and no snapshot keeps rows", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sfg-purge-"));
    try {
      const { store, snaps, dbPath } = await openFile(dir);
      const opt = {
        ...base,
        graphStore: store,
        snapshotStore: snaps,
        storeCustomSettingRows: true,
      };
      await liveIngest({ ...opt, preResolved: resolved() });
      await liveIngest({ ...opt, preResolved: resolved() }); // a snapshot of the stored rows
      const tbl = (
        store.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name LIKE '%CustomSetting%' AND type = 'table'",
          )
          .get() as { name: string }
      ).name;
      store.db
        .prepare(
          `UPDATE "${tbl}" SET attributes = '{"customSettingRows": [{"k":"${SECRET}"} BROKEN'`,
        )
        .run();
      store.db
        .prepare(
          `UPDATE _sfgraph_snap_nodes SET attributes = '{"customSettingRows": ${SECRET} BROKEN' WHERE label = 'CustomSetting'`,
        )
        .run();

      const r = purgeStoredCustomSettingRows(store, ORG, {
        deleteNodeVector: () => true,
      });
      expect(r.settings).toBe(1);
      expect(r.compactError).toBeUndefined();
      expect(store.getNode(ORG, Q as never)).not.toBeNull();
      store.db.pragma("wal_checkpoint(TRUNCATE)");
      expect(raw(dbPath)).not.toContain(SECRET);

      // And through a default ingest (which snapshots first).
      await liveIngest({
        ...opt,
        storeCustomSettingRows: true,
        preResolved: resolved(),
      });
      store.db
        .prepare(`UPDATE "${tbl}" SET attributes = '{"customSettingRows": ${SECRET} BROKEN'`)
        .run();
      await liveIngest({
        ...base,
        graphStore: store,
        snapshotStore: snaps,
        preResolved: resolved(),
      });
      store.db.pragma("wal_checkpoint(TRUNCATE)");
      expect(raw(dbPath)).not.toContain(SECRET);
      await store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("when the purge throws, the ingest takes no pre-sync snapshot", async () => {
    const { store, snaps } = await (async () => {
      const s = new SqliteGraphStore({ dbPath: ":memory:" });
      await s.init();
      const n = new SqliteSnapshotStore({
        dbPath: ":memory:",
        db: s.db,
        skipMigrations: true,
      });
      await n.init();
      return { store: s, snaps: n };
    })();
    await liveIngest({
      ...base,
      graphStore: store,
      snapshotStore: snaps,
      preResolved: resolved(),
      skipSnapshot: true,
      storeCustomSettingRows: true,
    });
    const count = () =>
      (store.db.prepare("SELECT COUNT(*) AS c FROM _sfgraph_snapshots").get() as { c: number }).c;
    const before = count();
    store.purgeCustomSettingRows = () => {
      throw new Error("boom");
    };
    await liveIngest({
      ...base,
      graphStore: store,
      snapshotStore: snaps,
      preResolved: resolved(),
    });
    expect(count()).toBe(before);
  }, 60_000);
});
