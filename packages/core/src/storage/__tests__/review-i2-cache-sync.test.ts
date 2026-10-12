import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../sqlite/graph-store.js";

// review I2: every method that reads the cached label / rel-type lists must
// see tables another process created, and a rebuild's file swap must be seen.
const ORG = asOrgId("org1");
const nf = (label: string, qname: string, attrs: Record<string, unknown> = {}): NodeFact => ({
  orgId: ORG,
  qualifiedName: asQualifiedName(qname),
  label,
  attributes: attrs,
  sourceHash: asSha256("h1"),
  firstSeenAt: 1,
  lastSeenAt: 1,
  lastModifiedAt: 1,
});
const ef = (rt: string, src: string, dst: string): EdgeFact => ({
  orgId: ORG,
  srcQualifiedName: asQualifiedName(src),
  dstQualifiedName: asQualifiedName(dst),
  relType: rt as EdgeFact["relType"],
  attributes: {},
  firstSeenAt: 1,
  lastSeenAt: 1,
});

let dir: string;
let dbPath: string;
let reader: SqliteGraphStore;
let writer: SqliteGraphStore;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-i2-"));
  dbPath = path.join(dir, "g.sqlite");
  reader = new SqliteGraphStore({ dbPath, fileCheckIntervalMs: 0 });
  await reader.init();
  // Prime every read path so the caches are loaded before the foreign write.
  expect(reader.isOrgEmpty(ORG)).toBe(true);
  writer = new SqliteGraphStore({ dbPath });
  await writer.init();
});
afterEach(async () => {
  await reader.close();
  await writer.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("review I2: cache-reading methods resync after a foreign write", () => {
  it("isOrgEmpty, findNodesMentioning, listNodesWithSourceHash, getNodeStamps see a new label table", () => {
    writer.mergeNodes([nf("BrandNewLabel", "Thing1", { ref: "needle" })]);
    expect(reader.isOrgEmpty(ORG)).toBe(false);
    expect([...reader.findNodesMentioning(ORG, ["needle"])]).toEqual(["Thing1"]);
    expect(reader.listNodesWithSourceHash(ORG, "h1")).toEqual(["Thing1"]);
    expect([...reader.getNodeStamps(ORG, ["Thing1"]).keys()]).toEqual(["Thing1"]);
  });

  it("listResolverReferencePairs and listCanonicalPairs see a new rel table", () => {
    writer.mergeNodes([nf("ApexClass", "A"), nf("ApexClass", "B")]);
    writer.mergeEdges([ef("REFERENCES", "A", "B"), ef("CANONICAL_OF", "A", "B")]);
    expect(reader.listCanonicalPairs(ORG).size).toBe(1);
    // Resolver pairs need the resolver marker; the call must at least not miss the table.
    expect(() => reader.listResolverReferencePairs(ORG)).not.toThrow();
    expect(reader.deleteEdgesFrom(ORG, ["A"]).length).toBe(2);
  });
});

describe("review I2: a rebuild's file swap is detected by dev/ino", () => {
  it("a long-lived store reopens dbPath after it is renamed away and recreated", async () => {
    writer.mergeNodes([nf("ApexClass", "OldGraph")]);
    expect(reader.getNode(ORG, asQualifiedName("OldGraph"))).not.toBeNull();
    await writer.close();
    // What `sfgraph ingest --rebuild` does: move the DB aside, build a new file.
    renameSync(dbPath, `${dbPath}.bak`);
    for (const s of ["-wal", "-shm"]) {
      try {
        renameSync(dbPath + s, `${dbPath}.bak${s}`);
      } catch {
        /* absent */
      }
    }
    writer = new SqliteGraphStore({ dbPath });
    await writer.init();
    writer.upsertOrg({
      id: ORG,
      alias: "o",
      instanceUrl: "https://x",
      apiVersion: "62.0",
      createdAt: 1,
    });
    writer.markSyncStarted(ORG, new Date().toISOString());
    writer.beginBulk();
    writer.mergeNodes([nf("ApexClass", "NewGraph")]);
    // review R1-1: mid-rebuild (bulk window and sync owned by a live
    // process) the reader keeps serving the complete old graph.
    expect(reader.getNode(ORG, asQualifiedName("NewGraph"))).toBeNull();
    expect(reader.getNode(ORG, asQualifiedName("OldGraph"))).not.toBeNull();
    writer.endBulk();
    expect(reader.getNode(ORG, asQualifiedName("OldGraph"))).not.toBeNull();
    writer.markSyncComplete(ORG, new Date().toISOString());
    expect(reader.getNode(ORG, asQualifiedName("NewGraph"))).not.toBeNull();
    expect(reader.getNode(ORG, asQualifiedName("OldGraph"))).toBeNull();
  });

  it("never swaps when fileCheckIntervalMs is negative (review R1-2)", async () => {
    const pinned = new SqliteGraphStore({ dbPath, fileCheckIntervalMs: -1 });
    await pinned.init();
    try {
      writer.mergeNodes([nf("ApexClass", "OldGraph")]);
      await writer.close();
      renameSync(dbPath, `${dbPath}.bak`);
      for (const s of ["-wal", "-shm"]) {
        try {
          renameSync(dbPath + s, `${dbPath}.bak${s}`);
        } catch {
          /* absent */
        }
      }
      writer = new SqliteGraphStore({ dbPath });
      await writer.init();
      writer.upsertOrg({
        id: ORG,
        alias: "o",
        instanceUrl: "https://x",
        apiVersion: "62.0",
        createdAt: 1,
      });
      writer.mergeNodes([nf("ApexClass", "NewGraph")]);
      writer.markSyncComplete(ORG, new Date().toISOString());
      expect(pinned.getNode(ORG, asQualifiedName("OldGraph"))).not.toBeNull();
      expect(pinned.getNode(ORG, asQualifiedName("NewGraph"))).toBeNull();
    } finally {
      await pinned.close();
    }
  });
});
