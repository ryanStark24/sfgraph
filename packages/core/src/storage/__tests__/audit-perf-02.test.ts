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

// audit perf-02: diff hydrates and JSON.parses every row of both sides.
describe("audit perf-02", () => {
  it("diffing identical graphs does not JSON.parse every row", async () => {
    const g = new SqliteGraphStore({ dbPath, backupDir: path.join(workDir, "b") });
    await g.init();
    const snap = new SqliteSnapshotStore({ dbPath, db: g.db, skipMigrations: true });
    await snap.init();
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    for (let i = 0; i < 200; i++) {
      nodes.push(nf("ApexClass", `ApexClass:C${i}`));
      edges.push(ef("CALLS", `ApexClass:C${i}`, `ApexClass:C${(i + 1) % 200}`));
    }
    g.mergeNodes(nodes);
    g.mergeEdges(edges);
    const s = snap.createSnapshot(ORG, "v1", false);
    const spy = vi.spyOn(JSON, "parse");
    const nd = snap.diffNodes(ORG, s.id, "current");
    const ed = snap.diffEdges(ORG, s.id, "current");
    const parses = spy.mock.calls.length;
    spy.mockRestore();
    expect(nd.added.length + nd.removed.length + nd.changed.length).toBe(0);
    expect(ed.added.length + ed.removed.length).toBe(0);
    // 800 rows hydrated today (2 sides x (200 nodes + 200 edges)).
    expect(parses).toBeLessThan(100);
    await g.close();
  });
});
