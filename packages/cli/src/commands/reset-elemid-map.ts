import path from "node:path";
import {
  SqliteGraphStore,
  resetServiceIdMap,
  resolveDefaultOrgAlias,
  resolveOrg,
} from "@ryanstark24/sfgraph-core";
import {
  ConfigError,
  findProjectRoot,
  getSfgraphPaths,
  readWorkspace,
  safeOrgDbPath,
} from "@ryanstark24/sfgraph-shared";

export interface ResetElemIdMapOpts {
  org?: string | undefined;
  project?: string | undefined;
  yes?: boolean | undefined;
}

async function resolveOrgId(opts: ResetElemIdMapOpts): Promise<string> {
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
      "no org specified — pass --org <alias> or link a workspace with `sfgraph link`",
    );
  }
  const r = await resolveOrg(alias);
  return String(r.orgId);
}

/**
 * Drop the (org, serviceId → qualifiedName) map for the given org. The next
 * full ingest re-populates it from scratch. Used as a recovery escape hatch
 * when the rename-stability layer has produced incorrect inferences (e.g.
 * serviceId collisions across two managed packages with the same
 * DeveloperName).
 *
 * This is non-destructive — it does NOT touch nodes, edges, snippets,
 * vectors, or snapshots. After reset, sfgraph reverts to the pre-W3-05
 * delete-then-add behavior on renames until the map repopulates.
 */
export async function resetElemIdMap(opts: ResetElemIdMapOpts): Promise<void> {
  const orgId = await resolveOrgId(opts);
  const paths = getSfgraphPaths();
  const dbPath = safeOrgDbPath(paths.data, orgId);

  if (!opts.yes) {
    console.log(`Will clear the service-id map for org=${orgId}`);
    console.log(`  Database: ${dbPath}`);
    console.log(
      "  This does NOT touch nodes, edges, snippets, or snapshots — only the",
    );
    console.log(
      "  rename-detection lookup table. The next ingest will re-populate it.",
    );
    console.log("  Re-run with --yes to confirm.");
    return;
  }

  const store = new SqliteGraphStore({ dbPath });
  await store.init();
  try {
    // The reset helper takes the raw better-sqlite3 handle; the store
    // exposes it via the `db` property convention used by other admin
    // commands (audit.ts uses the same pattern through GraphStore's
    // public methods).
    const result = resetServiceIdMap(
      (store as unknown as { db: Parameters<typeof resetServiceIdMap>[0] }).db,
      orgId,
    );
    console.log(
      `reset-elemid-map: cleared ${result.cleared} entries for org=${orgId}`,
    );
  } finally {
    await store.close();
  }
}
