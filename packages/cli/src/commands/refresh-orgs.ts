import { getSfgraphPaths } from "@ryanstark24/sfgraph-shared";
import { ORG_SNAPSHOT_FILENAME, writeOrgSnapshot } from "./install.js";

export interface RefreshOrgsOpts {
  /** Override the data dir (where the snapshot is written). Defaults to
   *  `getSfgraphPaths().data`. Useful in tests. */
  dataDir?: string;
  log?: (s: string) => void;
}

/**
 * Re-snapshot `sf` CLI org state (alias map, default-org, authorizations)
 * into `<dataDir>/orgs-snapshot.json`. The MCP child reads this snapshot
 * when it can't reach `~/.sf/` directly (Cursor's macOS sandbox case).
 *
 * Run this whenever sf state changes (new login, alias change, target-org
 * flipped) without having to re-do the full `sfgraph install` (which also
 * rewrites MCP config + reinstalls skills).
 */
export async function refreshOrgsCmd(opts: RefreshOrgsOpts = {}): Promise<void> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const dataDir = opts.dataDir ?? getSfgraphPaths().data;
  try {
    await writeOrgSnapshot(dataDir);
    const path = `${dataDir}/${ORG_SNAPSHOT_FILENAME}`;
    log(`✓ refreshed sf org snapshot at ${path}`);
  } catch (e) {
    log(`✗ could not refresh: ${(e as Error).message}`);
    log("  Hint: make sure `sf` is authenticated (run `sf org login web --alias <X>` first).");
    process.exitCode = 1;
  }
}
