import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ConsoleLogger } from "@ryanstark24/sfgraph-shared";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { FilesystemMetadataSource } from "../../extractors/filesystem/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { liveIngest } from "../live-ingest.js";
import { offlineResolvedOrg } from "../offline-org.js";

/**
 * Non-rebuild ingests group member writes into plain transactions
 * (store.beginBatch). The graph must be identical to the per-member path
 * (SFGRAPH_DISABLE_FASTPATH=1), a second connection must never see half of a
 * member, and a rollback by SQLite must fail the ingest.
 */

const GRAPH_DUMP = pathToFileURL(
  path.resolve(__dirname, "../../../../../bench/lib/graph-dump.mjs"),
).href;
type DumpLines = (dbPath: string, opts?: { includeSourceHash?: boolean }) => Iterable<string>;

const MD = "force-app/main/default";
let dir: string;
let proj: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-batch-"));
  proj = path.join(dir, "proj");
  writeFixture();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  // biome-ignore lint/performance/noDelete: env var must be truly unset
  delete process.env.SFGRAPH_DISABLE_FASTPATH;
  rmSync(dir, { recursive: true, force: true });
});

function w(rel: string, c: string): void {
  const abs = path.join(proj, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, c, "utf8");
}

function writeFixture(): void {
  w("sfdx-project.json", JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
  w(
    `${MD}/objects/Account/Account.object-meta.xml`,
    "<CustomObject><label>A</label></CustomObject>",
  );
  w(
    `${MD}/objects/Account/fields/Tier__c.field-meta.xml`,
    "<CustomField><fullName>Tier__c</fullName><type>Text</type></CustomField>",
  );
  for (let i = 0; i < 6; i++) {
    w(
      `${MD}/classes/Svc${i}.cls`,
      `public class Svc${i} {
         public static void run(String x) {
           List<Account> a = [SELECT Id, Tier__c FROM Account LIMIT 1];
           Svc${(i + 1) % 6}.run(x);
           update a;
         }
         public static void other() { System.debug('x'); }
       }`,
    );
  }
  w(
    `${MD}/triggers/AccountTrigger.trigger`,
    "trigger AccountTrigger on Account (before update) { Svc0.run('a'); }",
  );
}

/** Edit the tree: changed calls, a removed method, a removed class, a new class. */
function editFixture(): void {
  w(
    `${MD}/classes/Svc1.cls`,
    "public class Svc1 { public static void run(String x) { Svc4.run(x); Svc5.other(); } }",
  );
  w(`${MD}/classes/Svc2.cls`, "public class Svc2 { public static void run(String x) { } }");
  rmSync(path.join(proj, `${MD}/classes/Svc3.cls`));
  w(
    `${MD}/classes/NewSvc.cls`,
    "public class NewSvc { public static void go() { Svc0.run('n'); insert new Account(); } }",
  );
}

async function open(name: string): Promise<SqliteGraphStore> {
  const s = new SqliteGraphStore({
    dbPath: path.join(dir, `${name}.sqlite`),
    backupDir: path.join(dir, "bk"),
  });
  await s.init();
  return s;
}

function ingest(store: SqliteGraphStore, rebuild: boolean): ReturnType<typeof liveIngest> {
  return liveIngest({
    alias: "fixture",
    graphStore: store,
    mode: "full",
    rebuild,
    preResolved: offlineResolvedOrg(proj, "fixture"),
    metadataSource: FilesystemMetadataSource.fromProjectRoot(proj),
    logger: new ConsoleLogger("error"),
    skipSnapshot: true,
    analysisDb: store.db,
    parsePool: { workers: 0 },
  });
}

function ftsRows(store: SqliteGraphStore): unknown[] {
  return store.db
    .prepare("SELECT rowid, qualified_name, label, body FROM _sfgraph_node_fts ORDER BY rowid")
    .all();
}

describe("batched writes on non-rebuild ingests", () => {
  it("produces the same graph as per-member commits", async () => {
    const { dumpLines } = (await import(GRAPH_DUMP)) as { dumpLines: DumpLines };
    const slow = await open("slow");
    const fast = await open("fast");
    await ingest(slow, true);
    await ingest(fast, true);
    editFixture();

    process.env.SFGRAPH_DISABLE_FASTPATH = "1";
    const slowBegin = vi.spyOn(slow, "beginBatch");
    await ingest(slow, false);
    expect(slowBegin).not.toHaveBeenCalled();
    // biome-ignore lint/performance/noDelete: env var must be truly unset
    delete process.env.SFGRAPH_DISABLE_FASTPATH;

    const fastBegin = vi.spyOn(fast, "beginBatch");
    const fastEnd = vi.spyOn(fast, "endBatch");
    let members = 0;
    fastEnd.mockImplementation(() => {
      members = fast.batchStats().members;
      SqliteGraphStore.prototype.endBatch.call(fast);
    });
    await ingest(fast, false);
    expect(fastBegin).toHaveBeenCalledTimes(1);
    expect(fastEnd).toHaveBeenCalled();
    expect(members).toBeGreaterThan(5);
    expect(fast.db.inTransaction).toBe(false);

    expect(ftsRows(fast)).toEqual(ftsRows(slow));
    await slow.close();
    await fast.close();
    const a = [...dumpLines(path.join(dir, "slow.sqlite"), { includeSourceHash: true })];
    const b = [...dumpLines(path.join(dir, "fast.sqlite"), { includeSourceHash: true })];
    expect(a.length).toBeGreaterThan(20);
    expect(b).toEqual(a);
  });

  it("never shows a reader on another connection half of a member", async () => {
    const store = await open("g");
    const reader = new Database(path.join(dir, "g.sqlite"), { readonly: true });
    const visible = reader.prepare(
      "SELECT 1 FROM _sfgraph_node_index WHERE qualified_name = ? COLLATE NOCASE",
    );
    let lastNodes: NodeFact[] = [];
    let checked = 0;
    const realNodes = store.mergeNodes.bind(store);
    vi.spyOn(store, "mergeNodes").mockImplementation((facts: NodeFact[]) => {
      const r = realNodes(facts);
      lastNodes = facts;
      return r;
    });
    const realEdges = store.mergeEdges.bind(store);
    vi.spyOn(store, "mergeEdges").mockImplementation((facts: EdgeFact[], o) => {
      // Mid-member: its nodes are written, its edges not yet. The reader
      // must not see the nodes before the member is committed whole.
      if (store.batchStats().active) {
        for (const n of lastNodes) {
          expect(visible.get(String(n.qualifiedName))).toBeUndefined();
          checked += 1;
        }
      }
      return realEdges(facts, o);
    });
    // An empty graph with rebuild: false takes the batch path, so every node
    // is new and must stay invisible until its member commits.
    await ingest(store, false);
    expect(checked).toBeGreaterThan(5);
    expect(visible.get("ApexClass:Svc0")).toEqual({ 1: 1 });
    reader.close();
    await store.close();
  });

  it("fails the ingest loudly if SQLite rolls back the batch transaction", async () => {
    const store = await open("rb");
    await ingest(store, true);
    editFixture();
    const realDone = store.batchMemberDone.bind(store);
    let calls = 0;
    vi.spyOn(store, "batchMemberDone").mockImplementation(() => {
      if (++calls === 2 && store.db.inTransaction) store.db.exec("ROLLBACK");
      realDone();
    });
    await expect(ingest(store, false)).rejects.toThrow(/rolled back/);
    expect(store.batchStats().active).toBe(false);
    expect(store.db.inTransaction).toBe(false);
    await store.close();
  });

  it("keeps per-member commits when the vector store has its own connection", async () => {
    const store = await open("vec");
    await ingest(store, true);
    const begin = vi.spyOn(store, "beginBatch");
    const other = new Database(":memory:");
    await liveIngest({
      alias: "fixture",
      graphStore: store,
      mode: "full",
      rebuild: false,
      preResolved: offlineResolvedOrg(proj, "fixture"),
      metadataSource: FilesystemMetadataSource.fromProjectRoot(proj),
      logger: new ConsoleLogger("error"),
      skipSnapshot: true,
      parsePool: { workers: 0 },
      vectorStore: {
        db: other,
        upsertNodeVector() {},
        deleteNodeVector() {},
      } as never,
      embedder: { embed: async (t: string[]) => t.map(() => new Float32Array(4)) } as never,
    });
    expect(begin).not.toHaveBeenCalled();
    other.close();
    await store.close();
  });
});

describe("SqliteGraphStore batch window", () => {
  it("commits an idle open batch after maxMs, so other connections can write", async () => {
    const store = await open("idle");
    store.upsertOrg({
      id: "00D000000000001" as never,
      alias: "a",
      instanceUrl: "x",
      apiVersion: "60.0",
      createdAt: 1,
    });
    store.beginBatch({ maxMembers: 1000, maxMs: 20 });
    store.batchMemberStart();
    store.touchSync("00D000000000001" as never, new Date(5000).toISOString());
    store.batchMemberDone();
    expect(store.db.inTransaction).toBe(true);
    const other = new Database(path.join(dir, "idle.sqlite"));
    const read = () =>
      other.prepare("SELECT last_synced_at AS t FROM _sfgraph_orgs").get() as { t: number | null };
    expect(read().t).toBeNull();
    await new Promise((r) => setTimeout(r, 80));
    expect(store.db.inTransaction).toBe(false);
    expect(read().t).toBe(5000);
    other.exec("UPDATE _sfgraph_orgs SET alias = 'b'");
    // The next member opens a new transaction; endBatch commits it.
    store.batchMemberStart();
    expect(store.db.inTransaction).toBe(true);
    store.batchMemberDone();
    store.endBatch();
    expect(store.db.inTransaction).toBe(false);
    expect(store.batchStats().active).toBe(false);
    other.close();
    await store.close();
  });

  it("refuses to nest with the bulk window", async () => {
    const store = await open("nest");
    store.beginBatch();
    expect(() => store.beginBulk()).toThrow(/batch window/);
    expect(() => store.beginBatch()).toThrow(/already open/);
    store.endBatch();
    await store.close();
  });
});
