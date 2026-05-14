import path from "node:path";
import {
  SqliteGraphStore,
  analyze,
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

export interface WipOpts {
  depth?: number | undefined;
  mode?: "changed-only" | "full-folder" | undefined;
  project?: string | undefined;
  org?: string | undefined;
}

export async function wipCmd(opts: WipOpts): Promise<void> {
  const logger = new ConsoleLogger("info");
  try {
    const startDir = opts.project ? path.resolve(opts.project) : process.cwd();
    const projectRoot = findProjectRoot(startDir) ?? startDir;

    // Resolve orgId: --org → workspace binding → default alias
    let orgId: string | null = null;
    if (opts.org) {
      const resolved = await resolveOrg(opts.org);
      orgId = resolved.orgId;
    } else {
      const ws = await readWorkspace(projectRoot);
      if (ws?.orgId) {
        orgId = ws.orgId;
      } else {
        const alias = await resolveDefaultOrgAlias();
        if (!alias) {
          throw new ConfigError(
            "wip: no --org provided, no workspace binding, and no default org configured. Run `sfgraph link --org <alias>` or pass --org.",
          );
        }
        const resolved = await resolveOrg(alias);
        orgId = resolved.orgId;
      }
    }

    const dbPath = safeOrgDbPath(getSfgraphPaths().data, orgId);
    const graphStore = new SqliteGraphStore({ dbPath });
    await graphStore.init();
    try {
      const result = await analyze.analyzeLocalImpact({
        graphStore,
        orgId: asOrgId(orgId),
        projectRoot,
        depth: opts.depth ?? 3,
        mode: opts.mode ?? "changed-only",
        logger,
      });
      console.log(
        `WIP impact: changed=${result.changedQnames.length} added=${result.addedQnames.length} removed=${result.removedQnames.length} dependents=${result.dependents.length}`,
      );
      console.log("\n```mermaid");
      console.log(result.mermaid);
      console.log("```");
    } finally {
      await graphStore.close();
    }
  } catch (e) {
    if (e instanceof SfgraphError) {
      console.error(`[${e.code}] ${e.message}`);
    } else {
      console.error((e as Error).message);
    }
    process.exitCode = 1;
  }
}
