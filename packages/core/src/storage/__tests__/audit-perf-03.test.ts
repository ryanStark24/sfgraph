import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../sqlite/graph-store.js";
import { SqliteSnapshotStore } from "../sqlite/snapshot-store.js";

const ORG = asOrgId("org1");
function nf(label: string, qname: string, hash = "h1"): NodeFact {
  return {
    orgId: ORG,
    qualifiedName: asQualifiedName(qname),
    label,
    attributes: { a: 1 },
    sourceHash: asSha256(hash),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
}
function ef(rt: string, src: string, dst: string): EdgeFact {
  return {
    orgId: ORG,
    srcQualifiedName: asQualifiedName(src),
    dstQualifiedName: asQualifiedName(dst),
    relType: rt as EdgeFact["relType"],
    attributes: { k: "v" },
    firstSeenAt: 1,
    lastSeenAt: 1,
  };
}
let workDir: string;
let dbPath: string;
beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-audit-"));
  dbPath = path.join(workDir, "g.sqlite");
});
afterEach(() => rmSync(workDir, { recursive: true, force: true }));

// audit perf-03: every snapshot is a full row copy of nodes + edges.
describe("audit perf-03", () => {
  it("a second snapshot of an unchanged graph does not copy every row again", async () => {
    const g = new SqliteGraphStore({ dbPath, backupDir: path.join(workDir, "b") });
    await g.init();
    const snap = new SqliteSnapshotStore({ dbPath, db: g.db, skipMigrations: true });
    await snap.init();
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    for (let i = 0; i < 300; i++) {
      nodes.push(nf("ApexClass", `ApexClass:C${i}`));
      edges.push(ef("CALLS", `ApexClass:C${i}`, `ApexClass:C${(i + 1) % 300}`));
    }
    g.mergeNodes(nodes);
    g.mergeEdges(edges);
    const snapRows = () => {
      const tables = g.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '\\_sfgraph\\_%snap%' ESCAPE '\\'",
        )
        .all() as Array<{ name: string }>;
      let total = 0;
      for (const t of tables) {
        if (t.name === "_sfgraph_snapshots") continue;
        total += (g.db.prepare(`SELECT COUNT(*) AS c FROM ${t.name}`).get() as { c: number }).c;
      }
      return total;
    };
    snap.createSnapshot(ORG, "v1", false);
    const after1 = snapRows();
    snap.createSnapshot(ORG, "v2", true);
    const growth = snapRows() - after1;
    // Today growth == 600 (300 nodes + 300 edges). Unchanged graph should cost ~nothing.
    expect(growth).toBeLessThan(60);
    await g.close();
  });
});
