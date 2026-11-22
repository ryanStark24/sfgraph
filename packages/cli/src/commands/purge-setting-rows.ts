import path from "node:path";
import {
  SqliteGraphStore,
  SqliteVectorStore,
  purgeStoredCustomSettingRows,
  resolveDefaultOrgAlias,
  resolveOrg,
} from "@ryanstark24/sfgraph-core";
import {
  ConfigError,
  asOrgId,
  findProjectRoot,
  getSfgraphPaths,
  readWorkspace,
  safeOrgDbPath,
} from "@ryanstark24/sfgraph-shared";

export interface PurgeSettingRowsOpts {
  org?: string | undefined;
  project?: string | undefined;
  yes?: boolean | undefined;
}

async function resolveOrgId(opts: PurgeSettingRowsOpts): Promise<string> {
  if (opts.org) return String((await resolveOrg(opts.org)).orgId);
  const startDir = opts.project ? path.resolve(opts.project) : process.cwd();
  const projectRoot = findProjectRoot(startDir) ?? startDir;
  const ws = await readWorkspace(projectRoot);
  if (ws?.orgId) return String(ws.orgId);
  const alias = await resolveDefaultOrgAlias();
  if (!alias) {
    throw new ConfigError(
      "no org specified — pass --org <alias> or link a workspace with `sfgraph link`",
    );
  }
  return String((await resolveOrg(alias)).orgId);
}

/**
 * Remove custom setting row values stored by an earlier sfgraph: the graph
 * rows, the search index entry, the vectors built from them and the snapshot
 * history in the same database. Setting names and schema links stay. Backup
 * files and snapshot exports are separate copies and are not rewritten.
 */
export async function purgeSettingRows(opts: PurgeSettingRowsOpts): Promise<void> {
  const orgId = await resolveOrgId(opts);
  const dbPath = safeOrgDbPath(getSfgraphPaths().data, orgId);
  if (!opts.yes) {
    console.log(`Will remove stored custom setting row values for org=${orgId}`);
    console.log(`  Database: ${dbPath}`);
    console.log("  Setting names and schema links stay. Backups of this database and exported");
    console.log("  snapshots are separate copies; delete them yourself if they hold rows.");
    console.log("  Re-run with --yes to confirm.");
    return;
  }
  const store = new SqliteGraphStore({ dbPath });
  await store.init();
  try {
    let vectors: SqliteVectorStore | undefined;
    try {
      const vs = new SqliteVectorStore({ dbPath, db: store.db, skipMigrations: true });
      await vs.init();
      vectors = vs;
    } catch {
      vectors = undefined;
    }
    const n = purgeStoredCustomSettingRows(store, asOrgId(orgId), vectors);
    console.log(
      `purge-setting-rows: removed row values from ${n} custom setting(s) for org=${orgId}`,
    );
  } finally {
    await store.close();
  }
}
