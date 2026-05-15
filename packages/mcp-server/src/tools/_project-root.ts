import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { ConfigError } from "@ryanstark24/sfgraph-shared";

/**
 * Resolve and sanity-check a user-supplied `project_root` for the WIP tools.
 *
 * The WIP tools walk the local filesystem under `project_root`. Without a
 * containment check, a malicious or careless caller can point them at `/`,
 * `/etc`, or anywhere the user can read — turning local read-access into
 * an MCP-mediated arbitrary-file read.
 *
 * This helper:
 *   1. Resolves `project_root` to an absolute path via `path.resolve`.
 *   2. Verifies the path exists and is a directory.
 *   3. Requires an `sfdx-project.json` at the root (proof this is a real
 *      Salesforce DX project, not `/home/victim`).
 *   4. Returns the `realpath`-resolved root so downstream walkers operate
 *      on a stable, symlink-resolved path.
 *
 * Throws `ConfigError` on any failure.
 */
export function resolveWipProjectRoot(rawProjectRoot: string): string {
  const abs = path.resolve(rawProjectRoot);
  if (!existsSync(abs)) {
    throw new ConfigError(`project_root does not exist: ${rawProjectRoot}`);
  }
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(abs);
  } catch (e) {
    throw new ConfigError(`project_root not readable: ${(e as Error).message}`);
  }
  if (!stats.isDirectory()) {
    throw new ConfigError(`project_root is not a directory: ${rawProjectRoot}`);
  }
  const real = realpathSync(abs);
  const sfdxProject = path.join(real, "sfdx-project.json");
  if (!existsSync(sfdxProject)) {
    throw new ConfigError(
      `project_root is not a Salesforce DX project (no sfdx-project.json at ${real}). WIP tools refuse to walk arbitrary filesystem locations.`,
    );
  }
  return real;
}
