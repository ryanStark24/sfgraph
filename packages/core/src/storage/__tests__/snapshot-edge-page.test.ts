import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asOrgId, asQualifiedName } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EdgeFact, RelType } from "../../domain/index.js";
import { SqliteGraphStore } from "../sqlite/graph-store.js";
import { SqliteSnapshotStore } from "../sqlite/snapshot-store.js";

// T14 batch L: point_in_time_diff needs edge counts plus the first `limit`
// rows only. diffEdgesPage must return exactly diffEdges' first `limit` rows
// (same order) and its exact lengths, for every side combination.

const ORG = asOrgId("org1");
const OTHER = asOrgId("org2");
let workDir: string;
let graph: SqliteGraphStore;
let snap: SqliteSnapshotStore;

beforeEach(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-edgepage-"));
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

// Mixed case, non-ASCII and astral (surrogate) names: BINARY order differs
// from NOCASE and from UTF-16 code-unit order here.
const SRCS = ["X:B", "X:a", "X:\u00e9", "X:\u{1f600}", "X:\uff21", "Y:c"];
const RELS = ["WRITES_FIELD", "CALLS", "REFERENCES", "READS_FIELD"];

describe("diffEdgesPage = diffEdges sliced, with exact counts", () => {
  it("matches for every pair of sides and limits", () => {
    const s0 = snap.createSnapshot(ORG, "empty", true);
    const base: EdgeFact[] = [];
    for (const [i, src] of SRCS.entries()) {
      for (const [j, rt] of RELS.entries()) {
        if ((i + j) % 3 === 0) continue;
        base.push(e("org1", rt, src, `D:${(i * 7 + j) % 5}`));
        base.push(e("org1", rt, src, `d:${j}`));
      }
    }
    graph.mergeEdges(base);
    graph.mergeEdges([e("org2", "CALLS", "X:a", "D:1")]);
    const s1 = snap.createSnapshot(ORG, "s1", true);
    const o1 = snap.createSnapshot(OTHER, "o1", true);
    // Remove some, add some, change attributes only on some (not a key change).
    graph.deleteEdge(ORG, asQualifiedName("X:a"), asQualifiedName("d:1"), "CALLS" as RelType);
    graph.deleteEdge(ORG, asQualifiedName("X:B"), asQualifiedName("d:2"), "REFERENCES" as RelType);
    graph.mergeEdges([
      e("org1", "CALLS", "A:new", "D:9"),
      e("org1", "INSTANCE_OF", "X:a", "T:1"),
      e("org1", "WRITES_FIELD", "X:\u{1f600}", "D:0", { changed: true }),
    ]);
    const s2 = snap.createSnapshot(ORG, "s2", true);
    // A key that changes only in case (the live table is NOCASE, the diff
    // BINARY), then a snapshot deleted between two others (its versions are
    // merged into its neighbours').
    graph.deleteEdge(
      ORG,
      asQualifiedName("X:a"),
      asQualifiedName("d:0"),
      "WRITES_FIELD" as RelType,
    );
    graph.mergeEdges([e("org1", "WRITES_FIELD", "X:A", "d:0")]);
    const tmp = snap.createSnapshot(ORG, "tmp", true);
    graph.mergeEdges([e("org1", "CALLS", "T:tmp", "D:1")]);
    graph.deleteEdge(ORG, asQualifiedName("X:B"), asQualifiedName("D:1"), "CALLS" as RelType);
    const s3 = snap.createSnapshot(ORG, "s3", true);
    snap.deleteSnapshot(tmp.id);
    graph.deleteEdgesFor(ORG, asQualifiedName("Y:c"));
    graph.mergeEdges([e("org1", "READS_FIELD", "Z:z", "D:\uff21")]);

    const sides = [s0.id, s1.id, s2.id, s3.id, o1.id, "current"];
    const caseFlip = snap.diffEdges(ORG, s2.id, "current");
    expect(caseFlip.removed.map((x) => x.srcQualifiedName)).toContain("X:a");
    expect(caseFlip.added.map((x) => x.srcQualifiedName)).toContain("X:A");
    const limits = [1, 2, 3, 5, 1000];
    let nonEmpty = 0;
    for (const from of sides) {
      for (const to of sides) {
        const full = snap.diffEdges(ORG, from, to);
        if (full.added.length + full.removed.length > 0) nonEmpty++;
        for (const limit of limits) {
          const page = snap.diffEdgesPage(ORG, from, to, limit);
          expect(page.addedCount, `${from}->${to} added count`).toBe(full.added.length);
          expect(page.removedCount, `${from}->${to} removed count`).toBe(full.removed.length);
          expect(page.added, `${from}->${to} added @${limit}`).toEqual(full.added.slice(0, limit));
          expect(page.removed, `${from}->${to} removed @${limit}`).toEqual(
            full.removed.slice(0, limit),
          );
        }
      }
    }
    expect(nonEmpty).toBeGreaterThan(10);
  });

  it("covers edges whose rel type has no live table any more", () => {
    graph.mergeEdges([e("org1", "CALLS", "A:1", "B:1"), e("org1", "REFERENCES", "A:2", "B:2")]);
    const s1 = snap.createSnapshot(ORG, "s1", true);
    // Simulate a rel type whose live table is gone (it is no longer registered).
    graph.db.prepare("DELETE FROM _sfgraph_edge_types WHERE rel_type = 'REFERENCES'").run();
    for (const [from, to] of [
      [s1.id, "current"],
      ["current", s1.id],
    ] as const) {
      const full = snap.diffEdges(ORG, from, to);
      const page = snap.diffEdgesPage(ORG, from, to, 1);
      expect(page.addedCount).toBe(full.added.length);
      expect(page.removedCount).toBe(full.removed.length);
      expect(page.added).toEqual(full.added.slice(0, 1));
      expect(page.removed).toEqual(full.removed.slice(0, 1));
    }
    expect(snap.diffEdgesPage(ORG, s1.id, "current", 10).removedCount).toBe(1);
  });
});

describe("diffEdgesPage query plans", () => {
  it("never scans the whole org's snapshot edges once per rel type", async () => {
    graph.mergeEdges([e("org1", "CALLS", "A:1", "B:1"), e("org1", "REFERENCES", "A:2", "B:2")]);
    const s1 = snap.createSnapshot(ORG, "s1", true);
    graph.mergeEdges([e("org1", "CALLS", "A:3", "B:3")]);
    const sqls: string[] = [];
    const prepare = graph.db.prepare.bind(graph.db);
    graph.db.prepare = ((sql: string) => {
      sqls.push(sql);
      return prepare(sql);
    }) as typeof graph.db.prepare;
    snap.diffEdgesPage(ORG, s1.id, "current", 10);
    snap.diffEdgesPage(ORG, "current", s1.id, 10);
    graph.db.prepare = prepare as typeof graph.db.prepare;
    const perRel = sqls.filter((s) => /_sfgraph_snap_edges v/.test(s) && /@rt/.test(s));
    expect(perRel.length).toBeGreaterThan(0);
    for (const sql of perRel) {
      const params = Object.fromEntries(
        [...sql.matchAll(/@(\w+)/g)].map((m) => [m[1] as string, m[1] === "rt" ? "CALLS" : 1]),
      );
      const plan = (
        graph.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params) as Array<{ detail: string }>
      )
        .map((r) => r.detail)
        .join("\n");
      expect(plan, sql).toMatch(
        /SEARCH v USING COVERING INDEX _sfgraph_snap_edges_rel|SEARCH v USING INDEX _sfgraph_snap_edges_rel \(org_id=\? AND rel_type=\?/,
      );
    }
  });
});
