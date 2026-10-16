import { createHash } from "node:crypto";
import path from "node:path";
import { asOrgId } from "@ryanstark24/sfgraph-shared";
import type { ResolvedOrg } from "../extractors/live-org/auth.js";
import type { OrgCapabilities } from "../extractors/live-org/capabilities.js";

/** Capabilities for an offline (filesystem) ingest: nothing is probed. */
export const OFFLINE_CAPS: OrgCapabilities = {
  detectedNamespaces: [],
  vlocityNamespaces: [],
  vlocityLegacy: false,
  vlocityCmt: false,
  omnistudioOncore: false,
  agentforce: false,
  experienceCloud: false,
  sourceTracking: false,
};

/** Any property access that would reach Salesforce fails loudly. */
function throwingConn(): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return undefined; // not a thenable
        return () => {
          throw new Error(`offline source: no org connection (conn.${String(prop)})`);
        };
      },
    },
  );
}

/** Synthetic org for a repo checkout. The id is shaped like a real orgId
 *  (00D + 12 chars) so MCP alias/orgId resolution treats it normally. */
export function offlineResolvedOrg(projectRoot: string, alias: string): ResolvedOrg {
  const abs = path.resolve(projectRoot);
  const hex = createHash("sha1").update(abs).digest("hex").slice(0, 10).toUpperCase();
  return {
    orgId: asOrgId(`00DFS${hex}`),
    alias,
    username: `offline:${abs}`,
    instanceUrl: `file://${abs}`,
    apiVersion: "66.0",
    conn: throwingConn(),
  } as ResolvedOrg;
}
