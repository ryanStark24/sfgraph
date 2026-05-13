import path from "node:path";
import { SqliteGraphStore, SqliteSnapshotStore, liveIngest } from "@sfgraph/core";
import { ConsoleLogger, SfgraphError, getSfgraphPaths } from "@sfgraph/shared";

export interface IngestOpts {
  org?: string | undefined;
  mode?: "full" | "incremental" | "auto" | undefined;
  db?: string | undefined;
}

export async function ingestCmd(opts: IngestOpts): Promise<void> {
  const logger = new ConsoleLogger("info");
  try {
    const { resolveOrg, resolveDefaultOrgAlias } = await import("@sfgraph/core");

    let alias: string;
    if (opts.org) {
      alias = opts.org;
    } else {
      const detected = await resolveDefaultOrgAlias();
      if (!detected) {
        console.error(
          "ingest: no --org provided and no default org configured. Run `sf config set target-org <alias>` or pass --org.",
        );
        process.exitCode = 1;
        return;
      }
      alias = detected;
      logger.info(`ingest: using default org from sf config: ${alias}`);
    }

    // Resolve org first so we can pick the db path based on its orgId.
    const resolved = await resolveOrg(alias);

    const dbPath = opts.db ?? path.join(getSfgraphPaths().data, `${resolved.orgId}.sqlite`);
    const graphStore = new SqliteGraphStore({ dbPath });
    await graphStore.init();
    const snapshotStore = new SqliteSnapshotStore({
      dbPath,
      db: graphStore.db,
      skipMigrations: true,
    });
    await snapshotStore.init();

    const startedAt = Date.now();
    logger.info(`ingest: starting alias=${alias} db=${dbPath}`);
    const result = await liveIngest({
      alias,
      mode: opts.mode ?? "auto",
      graphStore,
      snapshotStore,
      logger,
      preResolved: resolved,
    });
    logger.info("ingest: capabilities", result.capabilities as unknown as Record<string, unknown>);
    logger.info(
      `ingest: complete mode=${result.mode} members=${result.membersProcessed} deletions=${result.deletions} parseErrors=${result.parseErrors} elapsed=${Date.now() - startedAt}ms`,
    );
    await graphStore.close();
  } catch (e) {
    if (e instanceof SfgraphError) {
      console.error(`[${e.code}] ${e.message}`);
    } else {
      console.error((e as Error).message);
    }
    process.exitCode = 1;
  }
}
