import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type EdgeFact,
  type NodeFact,
  REL_TYPES,
  SqliteGraphStore,
  SqliteSnapshotStore,
} from "@sfgraph/core";
import { type OrgId, asOrgId, asQualifiedName, asSha256 } from "@sfgraph/shared";
import { type ToolContext, setToolContextFactory } from "../../context.js";

export interface Fixture {
  ctx: ToolContext;
  orgId: OrgId;
  workDir: string;
  addNode: (n: {
    qualifiedName: string;
    label: string;
    attributes?: Record<string, unknown>;
    sourceHash?: string;
    firstSeenAt?: number;
    lastSeenAt?: number;
    lastModifiedAt?: number;
  }) => void;
  addEdge: (e: {
    srcQualifiedName: string;
    dstQualifiedName: string;
    relType: string;
    attributes?: Record<string, unknown>;
    firstSeenAt?: number;
    lastSeenAt?: number;
  }) => void;
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

  const fix: Fixture = {
    ctx,
    orgId,
    workDir,
    addNode(n) {
      const fact: NodeFact = {
        orgId,
        qualifiedName: asQualifiedName(n.qualifiedName),
        label: n.label,
        attributes: n.attributes ?? {},
        sourceHash: asSha256(n.sourceHash ?? `h-${n.qualifiedName}`),
        firstSeenAt: n.firstSeenAt ?? 1,
        lastSeenAt: n.lastSeenAt ?? 1,
        lastModifiedAt: n.lastModifiedAt ?? Date.now(),
      };
      graphStore.mergeNodes([fact]);
    },
    addEdge(e) {
      const fact: EdgeFact = {
        orgId,
        srcQualifiedName: asQualifiedName(e.srcQualifiedName),
        dstQualifiedName: asQualifiedName(e.dstQualifiedName),
        relType: e.relType as never,
        attributes: e.attributes ?? {},
        firstSeenAt: e.firstSeenAt ?? 1,
        lastSeenAt: e.lastSeenAt ?? 1,
      };
      graphStore.mergeEdges([fact]);
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
