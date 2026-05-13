import path from "node:path";
import { resolveOrg } from "@ryanstark24/sfgraph-core";
import {
  ConsoleLogger,
  SfgraphError,
  findProjectRoot,
  linkWorkspace,
} from "@ryanstark24/sfgraph-shared";

export interface LinkOpts {
  org: string;
  project?: string | undefined;
}

export async function linkCmd(opts: LinkOpts): Promise<void> {
  const logger = new ConsoleLogger("info");
  try {
    const startDir = opts.project ? path.resolve(opts.project) : process.cwd();
    const projectRoot = findProjectRoot(startDir) ?? startDir;
    const resolved = await resolveOrg(opts.org);
    const ws = await linkWorkspace(projectRoot, opts.org, resolved.orgId);
    logger.info(`Linked ${ws.projectRoot} -> org ${opts.org} (${resolved.orgId})`);
  } catch (e) {
    if (e instanceof SfgraphError) {
      console.error(`[${e.code}] ${e.message}`);
    } else {
      console.error((e as Error).message);
    }
    process.exitCode = 1;
  }
}
