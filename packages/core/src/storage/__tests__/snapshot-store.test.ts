import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../sqlite/graph-store.js";
import { SqliteSnapshotStore } from "../sqlite/snapshot-store.js";

let workDir: string;
let graph: SqliteGraphStore;
let snap: SqliteSnapshotStore;

beforeEach(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-snap-"));
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

function n(label: string, qname: string, hash: string, t = 1): NodeFact {
  return {
    orgId: asOrgId("org1"),
    qualifiedName: asQualifiedName(qname),
    label,
    attributes: {},
    sourceHash: asSha256(hash),
    firstSeenAt: t,
    lastSeenAt: t,
    lastModifiedAt: t,
  };
}

function e(rt: string, src: string, dst: string): EdgeFact {
  return {
    orgId: asOrgId("org1"),
    srcQualifiedName: asQualifiedName(src),
    dstQualifiedName: asQualifiedName(dst),
    relType: rt as EdgeFact["relType"],
    attributes: {},
    firstSeenAt: 1,
    lastSeenAt: 1,
  };
}

describe("SqliteSnapshotStore", () => {
  it("createSnapshot captures current state", () => {
    graph.mergeNodes([n("ApexClass", "Foo", "h1")]);
    const s = snap.createSnapshot(asOrgId("org1"), "v1", false);
    expect(s.id).toMatch(/^snap_/);
    expect(snap.getSnapshot(s.id)?.label).toBe("v1");
    const list = snap.listSnapshots(asOrgId("org1"));
    expect(list).toHaveLength(1);
  });

  it("diffNodes(snap, 'current') detects changes", () => {
    graph.mergeNodes([n("ApexClass", "Foo", "h1")]);
    const s = snap.createSnapshot(asOrgId("org1"), "v1", false);
    graph.mergeNodes([n("ApexClass", "Foo", "h2", 5), n("ApexClass", "Bar", "h3", 5)]);
    const diff = snap.diffNodes(asOrgId("org1"), s.id, "current");
    expect(diff.added.map((x) => x.qualifiedName)).toEqual(["Bar"]);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]?.before.sourceHash).toBe("h1");
    expect(diff.changed[0]?.after.sourceHash).toBe("h2");
  });

  it("diff reports removed nodes", () => {
    graph.mergeNodes([n("ApexClass", "Foo", "h1"), n("ApexClass", "Bar", "h2")]);
    const s = snap.createSnapshot(asOrgId("org1"), "v1", false);
    // emulate deletion by clearing the table for Bar manually
    graph.db.prepare("DELETE FROM _sfg_n_apexclass WHERE qualified_name = ?").run("Bar");
    const diff = snap.diffNodes(asOrgId("org1"), s.id, "current");
    expect(diff.removed.map((x) => x.qualifiedName)).toEqual(["Bar"]);
  });

  it("diff between two snapshots", () => {
    graph.mergeNodes([n("ApexClass", "Foo", "h1")]);
    const s1 = snap.createSnapshot(asOrgId("org1"), "v1", false);
    graph.mergeNodes([n("ApexClass", "Bar", "h2")]);
    const s2 = snap.createSnapshot(asOrgId("org1"), "v2", false);
    const diff = snap.diffNodes(asOrgId("org1"), s1.id, s2.id);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]?.qualifiedName).toBe("Bar");
  });

  it("diffEdges reports added/removed only", () => {
    graph.mergeEdges([e("CALLS", "A", "B")]);
    const s1 = snap.createSnapshot(asOrgId("org1"), "v1", false);
    graph.mergeEdges([e("CALLS", "A", "C")]);
    const d = snap.diffEdges(asOrgId("org1"), s1.id, "current");
    expect(d.added).toHaveLength(1);
    expect(d.added[0]?.dstQualifiedName).toBe("C");
    expect(d.removed).toHaveLength(0);
  });

  it("prune deletes old auto snapshots only; manual survives", () => {
    graph.mergeNodes([n("ApexClass", "Foo", "h1")]);
    const auto = snap.createSnapshot(asOrgId("org1"), "auto-old", true);
    const manual = snap.createSnapshot(asOrgId("org1"), "manual-old", false);
    // Backdate both
    const old = Date.now() - 60 * 86_400_000;
    graph.db
      .prepare("UPDATE _sfgraph_snapshots SET created_at = ? WHERE id IN (?, ?)")
      .run(old, auto.id, manual.id);
    const deleted = snap.prune(asOrgId("org1"), 30);
    expect(deleted).toBe(1);
    expect(snap.getSnapshot(auto.id)).toBeNull();
    expect(snap.getSnapshot(manual.id)).not.toBeNull();
  });

  it("deleteSnapshot removes child rows", () => {
    graph.mergeNodes([n("ApexClass", "Foo", "h1")]);
    const s = snap.createSnapshot(asOrgId("org1"), "v1", false);
    snap.deleteSnapshot(s.id);
    expect(snap.getSnapshot(s.id)).toBeNull();
    const rows = graph.db
      .prepare("SELECT COUNT(*) AS c FROM _sfgraph_node_snapshots WHERE snapshot_id = ?")
      .get(s.id) as { c: number };
    expect(rows.c).toBe(0);
  });
});

describe("copySnapshotsFrom (final review core I-2)", () => {
  it("copies an old file's snapshot history and skips when it has none or this graph has some", async () => {
    graph.mergeNodes([n("ApexClass", "Foo", "h1")]);
    const s = snap.createSnapshot(asOrgId("org1"), "v1", false);
    const oldPath = path.join(workDir, "s.sqlite");
    const fresh = async (name: string) => {
      const p = path.join(workDir, name);
      const g = new SqliteGraphStore({ dbPath: p, backupDir: path.join(workDir, "bkp") });
      await g.init();
      const st = new SqliteSnapshotStore({ dbPath: p, db: g.db, skipMigrations: true });
      await st.init();
      return { g, st, p };
    };
    const a = await fresh("a.sqlite");
    try {
      expect(a.st.copySnapshotsFrom(oldPath)).toEqual({ copied: 1 });
      expect(a.st.getSnapshot(s.id)?.label).toBe("v1");
      expect(a.st.copySnapshotsFrom(oldPath).skipped).toMatch(/already has snapshots/);
      // The old file is detached again.
      expect(
        (a.g.db.prepare("PRAGMA database_list").all() as Array<{ name: string }>).map(
          (d) => d.name,
        ),
      ).not.toContain("sfg_old");
    } finally {
      await a.g.close();
    }
    const bare = path.join(workDir, "bare.sqlite");
    const Database = (await import("better-sqlite3")).default;
    const bareDb = new Database(bare);
    bareDb.exec("CREATE TABLE t(x)");
    bareDb.close();
    const b = await fresh("b.sqlite");
    try {
      expect(b.st.copySnapshotsFrom(bare).skipped).toMatch(/no _sfgraph_snapshots table/);
      writeFileSync(path.join(workDir, "stub.sqlite"), "stub");
      expect(b.st.copySnapshotsFrom(path.join(workDir, "stub.sqlite")).skipped).toMatch(
        /not a database/,
      );
    } finally {
      await b.g.close();
    }
  });
});
