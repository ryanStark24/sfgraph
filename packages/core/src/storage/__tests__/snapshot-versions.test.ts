import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeFact, NodeFact, RelType } from "../../domain/index.js";
import { SqliteGraphStore } from "../sqlite/graph-store.js";
import { MIGRATIONS, MigrationRunner } from "../sqlite/migrations.js";
import { SqliteSnapshotStore } from "../sqlite/snapshot-store.js";

// audit perf-02/03: versioned snapshots must read back exactly what a full
// copy taken at the same moment held (apart from last_seen_at, documented),
// diffs must equal the old in-JS map diff, and only differing rows may be
// materialised in JS.

const ORG = asOrgId("org1");
const OTHER = asOrgId("org2");
let workDir: string;
let graph: SqliteGraphStore;
let snap: SqliteSnapshotStore;

beforeEach(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-snapver-"));
  const dbPath = path.join(workDir, "s.sqlite");
  graph = new SqliteGraphStore({ dbPath, backupDir: path.join(workDir, "bkp") });
  await graph.init();
  snap = new SqliteSnapshotStore({ dbPath, db: graph.db, skipMigrations: true });
  await snap.init();
});
afterEach(async () => {
  await graph.close();
  rmSync(workDir, { recursive: true, force: true });
});

function n(org: string, label: string, qname: string, hash: string, t = 1, attrs = {}): NodeFact {
  return {
    orgId: asOrgId(org),
    qualifiedName: asQualifiedName(qname),
    label,
    attributes: attrs,
    sourceHash: asSha256(hash),
    firstSeenAt: 1,
    lastSeenAt: t,
    lastModifiedAt: t,
  };
}
function e(org: string, rt: string, src: string, dst: string, attrs = {}): EdgeFact {
  return {
    orgId: asOrgId(org),
    srcQualifiedName: asQualifiedName(src),
    dstQualifiedName: asQualifiedName(dst),
    relType: rt as RelType,
    attributes: attrs,
    firstSeenAt: 1,
    lastSeenAt: 1,
  };
}

type Copy = { nodes: Map<string, string>; edges: Map<string, string> };
/** What the old full-copy snapshot would have held (minus last_seen_at). */
function fullCopy(org: string): Copy {
  const nodes = new Map<string, string>();
  const edges = new Map<string, string>();
  const labels = graph.db
    .prepare("SELECT label, table_name FROM _sfgraph_node_labels")
    .all() as Array<{ label: string; table_name: string }>;
  for (const { label, table_name } of labels) {
    for (const r of graph.db
      .prepare(`SELECT * FROM ${table_name} WHERE org_id = ?`)
      .all(org) as Array<Record<string, unknown>>) {
      nodes.set(
        String(r.qualified_name),
        JSON.stringify([label, r.attributes, r.source_hash, r.first_seen_at, r.last_modified_at]),
      );
    }
  }
  const rels = graph.db
    .prepare("SELECT rel_type, table_name FROM _sfgraph_edge_types")
    .all() as Array<{ rel_type: string; table_name: string }>;
  for (const { rel_type, table_name } of rels) {
    for (const r of graph.db
      .prepare(`SELECT * FROM ${table_name} WHERE org_id = ?`)
      .all(org) as Array<Record<string, unknown>>) {
      edges.set(
        `${r.src_qname}|${r.dst_qname}|${rel_type}`,
        JSON.stringify([r.attributes, r.first_seen_at]),
      );
    }
  }
  return { nodes, edges };
}
/** Read a snapshot back through the compatibility views. */
function viewCopy(id: string, org: string): Copy {
  const nodes = new Map<string, string>();
  const edges = new Map<string, string>();
  for (const r of graph.db
    .prepare("SELECT * FROM _sfgraph_node_snapshots WHERE snapshot_id = ? AND org_id = ?")
    .all(id, org) as Array<Record<string, unknown>>) {
    expect(nodes.has(String(r.qualified_name))).toBe(false);
    nodes.set(
      String(r.qualified_name),
      JSON.stringify([r.label, r.attributes, r.source_hash, r.first_seen_at, r.last_modified_at]),
    );
  }
  for (const r of graph.db
    .prepare("SELECT * FROM _sfgraph_edge_snapshots WHERE snapshot_id = ? AND org_id = ?")
    .all(id, org) as Array<Record<string, unknown>>) {
    const k = `${r.src_qname}|${r.dst_qname}|${r.rel_type}`;
    expect(edges.has(k)).toBe(false);
    edges.set(k, JSON.stringify([r.attributes, r.first_seen_at]));
  }
  return { nodes, edges };
}
/** The old in-JS diff over two copies (keys only + source hash). */
function refDiff(a: Copy, b: Copy) {
  const hash = (v: string) => JSON.parse(v)[2];
  const added = [...b.nodes.keys()].filter((k) => !a.nodes.has(k)).sort();
  const removed = [...a.nodes.keys()].filter((k) => !b.nodes.has(k)).sort();
  const changed = [...b.nodes.keys()]
    .filter(
      (k) => a.nodes.has(k) && hash(a.nodes.get(k) as string) !== hash(b.nodes.get(k) as string),
    )
    .sort();
  const eAdded = [...b.edges.keys()].filter((k) => !a.edges.has(k)).sort();
  const eRemoved = [...a.edges.keys()].filter((k) => !b.edges.has(k)).sort();
  return { added, removed, changed, eAdded, eRemoved };
}
function realDiff(org: string, from: string, to: string) {
  const nd = snap.diffNodes(asOrgId(org), from, to);
  const ed = snap.diffEdges(asOrgId(org), from, to);
  const ek = (x: EdgeFact) => `${x.srcQualifiedName}|${x.dstQualifiedName}|${x.relType}`;
  return {
    added: nd.added.map((x) => x.qualifiedName as string).sort(),
    removed: nd.removed.map((x) => x.qualifiedName as string).sort(),
    changed: nd.changed.map((x) => x.after.qualifiedName as string).sort(),
    eAdded: ed.added.map(ek).sort(),
    eRemoved: ed.removed.map(ek).sort(),
  };
}

describe("versioned snapshots (perf-02/03)", () => {
  it("read back and diff exactly like full copies across edits, label moves, deletes and snapshot deletion", () => {
    const ids: string[] = [];
    const copies = new Map<string, Copy>();
    const take = (label: string, isAuto = false) => {
      const s = snap.createSnapshot(ORG, label, isAuto);
      ids.push(s.id);
      copies.set(s.id, fullCopy(ORG));
      return s.id;
    };
    // Another org shares the tables and must never leak in.
    graph.mergeNodes([n("org2", "ApexClass", "Foo", "zz"), n("org2", "ApexClass", "Other", "zz")]);
    graph.mergeEdges([e("org2", "CALLS", "Foo", "Other")]);
    snap.createSnapshot(OTHER, "o1", false);

    graph.mergeNodes([
      n("org1", "ApexClass", "Foo", "h1"),
      n("org1", "ApexClass", "Bar", "h1"),
      n("org1", "ApexTrigger", "Trg", "h1"),
    ]);
    graph.mergeEdges([e("org1", "CALLS", "Foo", "Bar"), e("org1", "CALLS", "Bar", "Foo")]);
    take("s1");
    // Unchanged re-merge (bumps last_seen_at only): no new versions.
    const before = (
      graph.db.prepare("SELECT COUNT(*) AS c FROM _sfgraph_snap_nodes").get() as { c: number }
    ).c;
    graph.mergeNodes([
      n("org1", "ApexClass", "Foo", "h1", 9),
      n("org1", "ApexClass", "Bar", "h1", 9),
    ]);
    take("s2");
    expect(
      (graph.db.prepare("SELECT COUNT(*) AS c FROM _sfgraph_snap_nodes").get() as { c: number }).c,
    ).toBe(before);
    // Edit, add, delete, label move, attribute-only change, edge churn.
    graph.mergeNodes([n("org1", "ApexClass", "Foo", "h2", 10), n("org1", "Flow", "Baz", "h1", 10)]);
    graph.deleteNode(ORG, asQualifiedName("Trg"));
    graph.mergeNodes([n("org1", "Flow", "Bar", "h3", 10)]);
    graph.deleteEdge(ORG, asQualifiedName("Bar"), asQualifiedName("Foo"), "CALLS" as RelType);
    graph.mergeEdges([e("org1", "USES_FIELD", "Foo", "Acc.Name", { w: 1 })]);
    take("s3");
    graph.mergeNodes([n("org1", "ApexTrigger", "Trg", "h9", 11)]);
    graph.mergeEdges([e("org1", "CALLS", "Bar", "Foo")]);
    take("s4", true);

    const check = () => {
      for (const id of ids) expect(viewCopy(id, "org1")).toEqual(copies.get(id));
      const cur = fullCopy(ORG);
      for (const a of ids) {
        expect(realDiff("org1", a, "current")).toEqual(refDiff(copies.get(a) as Copy, cur));
        expect(realDiff("org1", "current", a)).toEqual(refDiff(cur, copies.get(a) as Copy));
        for (const b of ids)
          expect(realDiff("org1", a, b)).toEqual(
            refDiff(copies.get(a) as Copy, copies.get(b) as Copy),
          );
      }
      expect(realDiff("org1", "current", "current")).toEqual(refDiff(cur, cur));
    };
    check();
    // Delete a middle snapshot, then the latest; then keep going.
    snap.deleteSnapshot(ids.splice(1, 1)[0] as string);
    check();
    snap.deleteSnapshot(ids.pop() as string);
    check();
    graph.mergeNodes([n("org1", "ApexClass", "Foo", "h7", 12)]);
    take("s5");
    check();
    // The other org is untouched and a cross-org diff side reads as empty.
    expect(realDiff("org2", ids[0] as string, "current").removed).toEqual([]);
    expect(
      snap
        .diffNodes(OTHER, ids[0] as string, "current")
        .added.map((x) => x.qualifiedName)
        .sort(),
    ).toEqual(["Foo", "Other"]);
    // Deleting every snapshot of the org leaves no versions behind for it.
    for (const id of [...ids]) snap.deleteSnapshot(id);
    expect(
      (
        graph.db
          .prepare("SELECT COUNT(*) AS c FROM _sfgraph_snap_nodes WHERE org_id = 'org1'")
          .get() as { c: number }
      ).c,
    ).toBe(0);
    expect(
      (
        graph.db
          .prepare("SELECT COUNT(*) AS c FROM _sfgraph_snap_edges WHERE org_id = 'org1'")
          .get() as { c: number }
      ).c,
    ).toBe(0);
    expect(
      (
        graph.db
          .prepare("SELECT COUNT(*) AS c FROM _sfgraph_snap_nodes WHERE org_id = 'org2'")
          .get() as { c: number }
      ).c,
    ).toBe(2);
  });

  it("a diff of a large unchanged graph materialises only O(1) rows in JS", () => {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    for (let i = 0; i < 2000; i++) {
      nodes.push(n("org1", i % 2 ? "ApexClass" : "Flow", `Q${i}`, "h"));
      edges.push(e("org1", "CALLS", `Q${i}`, `Q${(i + 1) % 2000}`));
    }
    graph.mergeNodes(nodes);
    graph.mergeEdges(edges);
    const s = snap.createSnapshot(ORG, "v1", false);
    graph.mergeNodes([n("org1", "Flow", "Q0", "changed")]);
    const proto = Object.getPrototypeOf(graph.db.prepare("SELECT 1")) as Record<string, unknown>;
    const all = vi.spyOn(proto as { all: (...a: unknown[]) => unknown[] }, "all");
    const get = vi.spyOn(proto as { get: (...a: unknown[]) => unknown }, "get");
    const iter = vi.spyOn(proto as { iterate: (...a: unknown[]) => unknown }, "iterate");
    const nd = snap.diffNodes(ORG, s.id, "current");
    const ed = snap.diffEdges(ORG, s.id, "current");
    const rows =
      all.mock.results.reduce((acc, r) => acc + (Array.isArray(r.value) ? r.value.length : 0), 0) +
      get.mock.results.filter((r) => r.value !== undefined).length;
    const iterCalls = iter.mock.calls.length;
    all.mockRestore();
    get.mockRestore();
    iter.mockRestore();
    expect(nd.changed.map((c) => c.after.qualifiedName)).toEqual(["Q0"]);
    expect(nd.added.length + nd.removed.length + ed.added.length + ed.removed.length).toBe(0);
    expect(iterCalls).toBe(0);
    // Registry rows + the one changed pair; 4000 rows per side before the fix.
    expect(rows).toBeLessThan(20);
  });
});

describe("migration v14 converts full-copy snapshots", () => {
  it("keeps every legacy snapshot readable and diffable, then replaces the tables with views", () => {
    const dbPath = path.join(workDir, "legacy.sqlite");
    const db = new Database(dbPath);
    const backupDir = path.join(workDir, "legacy-bkp");
    new MigrationRunner(
      db,
      MIGRATIONS.filter((m) => m.version <= 13),
      { backupDir, retainBackups: 5 },
    ).applyPending();
    const ins = db.prepare(
      "INSERT INTO _sfgraph_snapshots(id, org_id, label, created_at, is_auto) VALUES (?, ?, ?, ?, 0)",
    );
    const insN = db.prepare(
      "INSERT INTO _sfgraph_node_snapshots VALUES (?, ?, ?, ?, ?, ?, 1, ?, 1)",
    );
    const insE = db.prepare(
      "INSERT INTO _sfgraph_edge_snapshots VALUES (?, ?, ?, ?, ?, '{}', 1, 1)",
    );
    // created_at order differs from insertion order on purpose.
    ins.run("snap_b", "org1", "b", 200);
    ins.run("snap_a", "org1", "a", 100);
    ins.run("snap_x", "org2", "x", 150);
    for (const [q, h] of [
      ["Foo", "h1"],
      ["Bar", "h1"],
    ])
      insN.run("snap_a", "org1", q, "ApexClass", "{}", h, 5);
    for (const [q, h] of [
      ["Foo", "h2"],
      ["Baz", "h1"],
    ])
      insN.run("snap_b", "org1", q, "ApexClass", "{}", h, 7);
    insN.run("snap_x", "org2", "Foo", "ApexClass", "{}", "zz", 3);
    insE.run("snap_a", "org1", "Foo", "Bar", "CALLS");
    insE.run("snap_b", "org1", "Foo", "Baz", "CALLS");
    const legacyNodes = db
      .prepare("SELECT * FROM _sfgraph_node_snapshots ORDER BY snapshot_id, qualified_name")
      .all();
    const legacyEdges = db
      .prepare("SELECT * FROM _sfgraph_edge_snapshots ORDER BY snapshot_id, src_qname, dst_qname")
      .all();
    new MigrationRunner(db, MIGRATIONS, { backupDir, retainBackups: 5 }).applyPending();
    const kinds = db
      .prepare(
        "SELECT name, type FROM sqlite_master WHERE name IN ('_sfgraph_node_snapshots', '_sfgraph_edge_snapshots') ORDER BY name",
      )
      .all();
    expect(kinds).toEqual([
      { name: "_sfgraph_edge_snapshots", type: "view" },
      { name: "_sfgraph_node_snapshots", type: "view" },
    ]);
    expect(
      db
        .prepare("SELECT * FROM _sfgraph_node_snapshots ORDER BY snapshot_id, qualified_name")
        .all(),
    ).toEqual(legacyNodes);
    expect(
      db
        .prepare("SELECT * FROM _sfgraph_edge_snapshots ORDER BY snapshot_id, src_qname, dst_qname")
        .all(),
    ).toEqual(legacyEdges);
    const store = new SqliteSnapshotStore({ dbPath, db, skipMigrations: true });
    const d = store.diffNodes(ORG, "snap_a", "snap_b");
    expect(d.added.map((x) => x.qualifiedName)).toEqual(["Baz"]);
    expect(d.removed.map((x) => x.qualifiedName)).toEqual(["Bar"]);
    expect(d.changed.map((x) => [x.before.sourceHash, x.after.sourceHash])).toEqual([["h1", "h2"]]);
    db.close();
  });
});

// review C1: the open-version probe must use the key index; scanning the
// label's whole version history made an unchanged snapshot of one big label
// quadratic (25k nodes: ~24 s).
describe("versioned snapshots scale with label size (review C1)", () => {
  it("an unchanged snapshot of 20k nodes in one label, after 2 prior snapshots, is fast", () => {
    const N = 20_000;
    const nodes: NodeFact[] = [];
    for (let i = 0; i < N; i++) nodes.push(n("org1", "CustomField", `Account.F${i}__c`, "h", 1));
    graph.mergeNodes(nodes);
    snap.createSnapshot(ORG, "s1", true);
    // Change 10% so closed history accumulates in the label.
    graph.mergeNodes(nodes.slice(0, N / 10).map((x) => ({ ...x, sourceHash: asSha256("h2") })));
    snap.createSnapshot(ORG, "s2", true);
    const t0 = performance.now();
    snap.createSnapshot(ORG, "s3", true);
    const ms = performance.now() - t0;
    const rows = (
      graph.db.prepare("SELECT COUNT(*) AS c FROM _sfgraph_snap_nodes").get() as { c: number }
    ).c;
    expect(rows).toBe(N + N / 10);
    // Linear work is ~100 ms here; the quadratic probe took tens of seconds.
    expect(ms).toBeLessThan(3000);
  }, 120_000);
});

describe("open-version probes use the key indexes (review C1)", () => {
  it("node and edge NOT EXISTS probes search the key index, not the label/rel index", () => {
    const plan = (sql: string) =>
      (graph.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all({}) as Array<{ detail: string }>)
        .map((r) => r.detail)
        .join("\n");
    const nodes = plan(
      `SELECT 1 FROM _sfgraph_snap_nodes w WHERE w.org_id = 'o' AND w.qualified_name = 'q'
         AND w.label = 'L' AND w.to_seq IS NULL`,
    );
    expect(nodes).toMatch(
      /_sfgraph_snap_nodes_key \(org_id=\? AND qualified_name=\? AND label=\? AND to_seq=\?\)/,
    );
    const edges = plan(
      `SELECT 1 FROM _sfgraph_snap_edges w WHERE w.org_id = 'o' AND w.src_qname = 's'
         AND w.dst_qname = 'd' AND w.rel_type = 'R' AND w.to_seq IS NULL`,
    );
    expect(edges).toMatch(
      /_sfgraph_snap_edges_key \(org_id=\? AND src_qname=\? AND dst_qname=\? AND rel_type=\? AND to_seq=\?\)/,
    );
  });
});

// review I6: diff output order is explicit and stable, and last_seen_at is
// not part of a version (documented): a re-merge that only bumps it is not a
// change, and a snapshot reports the value its version was first recorded with.
describe("review I6: deterministic diff order, last_seen_at semantics", () => {
  const seen = (label: string, qname: string, hash: string, lastSeenAt: number): NodeFact => ({
    ...n("org1", label, qname, hash),
    lastSeenAt,
  });
  const qn = (xs: NodeFact[]) => xs.map((x) => `${x.qualifiedName}/${x.label}`);
  const ek = (xs: EdgeFact[]) =>
    xs.map((x) => `${x.srcQualifiedName}>${x.dstQualifiedName}>${x.relType}`);

  it("orders every diff bucket by key across label / rel tables, with varying last_seen_at", () => {
    const s0 = snap.createSnapshot(ORG, "empty", true);
    // Tables created in reverse key order so per-table concatenation is unsorted.
    graph.mergeNodes([seen("Zed", "B2", "h", 7), seen("Zed", "A2", "h", 3)]);
    graph.mergeNodes([seen("Alpha", "B1", "h", 11), seen("Alpha", "A1", "h", 2)]);
    graph.mergeEdges([
      e("org1", "WRITES_FIELD", "A2", "x"),
      e("org1", "CALLS", "A1", "y"),
      e("org1", "CALLS", "A1", "b"),
    ]);
    const s1 = snap.createSnapshot(ORG, "s1", true);
    const sorted = ["A1/Alpha", "A2/Zed", "B1/Alpha", "B2/Zed"];
    const esorted = ["A1>b>CALLS", "A1>y>CALLS", "A2>x>WRITES_FIELD"];
    expect(qn(snap.diffNodes(ORG, s0.id, "current").added)).toEqual(sorted);
    expect(qn(snap.diffNodes(ORG, "current", s0.id).removed)).toEqual(sorted);
    expect(qn(snap.diffNodes(ORG, s0.id, s1.id).added)).toEqual(sorted);
    expect(qn(snap.diffNodes(ORG, s1.id, s0.id).removed)).toEqual(sorted);
    expect(ek(snap.diffEdges(ORG, s0.id, "current").added)).toEqual(esorted);
    expect(ek(snap.diffEdges(ORG, s1.id, s0.id).removed)).toEqual(esorted);

    // Re-merge with only last_seen_at bumped: not a change.
    graph.mergeNodes([
      seen("Zed", "B2", "h", 70),
      seen("Zed", "A2", "h", 30),
      seen("Alpha", "B1", "h", 110),
      seen("Alpha", "A1", "h", 20),
    ]);
    const s2 = snap.createSnapshot(ORG, "s2", true);
    const d12 = snap.diffNodes(ORG, s1.id, s2.id);
    expect(d12.added.length + d12.removed.length + d12.changed.length).toBe(0);
    // s2 reports the last_seen_at of the version opened at s1.
    const view = graph.db
      .prepare(
        "SELECT qualified_name AS q, last_seen_at AS l FROM _sfgraph_node_snapshots WHERE snapshot_id = ? ORDER BY q",
      )
      .all(s2.id);
    expect(view).toEqual([
      { q: "A1", l: 2 },
      { q: "A2", l: 3 },
      { q: "B1", l: 11 },
      { q: "B2", l: 7 },
    ]);

    // Changed pairs, in key order, against a snapshot and between snapshots.
    graph.mergeNodes([seen("Zed", "B2", "h2", 80), seen("Alpha", "A1", "h2", 1)]);
    const s3 = snap.createSnapshot(ORG, "s3", true);
    const ch = (d: { changed: Array<{ before: NodeFact }> }) =>
      d.changed.map((c) => String(c.before.qualifiedName));
    expect(ch(snap.diffNodes(ORG, s2.id, "current"))).toEqual(["A1", "B2"]);
    expect(ch(snap.diffNodes(ORG, "current", s2.id))).toEqual(["A1", "B2"]);
    expect(ch(snap.diffNodes(ORG, s2.id, s3.id))).toEqual(["A1", "B2"]);
  });

  it("a legacy migration with varying last_seen_at keeps every other column and diffs the same", () => {
    const dbPath = path.join(workDir, "legacy-ls.sqlite");
    const db = new Database(dbPath);
    new MigrationRunner(
      db,
      MIGRATIONS.filter((m) => m.version <= 13),
      { backupDir: path.join(workDir, "lb"), retainBackups: 5 },
    ).applyPending();
    db.prepare(
      "INSERT INTO _sfgraph_snapshots(id, org_id, label, created_at, is_auto) VALUES ('a', 'org1', 'a', 1, 0), ('b', 'org1', 'b', 2, 0)",
    ).run();
    const insN = db.prepare(
      "INSERT INTO _sfgraph_node_snapshots VALUES (?, 'org1', ?, 'ApexClass', '{}', 'h1', 1, ?, 1)",
    );
    insN.run("a", "Foo", 10);
    insN.run("b", "Foo", 20);
    insN.run("b", "Bar", 30);
    const cols =
      "snapshot_id, qualified_name, label, attributes, source_hash, first_seen_at, last_modified_at";
    const before = db
      .prepare(`SELECT ${cols} FROM _sfgraph_node_snapshots ORDER BY snapshot_id, qualified_name`)
      .all();
    new MigrationRunner(db, MIGRATIONS, {
      backupDir: path.join(workDir, "lb"),
      retainBackups: 5,
    }).applyPending();
    expect(
      db
        .prepare(`SELECT ${cols} FROM _sfgraph_node_snapshots ORDER BY snapshot_id, qualified_name`)
        .all(),
    ).toEqual(before);
    // Documented change: b's unchanged Foo reports the value recorded at a.
    expect(
      db
        .prepare(
          "SELECT qualified_name AS q, last_seen_at AS l FROM _sfgraph_node_snapshots WHERE snapshot_id = 'b' ORDER BY q",
        )
        .all(),
    ).toEqual([
      { q: "Bar", l: 30 },
      { q: "Foo", l: 10 },
    ]);
    const store = new SqliteSnapshotStore({ dbPath, db, skipMigrations: true });
    const d = store.diffNodes(ORG, "a", "b");
    expect(d.added.map((x) => String(x.qualifiedName))).toEqual(["Bar"]);
    expect(d.changed).toEqual([]);
    db.close();
  });
});

describe("review minor 1: snapshot writes take the write lock up front", () => {
  it("createSnapshot and deleteSnapshot run their transactions with BEGIN IMMEDIATE", () => {
    graph.mergeNodes([n("org1", "ApexClass", "ApexClass:A", "h1")]);
    const variants: string[] = [];
    const db = graph.db as unknown as { transaction: (fn: () => unknown) => unknown };
    const orig = db.transaction.bind(db);
    const spy = vi.spyOn(db, "transaction").mockImplementation((fn: () => unknown) => {
      const tx = orig(fn) as Record<string, (...a: unknown[]) => unknown> &
        ((...a: unknown[]) => unknown);
      const wrapped = ((...a: unknown[]) => {
        variants.push("deferred");
        return tx(...a);
      }) as unknown as Record<string, unknown>;
      for (const k of ["deferred", "immediate", "exclusive"]) {
        wrapped[k] = (...a: unknown[]) => {
          variants.push(k);
          return tx[k]?.(...a);
        };
      }
      return wrapped;
    });
    try {
      const s = snap.createSnapshot(ORG, "s1", false);
      snap.deleteSnapshot(s.id);
    } finally {
      spy.mockRestore();
    }
    expect(variants).toEqual(["immediate", "immediate"]);
  });
});
