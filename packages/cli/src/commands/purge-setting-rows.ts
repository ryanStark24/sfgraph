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

/** What `purge-setting-rows` tells the user: the count of settings, and a warning with exit code 1 when vectors are pending. */
export function purgeReport(
  r: { settings: number; vectorsPending: number; compactError?: string },
  orgId: string,
  vectorStoreAvailable: boolean,
): { message: string; warning?: string; exitCode: number } {
  const message = `purge-setting-rows: removed row values from ${r.settings} custom setting(s) for org=${orgId}`;
  const notCompacted = r.compactError
    ? `purge-setting-rows: NOT finished: the database file could not be compacted (${r.compactError}), so old values may remain in its free pages and WAL. Stop other sfgraph processes (MCP server, ingest) and run this command again. `
    : "";
  if (r.vectorsPending === 0) {
    return notCompacted
      ? { message, warning: notCompacted.trim(), exitCode: 1 }
      : { message, exitCode: 0 };
  }
  return {
    message,
    warning: `${notCompacted}purge-setting-rows: NOT finished: the search vectors of ${r.vectorsPending} setting(s) were not deleted (${vectorStoreAvailable ? "a delete failed" : "the vector store is unavailable"}). The row values are gone from the graph; run this command again, or ingest, to finish.`,
    exitCode: 1,
  };
}

/**
 * Remove custom setting row values stored by an earlier sfgraph: the graph
 * rows, the search index entry, the vectors built from them and the snapshot
 * history in the same database, then compacts the file (WAL checkpoint, VACUUM) so no old
 * value stays in free pages. Setting names and schema links stay. Backup files, snapshot
 * exports and the embedding cache are separate files and are not rewritten (listed below).
 */
export async function purgeSettingRows(opts: PurgeSettingRowsOpts): Promise<void> {
  const orgId = await resolveOrgId(opts);
  const dbPath = safeOrgDbPath(getSfgraphPaths().data, orgId);
  if (!opts.yes) {
    console.log(`Will remove stored custom setting row values for org=${orgId}`);
    console.log(`  Database: ${dbPath}`);
    console.log(
      "  Setting names and schema links stay. The database file is compacted afterwards.",
    );
    console.log("  NOT touched, and may still hold old values: backups of this database");
    console.log(
      "  (.sfgraph-backups/, the --rebuild backup), exported snapshots and the embedding",
    );
    console.log("  cache (embedding-cache/ in the data folder: only SHA-256 hashes and vectors of");
    console.log("  texts, no text, but entries made from row values stay). Delete those yourself;");
    console.log("  the cache is rebuilt by the next ingest.");
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
    const r = purgeStoredCustomSettingRows(store, asOrgId(orgId), vectors);
    const out = purgeReport(r, orgId, vectors !== undefined);
    console.log(out.message);
    if (out.warning) console.error(out.warning);
    if (out.exitCode) process.exitCode = out.exitCode;
  } finally {
    await store.close();
  }
}
