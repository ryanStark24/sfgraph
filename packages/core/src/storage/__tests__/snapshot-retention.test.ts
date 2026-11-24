import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NodeFact } from "../../domain/index.js";
import {
  RECLAIMABLE_NOTICE_BYTES,
  envNonNegativeInt,
  freeBytesOf,
  reclaimableNotice,
} from "../retention.js";
import { SqliteGraphStore } from "../sqlite/graph-store.js";
import { SqliteSnapshotStore } from "../sqlite/snapshot-store.js";

const ORG = asOrgId("00Dxx0000001retA");
const DAY = 86_400_000;

let workDir: string;
let dbPath: string;
let graph: SqliteGraphStore;
let snap: SqliteSnapshotStore;

async function open(): Promise<void> {
  graph = new SqliteGraphStore({ dbPath, backupDir: path.join(workDir, "bkp") });
  await graph.init();
  snap = new SqliteSnapshotStore({ dbPath, db: graph.db, skipMigrations: true });
  await snap.init();
}

beforeEach(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-ret-"));
  dbPath = path.join(workDir, "g.sqlite");
  await open();
});

afterEach(async () => {
  await graph.close();
  rmSync(workDir, { recursive: true, force: true });
});

function node(qname: string, hash: string): NodeFact {
  return {
    orgId: ORG,
    qualifiedName: asQualifiedName(qname),
    label: "ApexClass",
    attributes: { body: "x".repeat(200) },
    sourceHash: asSha256(hash),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
}

/** One sync step: change a few nodes, add one, then snapshot. Backdated `ageDays` days. */
function step(i: number, isAuto: boolean, ageDays: number): string {
  graph.mergeNodes([
    node("Stable", "s0"),
    node(`Added${i}`, `a${i}`),
    node("Churn", `c${i}`),
    node(`Churn${i % 3}`, `cc${i}`),
  ]);
  const s = snap.createSnapshot(ORG, `${isAuto ? "pre-sync" : "manual"}-${i}`, isAuto);
  graph.db
    .prepare("UPDATE _sfgraph_snapshots SET created_at = ? WHERE id = ?")
    .run(Date.now() - ageDays * DAY, s.id);
  return s.id;
}

const labels = (): string[] =>
  snap
    .listSnapshots(ORG)
    .map((s) => s.label)
    .sort();

describe("auto snapshot retention", () => {
  it("keeps manual snapshots and the newest N auto ones; age applies only beyond N", () => {
    // oldest to newest: auto 0..7 (ages 70..0 days step 10), manual in between
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(step(i, true, (7 - i) * 10));
    step(100, false, 75);
    step(101, false, 0);
    // newest 5 auto = i 3..7 (ages 40..0). Beyond: i 0,1,2 (ages 70,60,50) older than 30 d.
    // i=3 is age 40 but inside the newest five: protected.
    expect(snap.pruneAuto(ORG, { keep: 5, retainDays: 30 })).toBe(3);
    expect(labels()).toEqual(
      [
        "manual-100",
        "manual-101",
        "pre-sync-3",
        "pre-sync-4",
        "pre-sync-5",
        "pre-sync-6",
        "pre-sync-7",
      ].sort(),
    );
  });

  it("a snapshot beyond N that is younger than the age limit stays; 0 days removes it", () => {
    for (let i = 0; i < 4; i++) step(i, true, 3 - i); // ages 3,2,1,0 days
    expect(snap.pruneAuto(ORG, { keep: 2, retainDays: 30 })).toBe(0);
    expect(snap.listSnapshots(ORG)).toHaveLength(4);
    expect(snap.pruneAuto(ORG, { keep: 2, retainDays: 0 })).toBe(2);
    expect(labels()).toEqual(["pre-sync-2", "pre-sync-3"]);
  });

  it("keep = 0 removes every auto snapshot but never a manual one", () => {
    step(0, true, 50);
    step(1, false, 50);
    expect(snap.pruneAuto(ORG, { keep: 0, retainDays: 0 })).toBe(1);
    expect(labels()).toEqual(["manual-1"]);
  });

  it("a dry list matches what pruneAuto deletes and changes nothing", () => {
    for (let i = 0; i < 6; i++) step(i, true, 90 - i);
    const plan = snap.autoSnapshotsToPrune(ORG, { keep: 2, retainDays: 30 });
    expect(plan).toHaveLength(4);
    expect(snap.listSnapshots(ORG)).toHaveLength(6);
    expect(snap.pruneAuto(ORG, { keep: 2, retainDays: 30 })).toBe(4);
  });

  it("point_in_time_diff between kept snapshots is identical before and after pruning", () => {
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) {
      graph.mergeEdges([
        {
          orgId: ORG,
          srcQualifiedName: asQualifiedName(`Added${i}`),
          dstQualifiedName: asQualifiedName("Stable"),
          relType: "CALLS" as never,
          attributes: {},
          firstSeenAt: 1,
          lastSeenAt: 1,
        },
      ]);
      ids.push(step(i, true, 9 - i));
    }
    // delete a node so some versions close
    graph.db.prepare("DELETE FROM _sfg_n_apexclass WHERE qualified_name = ?").run("Added2");
    ids.push(step(9, true, 0));

    const kept = ids.slice(-4);
    const sides = [...kept, "current" as const];
    const snapshotOf = () => {
      const out: unknown[] = [];
      for (const a of sides)
        for (const b of sides) {
          if (a === b) continue;
          out.push([
            a,
            b,
            snap.diffNodes(ORG, a, b),
            snap.diffEdges(ORG, a, b),
            snap.diffEdgesPage(ORG, a, b, 50),
          ]);
        }
      return out;
    };
    const before = snapshotOf();
    expect(snap.pruneAuto(ORG, { keep: 4, retainDays: 0 })).toBe(6);
    expect(snapshotOf()).toEqual(before);
  });

  it("a batch delete leaves the same version rows as deleting one by one", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(step(i, true, 8 - i));
    const dump = (db: SqliteGraphStore["db"]) => ({
      n: db
        .prepare(
          "SELECT qualified_name, label, source_hash, from_seq, to_seq FROM _sfgraph_snap_nodes ORDER BY 1,2,4,3",
        )
        .all(),
      e: db.prepare("SELECT * FROM _sfgraph_snap_edges ORDER BY 1,2,3,4,8").all(),
      s: db.prepare("SELECT seq FROM _sfgraph_snapshots ORDER BY seq").all(),
    });
    // a copy of the same file to delete sequentially
    const copyPath = path.join(workDir, "copy.sqlite");
    graph.db.exec(`VACUUM INTO '${copyPath}'`);
    const g2 = new SqliteGraphStore({ dbPath: copyPath, backupDir: path.join(workDir, "bkp2") });
    await g2.init();
    const s2 = new SqliteSnapshotStore({ dbPath: copyPath, db: g2.db, skipMigrations: true });
    const doomed = [ids[0], ids[2], ids[3], ids[7]] as string[]; // includes the newest
    snap.deleteSnapshots(doomed);
    for (const id of doomed) s2.deleteSnapshot(id);
    expect(dump(graph.db)).toEqual(dump(g2.db));
    await g2.close();
  });

  it("a second sync after pruning reuses the freed pages instead of growing the file", () => {
    for (let i = 0; i < 12; i++) {
      graph.mergeNodes(
        Array.from({ length: 300 }, (_, k) => node(`N${k}`, `h${i}-${k}`)).map((f) => ({
          ...f,
          attributes: { pad: "y".repeat(400) },
        })),
      );
      step(i, true, 12 - i);
    }
    graph.db.pragma("wal_checkpoint(TRUNCATE)");
    const pages = () => Number(graph.db.pragma("page_count", { simple: true }));
    const grown = pages();
    expect(snap.pruneAuto(ORG, { keep: 3, retainDays: 0 })).toBe(9);
    expect(freeBytesOf(graph.db)).toBeGreaterThan(0);
    expect(pages()).toBe(grown); // pruning never shrinks the file
    graph.mergeNodes(
      Array.from({ length: 300 }, (_, k) => node(`N${k}`, `z-${k}`)).map((f) => ({
        ...f,
        attributes: { pad: "y".repeat(400) },
      })),
    );
    step(99, true, 0);
    graph.db.pragma("wal_checkpoint(TRUNCATE)");
    expect(pages()).toBeLessThanOrEqual(grown);
    expect(statSync(dbPath).size).toBeLessThanOrEqual(grown * 4096 * 2);
  });
});

describe("retention settings", () => {
  it("reads a non-negative integer from the environment and falls back otherwise", () => {
    const k = "SFGRAPH_TEST_RETENTION_KNOB";
    try {
      process.env[k] = "7";
      expect(envNonNegativeInt(k, 5)).toBe(7);
      process.env[k] = "0";
      expect(envNonNegativeInt(k, 5)).toBe(0);
      for (const bad of ["", "-1", "2.5", "abc", "1e3"]) {
        process.env[k] = bad;
        expect(envNonNegativeInt(k, 5)).toBe(5);
      }
    } finally {
      delete process.env[k];
    }
    expect(envNonNegativeInt(k, 9)).toBe(9);
  });

  it("prints the reclaimable line only above 256 MB", () => {
    expect(reclaimableNotice("00Dxx", RECLAIMABLE_NOTICE_BYTES)).toBeNull();
    expect(reclaimableNotice("00Dxx", 1.1 * 1024 ** 3 + 1)).toBe(
      'reclaimable 1.1 GB in 00Dxx: run "sfgraph storage clean --vacuum"',
    );
  });
});
