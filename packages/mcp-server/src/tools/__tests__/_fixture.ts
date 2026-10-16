import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type EdgeFact,
  type NodeFact,
  REL_TYPES,
  SqliteGraphStore,
  SqliteSnapshotStore,
} from "@ryanstark24/sfgraph-core";
import { type OrgId, asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { type ToolContext, setToolContextFactory } from "../../context.js";

export interface FixtureNode {
  qualifiedName: string;
  label: string;
  attributes?: Record<string, unknown>;
  sourceHash?: string;
  firstSeenAt?: number;
  lastSeenAt?: number;
  lastModifiedAt?: number;
}

export interface FixtureEdge {
  srcQualifiedName: string;
  dstQualifiedName: string;
  relType: string;
  attributes?: Record<string, unknown>;
  firstSeenAt?: number;
  lastSeenAt?: number;
}

export interface Fixture {
  ctx: ToolContext;
  orgId: OrgId;
  workDir: string;
  addNode: (n: FixtureNode) => void;
  addEdge: (e: FixtureEdge) => void;
  /** One write transaction for the lot. Seeding thousands of rows one by one
   *  blocks the worker for many seconds on Windows (an fsync per row). */
  addNodes: (ns: FixtureNode[]) => void;
  addEdges: (es: FixtureEdge[]) => void;
  cleanup: () => Promise<void>;
}

export async function createFixture(orgIdStr = "org1"): Promise<Fixture> {
  const workDir = mkdtempSync(path.join(tmpdir(), "sfg-tool-"));
  const dbPath = path.join(workDir, "g.sqlite");
  const graphStore = new SqliteGraphStore({ dbPath, backupDir: path.join(workDir, "bkp") });
  await graphStore.init();
  const snapshotStore = new SqliteSnapshotStore({
    dbPath,
    db: (graphStore as unknown as { db: never }).db,
    skipMigrations: true,
  });
  await snapshotStore.init();
  const orgId = asOrgId(orgIdStr);

  const ctx: ToolContext = { graphStore, snapshotStore, orgId };
  setToolContextFactory(async () => ctx);

  const nodeFact = (n: FixtureNode): NodeFact => ({
    orgId,
    qualifiedName: asQualifiedName(n.qualifiedName),
    label: n.label,
    attributes: n.attributes ?? {},
    sourceHash: asSha256(n.sourceHash ?? `h-${n.qualifiedName}`),
    firstSeenAt: n.firstSeenAt ?? 1,
    lastSeenAt: n.lastSeenAt ?? 1,
    lastModifiedAt: n.lastModifiedAt ?? Date.now(),
  });
  const edgeFact = (e: FixtureEdge): EdgeFact => ({
    orgId,
    srcQualifiedName: asQualifiedName(e.srcQualifiedName),
    dstQualifiedName: asQualifiedName(e.dstQualifiedName),
    relType: e.relType as never,
    attributes: e.attributes ?? {},
    firstSeenAt: e.firstSeenAt ?? 1,
    lastSeenAt: e.lastSeenAt ?? 1,
  });

  const fix: Fixture = {
    ctx,
    orgId,
    workDir,
    addNode(n) {
      graphStore.mergeNodes([nodeFact(n)]);
    },
    addEdge(e) {
      graphStore.mergeEdges([edgeFact(e)]);
    },
    addNodes(ns) {
      graphStore.mergeNodes(ns.map(nodeFact));
    },
    addEdges(es) {
      graphStore.mergeEdges(es.map(edgeFact));
    },
    async cleanup() {
      setToolContextFactory(null);
      await graphStore.close();
      rmSync(workDir, { recursive: true, force: true });
    },
  };
  return fix;
}

export { REL_TYPES };
