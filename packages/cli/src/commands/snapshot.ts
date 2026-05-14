import path from "node:path";
import {
  SqliteGraphStore,
  SqliteSnapshotStore,
  resolveDefaultOrgAlias,
  resolveOrg,
} from "@ryanstark24/sfgraph-core";
import {
  ConfigError,
  ConsoleLogger,
  SfgraphError,
  asOrgId,
  findProjectRoot,
  getSfgraphPaths,
  readWorkspace,
  safeOrgDbPath,
} from "@ryanstark24/sfgraph-shared";

export interface SnapshotCommonOpts {
  org?: string | undefined;
  project?: string | undefined;
}

export interface SnapshotCreateOpts extends SnapshotCommonOpts {
  label: string;
  kind?: "manual" | "scheduled" | undefined;
}

export interface SnapshotDiffOpts extends SnapshotCommonOpts {
  fromId: string;
  toId: string;
}

export interface SnapshotPruneOpts extends SnapshotCommonOpts {
  retainDays: number;
}

export interface SnapshotDeleteOpts extends SnapshotCommonOpts {
  snapshotId: string;
}

async function resolveOrgId(opts: SnapshotCommonOpts): Promise<string> {
  if (opts.org) {
    const r = await resolveOrg(opts.org);
    return String(r.orgId);
  }
  const startDir = opts.project ? path.resolve(opts.project) : process.cwd();
  const projectRoot = findProjectRoot(startDir) ?? startDir;
  const ws = await readWorkspace(projectRoot);
  if (ws?.orgId) return String(ws.orgId);
  const alias = await resolveDefaultOrgAlias();
  if (!alias) {
    throw new ConfigError(
      "snapshot: no --org provided, no workspace binding, and no default org configured.",
    );
  }
  const r = await resolveOrg(alias);
  return String(r.orgId);
}

async function openStores(
  orgId: string,
): Promise<{ graphStore: SqliteGraphStore; snapshotStore: SqliteSnapshotStore }> {
  const dbPath = safeOrgDbPath(getSfgraphPaths().data, orgId);
  const graphStore = new SqliteGraphStore({ dbPath });
  await graphStore.init();
  const snapshotStore = new SqliteSnapshotStore({
    dbPath,
    db: graphStore.db,
    skipMigrations: true,
  });
  await snapshotStore.init();
  return { graphStore, snapshotStore };
}

function reportError(e: unknown): void {
  if (e instanceof SfgraphError) {
    console.error(`[${e.code}] ${e.message}`);
  } else {
    console.error((e as Error).message);
  }
  process.exitCode = 1;
}

export async function snapshotListCmd(opts: SnapshotCommonOpts): Promise<void> {
  try {
    const orgId = await resolveOrgId(opts);
    const { graphStore, snapshotStore } = await openStores(orgId);
    try {
      const snaps = snapshotStore.listSnapshots(asOrgId(orgId));
      if (snaps.length === 0) {
        console.log(`No snapshots for org ${orgId}.`);
        return;
      }
      console.log("| ID | Label | Created | Auto |");
      console.log("|---|---|---|---|");
      for (const s of snaps) {
        console.log(
          `| ${s.id} | ${s.label} | ${new Date(s.createdAt).toISOString()} | ${s.isAuto ? "yes" : "no"} |`,
        );
      }
    } finally {
      await graphStore.close();
    }
  } catch (e) {
    reportError(e);
  }
}

export async function snapshotCreateCmd(opts: SnapshotCreateOpts): Promise<void> {
  try {
    const orgId = await resolveOrgId(opts);
    const { graphStore, snapshotStore } = await openStores(orgId);
    try {
      const kind = opts.kind ?? "manual";
      const label = `${kind}:${opts.label}`;
      const snap = snapshotStore.createSnapshot(asOrgId(orgId), label, false);
      console.log(`Created snapshot ${snap.id} (label="${label}") for org ${orgId}.`);
    } finally {
      await graphStore.close();
    }
  } catch (e) {
    reportError(e);
  }
}

export async function snapshotDiffCmd(opts: SnapshotDiffOpts): Promise<void> {
  try {
    const orgId = await resolveOrgId(opts);
    const { graphStore, snapshotStore } = await openStores(orgId);
    try {
      const to = opts.toId === "current" ? ("current" as const) : opts.toId;
      const nodeDiff = snapshotStore.diffNodes(asOrgId(orgId), opts.fromId, to);
      const edgeDiff = snapshotStore.diffEdges(asOrgId(orgId), opts.fromId, to);
      console.log(`## Snapshot diff: ${opts.fromId} → ${opts.toId} (org ${orgId})`);
      console.log("");
      console.log(
        `**Nodes**: +${nodeDiff.added.length}  -${nodeDiff.removed.length}  ~${nodeDiff.changed.length}`,
      );
      console.log(`**Edges**: +${edgeDiff.added.length}  -${edgeDiff.removed.length}`);
      console.log("");
      if (nodeDiff.added.length > 0) {
        console.log("### Added nodes");
        for (const n of nodeDiff.added) console.log(`- ${n.label}: ${n.qualifiedName}`);
      }
      if (nodeDiff.removed.length > 0) {
        console.log("");
        console.log("### Removed nodes");
        for (const n of nodeDiff.removed) console.log(`- ${n.label}: ${n.qualifiedName}`);
      }
      if (nodeDiff.changed.length > 0) {
        console.log("");
        console.log("### Changed nodes");
        for (const { before, after } of nodeDiff.changed) {
          console.log(
            `- ${after.label}: ${after.qualifiedName} (hash ${before.sourceHash.slice(0, 8)}…→${after.sourceHash.slice(0, 8)}…)`,
          );
        }
      }
    } finally {
      await graphStore.close();
    }
  } catch (e) {
    reportError(e);
  }
}

export async function snapshotPruneCmd(opts: SnapshotPruneOpts): Promise<void> {
  try {
    const orgId = await resolveOrgId(opts);
    const { graphStore, snapshotStore } = await openStores(orgId);
    try {
      const n = snapshotStore.prune(asOrgId(orgId), opts.retainDays);
      console.log(
        `Pruned ${n} auto-snapshot(s) older than ${opts.retainDays} days for org ${orgId}.`,
      );
    } finally {
      await graphStore.close();
    }
  } catch (e) {
    reportError(e);
  }
}

export async function snapshotDeleteCmd(opts: SnapshotDeleteOpts): Promise<void> {
  try {
    const orgId = await resolveOrgId(opts);
    const { graphStore, snapshotStore } = await openStores(orgId);
    try {
      const existing = snapshotStore.getSnapshot(opts.snapshotId);
      if (!existing) {
        console.error(`snapshot ${opts.snapshotId} not found for org ${orgId}.`);
        process.exitCode = 1;
        return;
      }
      snapshotStore.deleteSnapshot(opts.snapshotId);
      console.log(`Deleted snapshot ${opts.snapshotId} for org ${orgId}.`);
    } finally {
      await graphStore.close();
    }
  } catch (e) {
    reportError(e);
  }
}

// Silence unused-import warning when ConsoleLogger isn't referenced.
export { ConsoleLogger };
