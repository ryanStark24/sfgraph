import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ConsoleLogger } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilesystemMetadataSource } from "../../extractors/filesystem/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { liveIngest } from "../live-ingest.js";
import { offlineResolvedOrg } from "../offline-org.js";

// Canonical graph dump shared with bench/graph-diff.mjs (the "same output" contract).
const GRAPH_DUMP = pathToFileURL(
  path.resolve(__dirname, "../../../../../bench/lib/graph-dump.mjs"),
).href;
type DumpLines = (dbPath: string, opts?: { orgId?: string }) => Iterable<string>;

let dir: string;
let proj: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-fast-"));
  proj = path.join(dir, "proj");
  writeFixture(proj);
});
afterEach(() => {
  // biome-ignore lint/performance/noDelete: env var must be truly unset
  delete process.env.SFGRAPH_DISABLE_FASTPATH;
  rmSync(dir, { recursive: true, force: true });
});

function w(root: string, rel: string, c: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, c, "utf8");
}

/** A small SFDX project touching several parsers, shared targets and repeated sources. */
function writeFixture(root: string): void {
  const md = "force-app/main/default";
  w(
    root,
    "sfdx-project.json",
    JSON.stringify({ packageDirectories: [{ path: "force-app" }, { path: "extra-app" }] }),
  );
  // Same class in a second package dir, with fewer references: the later
  // member must re-reconcile (prune) the earlier one's edges and replace its
  // FTS doc, so the fast path's "already written in this run" tracking is hit.
  w(
    root,
    "extra-app/main/default/classes/OrderHelper.cls",
    "public class OrderHelper { public static void touch(List<Account> a) { } }",
  );
  w(
    root,
    `${md}/classes/AccountService.cls`,
    `public with sharing class AccountService {
       public static List<Account> load(Set<Id> ids) {
         return [SELECT Id, Name, Tier__c FROM Account WHERE Id IN :ids];
       }
       public static void save(List<Account> accts) { update accts; OrderHelper.touch(accts); }
     }`,
  );
  w(
    root,
    `${md}/classes/OrderHelper.cls`,
    `public class OrderHelper {
       public static void touch(List<Account> a) { insert new Order__c(Account__c = a[0].Id); }
       public static Integer count() { return [SELECT COUNT() FROM Order__c]; }
     }`,
  );
  w(
    root,
    `${md}/classes/AccountServiceTest.cls`,
    `@isTest private class AccountServiceTest {
       @isTest static void t() { AccountService.load(new Set<Id>()); System.assert(true); }
     }`,
  );
  w(
    root,
    `${md}/triggers/AccountTrigger.trigger`,
    "trigger AccountTrigger on Account (before update) { AccountService.save(Trigger.new); }",
  );
  w(
    root,
    `${md}/objects/Account/Account.object-meta.xml`,
    "<CustomObject><label>Account</label></CustomObject>",
  );
  w(
    root,
    `${md}/objects/Account/fields/Tier__c.field-meta.xml`,
    "<CustomField><fullName>Tier__c</fullName><type>Text</type></CustomField>",
  );
  w(
    root,
    `${md}/objects/Order__c/Order__c.object-meta.xml`,
    "<CustomObject><label>Order</label></CustomObject>",
  );
  w(
    root,
    `${md}/objects/Order__c/fields/Account__c.field-meta.xml`,
    "<CustomField><fullName>Account__c</fullName><type>Lookup</type><referenceTo>Account</referenceTo><relationshipName>Orders</relationshipName></CustomField>",
  );
  w(
    root,
    `${md}/permissionsets/Sales.permissionset-meta.xml`,
    `<PermissionSet><label>Sales</label>
       <classAccesses><apexClass>AccountService</apexClass><enabled>true</enabled></classAccesses>
       <fieldPermissions><field>Account.Tier__c</field><readable>true</readable><editable>false</editable></fieldPermissions>
       <objectPermissions><object>Order__c</object><allowRead>true</allowRead></objectPermissions>
     </PermissionSet>`,
  );
  w(
    root,
    `${md}/labels/CustomLabels.labels-meta.xml`,
    "<CustomLabels><labels><fullName>Greeting</fullName><value>Hi</value></labels></CustomLabels>",
  );
}

async function rebuild(dbPath: string): Promise<SqliteGraphStore> {
  const graphStore = new SqliteGraphStore({ dbPath, backupDir: path.join(dir, "bk") });
  await graphStore.init();
  const resolved = offlineResolvedOrg(proj, "fixture");
  await liveIngest({
    alias: "fixture",
    graphStore,
    mode: "full",
    rebuild: true,
    preResolved: resolved,
    metadataSource: await FilesystemMetadataSource.fromProjectRoot(proj),
    logger: new ConsoleLogger("error"),
    skipSnapshot: true,
    analysisDb: graphStore.db,
  });
  return graphStore;
}

function ftsRows(store: SqliteGraphStore): unknown[] {
  return store.db
    .prepare(
      "SELECT rowid, qualified_name, org_id, label, body FROM _sfgraph_node_fts ORDER BY rowid",
    )
    .all();
}

describe("rebuild fast path", () => {
  it("produces a graph identical (dumpLines) to the fast path disabled", async () => {
    const { dumpLines } = (await import(GRAPH_DUMP)) as { dumpLines: DumpLines };
    const slowDb = path.join(dir, "slow.sqlite");
    const fastDb = path.join(dir, "fast.sqlite");

    process.env.SFGRAPH_DISABLE_FASTPATH = "1";
    const slow = await rebuild(slowDb);
    const slowFts = ftsRows(slow);
    const orgId = String(offlineResolvedOrg(proj, "fixture").orgId);
    const slowSearch = ["account", "order helper", "tier"].map((q) =>
      slow.searchNodesFts(orgId as never, q, 50),
    );
    await slow.close();
    // biome-ignore lint/performance/noDelete: env var must be truly unset
    delete process.env.SFGRAPH_DISABLE_FASTPATH;

    const fast = await rebuild(fastDb);
    const fastFts = ftsRows(fast);
    const fastSearch = ["account", "order helper", "tier"].map((q) =>
      fast.searchNodesFts(orgId as never, q, 50),
    );
    await fast.close();

    const a = [...dumpLines(slowDb)];
    const b = [...dumpLines(fastDb)];
    expect(a.length).toBeGreaterThan(20);
    expect(b).toEqual(a);
    expect(fastFts).toEqual(slowFts);
    expect(fastSearch).toEqual(slowSearch);
  });

  it("calls deleteEdgesFor 0 times and skips per-member delete probes on rebuild of an empty graph", async () => {
    const graphStore = new SqliteGraphStore({
      dbPath: path.join(dir, "spy.sqlite"),
      backupDir: path.join(dir, "bk"),
    });
    await graphStore.init();
    const del = vi.spyOn(graphStore, "deleteEdgesFor");
    const begin = vi.spyOn(graphStore, "beginBulk");
    const end = vi.spyOn(graphStore, "endBulk");
    let statsAtEnd: ReturnType<SqliteGraphStore["bulkStats"]> | null = null;
    end.mockImplementation(function (this: SqliteGraphStore) {
      statsAtEnd = graphStore.bulkStats();
      return SqliteGraphStore.prototype.endBulk.call(graphStore);
    });
    const resolved = offlineResolvedOrg(proj, "fixture");
    await liveIngest({
      alias: "fixture",
      graphStore,
      mode: "full",
      rebuild: true,
      preResolved: resolved,
      metadataSource: await FilesystemMetadataSource.fromProjectRoot(proj),
      logger: new ConsoleLogger("error"),
      skipSnapshot: true,
    });
    expect(del).toHaveBeenCalledTimes(0);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(begin).toHaveBeenCalledWith({ freshOrgId: resolved.orgId });
    expect(end).toHaveBeenCalledTimes(1);
    expect(statsAtEnd).not.toBeNull();
    const s = statsAtEnd as unknown as ReturnType<SqliteGraphStore["bulkStats"]>;
    expect(s.fresh).toBe(true);
    expect(s.ftsDeleteSkipped).toBeGreaterThan(0);
    expect(s.reconcileSkipped).toBeGreaterThan(0);
    expect(s.reconcileProbed).toBeGreaterThan(0); // the duplicate OrderHelper
    expect(graphStore.db.inTransaction).toBe(false);
    await graphStore.close();
  });

  it("fails the ingest loudly if SQLite rolls back the bulk transaction, and still closes the window", async () => {
    const graphStore = new SqliteGraphStore({
      dbPath: path.join(dir, "rb.sqlite"),
      backupDir: path.join(dir, "bk"),
    });
    await graphStore.init();
    const realDone = graphStore.bulkMemberDone.bind(graphStore);
    let calls = 0;
    vi.spyOn(graphStore, "bulkMemberDone").mockImplementation(() => {
      // Second member: simulate SQLITE_FULL rolling back the outer BEGIN.
      if (++calls === 2 && graphStore.db.inTransaction) graphStore.db.exec("ROLLBACK");
      realDone();
    });
    const end = vi.spyOn(graphStore, "endBulk");
    await expect(
      liveIngest({
        alias: "fixture",
        graphStore,
        mode: "full",
        rebuild: true,
        preResolved: offlineResolvedOrg(proj, "fixture"),
        metadataSource: await FilesystemMetadataSource.fromProjectRoot(proj),
        logger: new ConsoleLogger("error"),
        skipSnapshot: true,
      }),
    ).rejects.toThrow(/rolled back/);
    expect(end).toHaveBeenCalled();
    expect(graphStore.bulkStats().active).toBe(false);
    expect(graphStore.db.inTransaction).toBe(false);
    expect(graphStore.db.pragma("synchronous", { simple: true })).toBe(1);
    expect(graphStore.db.prepare("SELECT COUNT(*) AS n FROM _sfgraph_bulk_window").get()).toEqual({
      n: 0,
    });
    await graphStore.close();
  });

  it("SFGRAPH_DISABLE_FASTPATH=1 never enters bulk mode", async () => {
    process.env.SFGRAPH_DISABLE_FASTPATH = "1";
    const graphStore = new SqliteGraphStore({
      dbPath: ":memory:",
      backupDir: path.join(dir, "bk"),
    });
    await graphStore.init();
    const begin = vi.spyOn(graphStore, "beginBulk");
    await liveIngest({
      alias: "fixture",
      graphStore,
      mode: "full",
      rebuild: true,
      preResolved: offlineResolvedOrg(proj, "fixture"),
      metadataSource: await FilesystemMetadataSource.fromProjectRoot(proj),
      logger: new ConsoleLogger("error"),
      skipSnapshot: true,
    });
    expect(begin).not.toHaveBeenCalled();
    await graphStore.close();
  });
});
