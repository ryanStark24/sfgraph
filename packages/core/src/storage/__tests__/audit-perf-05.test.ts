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

// audit perf-05: listEdgesFrom/To re-prepare a statement per edge table per call.
describe("audit perf-05", () => {
  it("repeated traversal lookups do not re-prepare statements on every call", async () => {
    const g = new SqliteGraphStore({ dbPath, backupDir: path.join(workDir, "b") });
    await g.init();
    g.mergeEdges([
      ef("CALLS", "ApexClass:A", "ApexClass:B"),
      ef("REFERENCES_FIELD", "ApexClass:A", "CustomField:X.y"),
      ef("EXTENDS", "ApexClass:A", "ApexClass:C"),
    ]);
    const A = asQualifiedName("ApexClass:A");
    g.listEdgesFrom(ORG, A); // warm-up
    g.listEdgesTo(ORG, A);
    const spy = vi.spyOn(g.db, "prepare");
    for (let i = 0; i < 50; i++) {
      g.listEdgesFrom(ORG, A);
      g.listEdgesTo(ORG, A);
    }
    // 100 calls over 3 edge tables = 300 prepares today; a cache gives ~0.
    expect(spy.mock.calls.length).toBeLessThan(100);
    await g.close();
  });
});
