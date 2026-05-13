import path from "node:path";
import type { GraphStore, SnapshotStore } from "@ryanstark24/sfgraph-core";
import { type OrgId, asOrgId, getSfgraphPaths } from "@ryanstark24/sfgraph-shared";

export interface ToolContext {
  graphStore: GraphStore;
  snapshotStore: SnapshotStore;
  orgId: OrgId;
  /** Raw SQLite handle for cached analysis-table reads (optional). */
  db?: unknown;
}

export type ToolContextFactory = (opts: { orgId?: string }) => Promise<ToolContext>;

let factory: ToolContextFactory | null = null;

export function setToolContextFactory(fn: ToolContextFactory | null): void {
  factory = fn;
}

export async function getToolContext(opts: { orgId?: string } = {}): Promise<ToolContext> {
  if (!factory) {
    factory = defaultFactory;
  }
  return factory(opts);
}

async function defaultFactory(opts: { orgId?: string }): Promise<ToolContext> {
  const orgIdOrAlias = opts.orgId ?? "default";
  const paths = getSfgraphPaths();
  const dbPath = path.join(paths.data, `${orgIdOrAlias}.sqlite`);
  const { SqliteGraphStore, SqliteSnapshotStore } = await import("@ryanstark24/sfgraph-core");
  const graphStore = new SqliteGraphStore({ dbPath });
  await graphStore.init();
  const snapshotStore = new SqliteSnapshotStore({
    dbPath,
    db: (graphStore as unknown as { db: unknown }).db as never,
    skipMigrations: true,
  });
  await snapshotStore.init();
  let resolvedOrgId = orgIdOrAlias;
  if (orgIdOrAlias.length !== 15 && orgIdOrAlias.length !== 18) {
    try {
      const row = (
        graphStore as unknown as { db: { prepare: (s: string) => { get: (a: string) => unknown } } }
      ).db
        .prepare("SELECT id FROM _sfgraph_orgs WHERE alias = ?")
        .get(orgIdOrAlias) as { id: string } | undefined;
      if (row?.id) resolvedOrgId = row.id;
    } catch {
      // table might not exist in some setups; ignore
    }
  }
  const db = (graphStore as unknown as { db: unknown }).db;
  return { graphStore, snapshotStore, orgId: asOrgId(resolvedOrgId), db };
}
