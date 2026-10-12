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

// audit rel-01: label/rel caches never refresh after init().
describe("audit rel-01", () => {
  it("a long-lived reader sees labels and edge types created later by another connection", async () => {
    const reader = new SqliteGraphStore({ dbPath, backupDir: path.join(workDir, "b") });
    await reader.init();
    const writer = new SqliteGraphStore({ dbPath, backupDir: path.join(workDir, "b") });
    await writer.init();
    writer.mergeNodes([nf("ApexClass", "ApexClass:A"), nf("ApexClass", "ApexClass:B")]);
    writer.mergeEdges([ef("CALLS", "ApexClass:A", "ApexClass:B")]);
    expect(reader.getNode(ORG, asQualifiedName("ApexClass:A"))).not.toBeNull();
    expect(reader.listNodesByLabel(ORG, "ApexClass")).toHaveLength(2);
    expect(reader.listEdgesFrom(ORG, asQualifiedName("ApexClass:A"))).toHaveLength(1);
    await reader.close();
    await writer.close();
  });
});
