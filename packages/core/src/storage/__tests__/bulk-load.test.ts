import { mkdtempSync, rmSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeFact, NodeFact, RelType } from "../../domain/index.js";
import { splitIdentifierWords } from "../../embedding/tokenize.js";
import { SqliteGraphStore } from "../sqlite/graph-store.js";

const ORG = asOrgId("org1");
let workDir: string;
let store: SqliteGraphStore;

beforeEach(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-bulk-"));
  store = new SqliteGraphStore({
    dbPath: path.join(workDir, "g.sqlite"),
    backupDir: path.join(workDir, "b"),
  });
  await store.init();
});
afterEach(async () => {
  await store.close();
  rmSync(workDir, { recursive: true, force: true });
});

function node(label: string, qname: string): NodeFact {
  return {
    orgId: ORG,
    qualifiedName: asQualifiedName(qname),
    label,
    attributes: { n: qname },
    sourceHash: asSha256("h"),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
}

function edge(rel: string, src: string, dst: string): EdgeFact {
  return {
    orgId: ORG,
    srcQualifiedName: asQualifiedName(src),
    dstQualifiedName: asQualifiedName(dst),
    relType: rel as RelType,
    attributes: {},
    firstSeenAt: 1,
    lastSeenAt: 1,
  };
}

function indexes(): Array<{ name: string; tbl: string; sql: string }> {
  return store.db
    .prepare(
      "SELECT name, tbl_name AS tbl, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name",
    )
    .all() as Array<{ name: string; tbl: string; sql: string }>;
}

describe("beginBulk / endBulk", () => {
  it("loads 5,000 edges and leaves every index with the same SQL as before", () => {
    // Pre-existing tables (and their secondary indexes) before the bulk window.
    store.mergeNodes([node("ApexClass", "ApexClass:Seed")]);
    store.mergeEdges([edge("CALLS", "ApexClass:Seed", "ApexClass:Other")]);
    const before = indexes();
    expect(before.some((i) => i.name.endsWith("_rev"))).toBe(true);

    store.beginBulk();
    // The graph tables' secondary indexes are really gone inside the window.
    const graphTbls = new Set(before.map((i) => i.tbl).filter((t) => /^_sfg_[ne]_/.test(t)));
    expect(graphTbls.size).toBeGreaterThan(0);
    expect(indexes().filter((i) => graphTbls.has(i.tbl))).toEqual([]);
    expect(store.db.pragma("synchronous", { simple: true })).toBe(0); // OFF
    expect(store.db.pragma("temp_store", { simple: true })).toBe(2); // MEMORY
    expect(String(store.db.pragma("journal_mode", { simple: true })).toLowerCase()).toBe("wal");
    const facts: EdgeFact[] = [];
    for (let i = 0; i < 5000; i++) {
      // CALLS already exists; READS_FIELD is a new edge table created mid-bulk.
      facts.push(edge(i % 2 ? "CALLS" : "READS_FIELD", `ApexClass:C${i % 97}`, `X:D${i}`));
    }
    for (let i = 0; i < facts.length; i += 250) {
      store.mergeEdges(facts.slice(i, i + 250));
      store.bulkMemberDone();
    }
    store.endBulk();

    expect(store.db.pragma("synchronous", { simple: true })).toBe(1); // NORMAL
    expect(store.db.inTransaction).toBe(false);
    const after = indexes();
    // Every pre-existing index is back, byte-identical.
    for (const b of before) expect(after).toContainEqual(b);
    // The table created during the bulk window got its reverse index too.
    const newTbl = store.getEdgeRelTables().get("READS_FIELD");
    expect(newTbl).toBeDefined();
    expect(after.find((i) => i.tbl === newTbl && i.name.endsWith("_rev"))?.sql).toBe(
      `CREATE INDEX ${newTbl}_rev ON ${newTbl}(org_id, dst_qname)`,
    );
    expect(store.countEdges(ORG)).toBe(5001);
  });

  it("commits one transaction per 2,000 members", () => {
    store.beginBulk();
    let commits = 0;
    const realExec = store.db.exec.bind(store.db);
    (store.db as unknown as { exec: (s: string) => unknown }).exec = (s: string) => {
      if (/^\s*COMMIT/i.test(s)) commits += 1;
      return realExec(s);
    };
    for (let i = 0; i < 4500; i++) {
      store.mergeNodes([node("ApexClass", `ApexClass:N${i}`)]);
      store.bulkMemberDone();
    }
    expect(commits).toBe(2);
    store.endBulk();
    expect(commits).toBe(3);
    (store.db as unknown as { exec: unknown }).exec = realExec;
    expect(store.countNodes(ORG)).toBe(4500);
  });

  it("endBulk is a no-op without beginBulk, and beginBulk is not re-entrant", () => {
    expect(() => store.endBulk()).not.toThrow();
    store.beginBulk();
    expect(() => store.beginBulk()).toThrow(/already/);
    store.endBulk();
  });

  it("fresh-org bulk skips reconcile probes for sources it has not written yet, and stays exact", async () => {
    // Member 1 emits A->x, A->y. Member 2 re-emits A with only A->x: the
    // reconcile pass must still prune A->y (A was written earlier in the run).
    // Member 3 is a case variant of A (NOCASE match → must be probed too).
    const seq: EdgeFact[][] = [
      [edge("CALLS", "ApexClass:A", "X:x"), edge("CALLS", "ApexClass:A", "X:y")],
      [edge("CALLS", "ApexClass:A", "X:x")],
      [edge("CALLS", "ApexClass:B", "X:x"), edge("CALLS", "ApexClass:B", "X:z")],
      [edge("CALLS", "ApexClass:b", "X:x")],
      [edge("CALLS", "ApexClass:C", "X:x")],
    ];
    const slow = new SqliteGraphStore({
      dbPath: path.join(workDir, "slow.sqlite"),
      backupDir: path.join(workDir, "b2"),
    });
    await slow.init();
    for (const batch of seq) slow.mergeEdges(batch, { reconcileSources: true });

    store.beginBulk({ freshOrgId: ORG });
    for (const batch of seq) store.mergeEdges(batch, { reconcileSources: true });
    const stats = store.bulkStats();
    store.endBulk();
    expect(stats.fresh).toBe(true);
    expect(stats.reconcileSkipped).toBe(3); // first A, first B, C
    expect(stats.reconcileProbed).toBe(2); // second A, case-variant b
    for (const q of ["ApexClass:A", "ApexClass:B", "ApexClass:C"]) {
      const dsts = (s: SqliteGraphStore) =>
        s
          .listEdgesFrom(ORG, asQualifiedName(q))
          .map((e) => `${e.srcQualifiedName}>${e.dstQualifiedName}`);
      expect(dsts(store)).toEqual(dsts(slow));
    }
    expect(
      store
        .listEdgesFrom(ORG, asQualifiedName("ApexClass:A"))
        .map((e) => String(e.dstQualifiedName)),
    ).toEqual(["X:x"]);
    await slow.close();
  });

  it("beginBulk({freshOrgId}) ignores the fresh hint when the org already has data", () => {
    store.mergeEdges([edge("CALLS", "ApexClass:A", "X:old")]);
    store.beginBulk({ freshOrgId: ORG });
    store.mergeEdges([edge("CALLS", "ApexClass:A", "X:new")], { reconcileSources: true });
    const stats = store.bulkStats();
    store.endBulk();
    expect(stats.fresh).toBe(false);
    expect(
      store
        .listEdgesFrom(ORG, asQualifiedName("ApexClass:A"))
        .map((e) => String(e.dstQualifiedName)),
    ).toEqual(["X:new"]);
  });
});

describe("node FTS rowid side table", () => {
  it("upsert deletes the prior row by rowid without scanning the FTS table", () => {
    const q = asQualifiedName("ApexClass:Foo");
    store.upsertNodeFts(ORG, q, "ApexClass", "alpha");
    store.upsertNodeFts(ORG, q, "ApexClass", "bravo");
    const rows = store.db
      .prepare("SELECT rowid AS r, qualified_name AS q FROM _sfgraph_node_fts")
      .all() as Array<{ r: number; q: string }>;
    expect(rows).toHaveLength(1);
    const map = store.db
      .prepare(
        "SELECT fts_rowid AS r FROM _sfgraph_node_fts_rowid WHERE org_id = ? AND qualified_name = ?",
      )
      .get(ORG, q) as { r: number };
    expect(map.r).toBe(rows[0]?.r);
    // The lookup the upsert relies on is an index probe, not a scan.
    const plan = store.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT fts_rowid FROM _sfgraph_node_fts_rowid WHERE org_id = ? AND qualified_name = ?",
      )
      .all("o", "q") as Array<{ detail: string }>;
    expect(plan.map((p) => p.detail).join(" ")).toMatch(/USING (PRIMARY KEY|INDEX|COVERING INDEX)/);
  });

  it("searchNodesFts results match the old DELETE-by-column implementation", () => {
    // Reference: the pre-Task-10 behaviour, replayed on a bare FTS5 table.
    const ref = new Database(":memory:");
    ref.exec(
      `CREATE VIRTUAL TABLE f USING fts5(qualified_name UNINDEXED, org_id UNINDEXED, label UNINDEXED, body, tokenize = 'unicode61 remove_diacritics 2');`,
    );
    const del = ref.prepare("DELETE FROM f WHERE org_id = ? AND qualified_name = ?");
    const ins = ref.prepare(
      "INSERT INTO f(qualified_name, org_id, label, body) VALUES (?, ?, ?, ?)",
    );
    const docs: Array<[string, string, string]> = [];
    for (let i = 0; i < 300; i++) {
      docs.push([
        `ApexClass:Svc${i % 120}`,
        "ApexClass",
        `account service ${i % 7} order ${i % 13} widget${i % 5}`,
      ]);
    }
    docs.push(["ApexClass:svc1", "ApexClass", "account lowercase twin"]); // case-distinct qname
    for (const [q, l, b] of docs) {
      del.run(ORG, q);
      ins.run(q, ORG, l, b);
      store.upsertNodeFts(ORG, asQualifiedName(q), l, b);
    }
    store.deleteNode(ORG, asQualifiedName("ApexClass:Svc3"));
    del.run(ORG, "ApexClass:Svc3");
    const refSearch = (query: string, k: number) =>
      ref
        .prepare(
          "SELECT qualified_name AS qname, label FROM f WHERE org_id = ? AND body MATCH ? ORDER BY bm25(f) LIMIT ?",
        )
        .all(
          ORG,
          [...new Set(splitIdentifierWords(query).map((t) => t.toLowerCase()))]
            .map((t) => `"${t}"`)
            .join(" OR "),
          k,
        );
    for (const query of ["account", "order 3", "widget2 service", "lowercase", "twin account"]) {
      expect(store.searchNodesFts(ORG, query, 25)).toEqual(refSearch(query, 25));
    }
    ref.close();
  });

  it("fresh-org bulk skips the FTS delete probe for first-seen qnames but still replaces repeats", () => {
    store.beginBulk({ freshOrgId: ORG });
    store.upsertNodeFts(ORG, asQualifiedName("ApexClass:A"), "ApexClass", "alpha");
    store.upsertNodeFts(ORG, asQualifiedName("ApexClass:B"), "ApexClass", "bravo");
    store.upsertNodeFts(ORG, asQualifiedName("ApexClass:A"), "ApexClass", "charlie");
    const stats = store.bulkStats();
    store.endBulk();
    expect(stats.ftsDeleteSkipped).toBe(2);
    expect(store.searchNodesFts(ORG, "alpha", 10)).toEqual([]);
    expect(store.searchNodesFts(ORG, "charlie", 10).map((h) => h.qname)).toEqual(["ApexClass:A"]);
  });
});

describe("bulk window failure handling", () => {
  function seed(): void {
    store.mergeNodes([node("ApexClass", "ApexClass:Seed")]);
    store.mergeEdges([edge("CALLS", "ApexClass:Seed", "ApexClass:Other")]);
  }

  async function reopen(): Promise<SqliteGraphStore> {
    const s = new SqliteGraphStore({
      dbPath: path.join(workDir, "g.sqlite"),
      backupDir: path.join(workDir, "b"),
    });
    await s.init();
    return s;
  }

  it("a crash between beginBulk and endBulk is healed on the next init: indexes back with identical SQL", async () => {
    seed();
    const before = indexes();
    // Non-batched window so the mid-window table (and its deferred index) is durable.
    store.beginBulk({ batchTransactions: false });
    store.mergeEdges([edge("READS_FIELD", "ApexClass:Seed", "CustomField:A.B")]);
    const newTbl = store.getEdgeRelTables().get("READS_FIELD") as string;
    expect(indexes().some((i) => i.tbl === newTbl)).toBe(false);
    // Simulated crash: the process dies, endBulk never runs.
    store.db.close();

    const s2 = await reopen();
    try {
      const after = s2.db
        .prepare(
          "SELECT name, tbl_name AS tbl, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name",
        )
        .all() as Array<{ name: string; tbl: string; sql: string }>;
      for (const b of before) expect(after).toContainEqual(b);
      expect(after.find((i) => i.tbl === newTbl && i.name.endsWith("_rev"))?.sql).toBe(
        `CREATE INDEX ${newTbl}_rev ON ${newTbl}(org_id, dst_qname)`,
      );
      expect(s2.db.pragma("synchronous", { simple: true })).toBe(1); // NORMAL
      expect(s2.countEdges(ORG)).toBe(2);
    } finally {
      await s2.close();
    }
  });

  it("a crash inside a batched window rolls back uncommitted members and still heals the indexes", async () => {
    seed();
    const before = indexes();
    store.beginBulk();
    store.mergeEdges([edge("CALLS", "ApexClass:Seed", "ApexClass:Lost")]);
    store.db.close(); // open BEGIN is rolled back by SQLite
    const s2 = await reopen();
    try {
      const after = s2.db
        .prepare(
          "SELECT name, tbl_name AS tbl, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name",
        )
        .all();
      for (const b of before) expect(after).toContainEqual(b);
      expect(s2.countEdges(ORG)).toBe(1);
    } finally {
      await s2.close();
    }
  });

  it("does not heal while another live process holds the bulk window", async () => {
    seed();
    store.beginBulk({ batchTransactions: false });
    // Pretend the window belongs to a different, still-running process.
    store.db.prepare("UPDATE _sfgraph_bulk_window SET pid = ?").run(process.ppid);
    const s2 = await reopen();
    try {
      const graphIdx = s2.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL AND tbl_name LIKE '\\_sfg\\_%' ESCAPE '\\'",
        )
        .all();
      expect(graphIdx).toEqual([]);
    } finally {
      await s2.close();
    }
    store.endBulk();
    expect(indexes().some((i) => i.name.endsWith("_rev"))).toBe(true);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM _sfgraph_bulk_window").get()).toEqual({
      n: 0,
    });
  });

  // Task 11c: the heal marker carries host + pid; only a dead pid on THIS host
  // (or our own pid) is stale. A marker from another host is never healed.
  const DEAD_PID = 4_194_000; // above the default pid_max on macOS and Linux
  function graphIndexes(s: SqliteGraphStore): unknown[] {
    return s.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL AND tbl_name LIKE '\\_sfg\\_%' ESCAPE '\\'",
      )
      .all();
  }

  it("heals a window whose owner is a dead pid on this host", async () => {
    seed();
    store.beginBulk({ batchTransactions: false });
    const row = store.db.prepare("SELECT host FROM _sfgraph_bulk_window").get() as {
      host: string;
    };
    expect(row.host).toBe(os.hostname());
    store.db.prepare("UPDATE _sfgraph_bulk_window SET pid = ?").run(DEAD_PID);
    store.db.close();
    const s2 = await reopen();
    try {
      expect(graphIndexes(s2).length).toBeGreaterThan(0);
      expect(s2.db.prepare("SELECT COUNT(*) AS n FROM _sfgraph_bulk_window").get()).toEqual({
        n: 0,
      });
    } finally {
      await s2.close();
    }
  });

  it("never heals a window owned by another host, even when that pid is dead here", async () => {
    seed();
    store.beginBulk({ batchTransactions: false });
    store.db
      .prepare("UPDATE _sfgraph_bulk_window SET pid = ?, host = ?")
      .run(DEAD_PID, "some-other-host.example");
    const s2 = await reopen();
    try {
      expect(graphIndexes(s2)).toEqual([]);
    } finally {
      await s2.close();
    }
    store.endBulk();
  });

  it("a failure part-way through beginBulk restores the dropped indexes and synchronous=NORMAL", () => {
    seed();
    const before = indexes();
    const realExec = store.db.exec.bind(store.db);
    let drops = 0;
    (store.db as unknown as { exec: (s: string) => unknown }).exec = (sql: string) => {
      if (/^\s*DROP INDEX/i.test(sql) && ++drops === 2) throw new Error("SQLITE_BUSY (simulated)");
      return realExec(sql);
    };
    try {
      expect(() => store.beginBulk()).toThrow(/SQLITE_BUSY/);
    } finally {
      (store.db as unknown as { exec: unknown }).exec = realExec;
    }
    expect(drops).toBe(2);
    expect(store.bulkStats().active).toBe(false);
    expect(indexes()).toEqual(before);
    expect(store.db.pragma("synchronous", { simple: true })).toBe(1);
  });

  it("endBulk restores synchronous=NORMAL even when the index rebuild throws", async () => {
    seed();
    store.beginBulk();
    const realExec = store.db.exec.bind(store.db);
    (store.db as unknown as { exec: (s: string) => unknown }).exec = (sql: string) => {
      if (/^\s*CREATE INDEX/i.test(sql)) throw new Error("SQLITE_FULL (simulated)");
      return realExec(sql);
    };
    try {
      expect(() => store.endBulk()).toThrow(/SQLITE_FULL/);
    } finally {
      (store.db as unknown as { exec: unknown }).exec = realExec;
    }
    expect(store.db.pragma("synchronous", { simple: true })).toBe(1);
    expect(store.db.inTransaction).toBe(false);
  });

  it("bulkMemberDone throws if SQLite rolled back the outer bulk transaction", () => {
    store.beginBulk();
    store.mergeNodes([node("ApexClass", "ApexClass:N1")]);
    store.db.exec("ROLLBACK"); // what SQLITE_FULL / IOERR / NOMEM do to the outer BEGIN
    expect(() => store.bulkMemberDone()).toThrow(/rolled back/);
    store.endBulk();
  });

  it("keeps existing indexes when other orgs already have rows in the shared tables", () => {
    seed(); // org1 data
    const before = indexes();
    store.beginBulk({ freshOrgId: asOrgId("org2") });
    const inWindow = indexes();
    store.mergeEdges([
      { ...edge("READS_FIELD", "ApexClass:X", "CustomField:A.B"), orgId: asOrgId("org2") },
    ]);
    const stats = store.bulkStats();
    store.endBulk();
    expect(stats.fresh).toBe(true);
    expect(inWindow).toEqual(before);
    const newTbl = store.getEdgeRelTables().get("READS_FIELD") as string;
    expect(indexes().some((i) => i.tbl === newTbl && i.name.endsWith("_rev"))).toBe(true);
  });
});

describe("endBulk index rebuild temp_store", () => {
  function seedAndBulk(): void {
    store.mergeNodes([node("ApexClass", "ApexClass:Seed")]);
    store.mergeEdges([edge("CALLS", "ApexClass:Seed", "ApexClass:Other")]);
    store.beginBulk();
    store.mergeEdges([edge("READS_FIELD", "ApexClass:Seed", "CustomField:A.B")]);
    store.bulkMemberDone();
  }

  /** Record temp_store at each CREATE INDEX; optionally fail the first one. */
  function watchCreateIndex(fail = false): { seen: number[]; restore: () => void } {
    const realExec = store.db.exec.bind(store.db);
    const seen: number[] = [];
    (store.db as unknown as { exec: (s: string) => unknown }).exec = (sql: string) => {
      if (/^\s*CREATE INDEX/i.test(sql)) {
        seen.push(Number(store.db.pragma("temp_store", { simple: true })));
        if (fail) throw new Error("SQLITE_FULL (simulated)");
      }
      return realExec(sql);
    };
    return {
      seen,
      restore: () => {
        (store.db as unknown as { exec: unknown }).exec = realExec;
      },
    };
  }

  it("rebuilds the deferred indexes with temp_store=FILE and restores MEMORY afterwards", () => {
    seedAndBulk();
    expect(store.db.pragma("temp_store", { simple: true })).toBe(2); // MEMORY
    const w = watchCreateIndex();
    try {
      store.endBulk();
    } finally {
      w.restore();
    }
    expect(w.seen.length).toBeGreaterThan(0);
    expect(new Set(w.seen)).toEqual(new Set([1])); // FILE
    expect(store.db.pragma("temp_store", { simple: true })).toBe(2);
    expect(store.db.pragma("synchronous", { simple: true })).toBe(1);
  });

  it("restores whatever temp_store was set before endBulk", () => {
    seedAndBulk();
    store.db.exec("COMMIT");
    store.db.pragma("temp_store = DEFAULT");
    store.db.exec("BEGIN");
    store.endBulk();
    expect(store.db.pragma("temp_store", { simple: true })).toBe(0);
  });

  it("inside an open transaction keeps temp_store and warns", () => {
    store.mergeNodes([node("ApexClass", "ApexClass:Seed")]);
    store.mergeEdges([edge("CALLS", "ApexClass:Seed", "ApexClass:Other")]);
    store.beginBulk({ batchTransactions: false });
    store.mergeEdges([edge("READS_FIELD", "ApexClass:Seed", "CustomField:A.B")]);
    store.db.exec("BEGIN"); // e.g. the pre-build COMMIT failed
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = watchCreateIndex();
    let calls: unknown[][];
    try {
      // Pre-existing: SQLite also refuses the synchronous=NORMAL restore
      // inside a transaction, so endBulk throws after building the indexes.
      expect(() => store.endBulk()).toThrow(/Safety level/);
      calls = [...warn.mock.calls];
    } finally {
      w.restore();
      warn.mockRestore(); // also clears mock.calls
    }
    expect(w.seen.length).toBeGreaterThan(0);
    expect(new Set(w.seen)).toEqual(new Set([2])); // stayed MEMORY
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.[0])).toMatch(/temp_store/);
    store.db.exec("COMMIT");
    expect(store.db.pragma("temp_store", { simple: true })).toBe(2);
  });

  it("restores temp_store even when the index rebuild throws", () => {
    seedAndBulk();
    const w = watchCreateIndex(true);
    try {
      expect(() => store.endBulk()).toThrow(/SQLITE_FULL/);
    } finally {
      w.restore();
    }
    expect(w.seen).toEqual([1]);
    expect(store.db.pragma("temp_store", { simple: true })).toBe(2);
    expect(store.db.inTransaction).toBe(false);
  });
});

describe("connection memory pragmas", () => {
  it("bounds the page cache and the mmap window", async () => {
    const { SQLITE_CACHE_SIZE_KIB, SQLITE_MMAP_SIZE_BYTES } = await import(
      "../sqlite/graph-store.js"
    );
    expect(SQLITE_CACHE_SIZE_KIB).toBe(64_000);
    expect(SQLITE_MMAP_SIZE_BYTES).toBe(64 * 1024 * 1024);
    expect(store.db.pragma("cache_size", { simple: true })).toBe(-SQLITE_CACHE_SIZE_KIB);
    expect(store.db.pragma("mmap_size", { simple: true })).toBe(SQLITE_MMAP_SIZE_BYTES);
  });
});
