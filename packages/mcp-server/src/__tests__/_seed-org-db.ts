import path from "node:path";
import { SqliteGraphStore } from "@ryanstark24/sfgraph-core";
import { asOrgId } from "@ryanstark24/sfgraph-shared";

/** Write a minimal but real ingested graph (`_sfgraph_orgs` row) at
 *  `<dir>/<orgId>.sqlite`, the shape the MCP default factory accepts. */
export async function seedIngestedOrgDb(dir: string, orgId: string, alias: string): Promise<void> {
  const dbPath = path.join(dir, `${orgId}.sqlite`);
  const g = new SqliteGraphStore({ dbPath, backupDir: path.join(dir, "bkp") });
  await g.init();
  g.upsertOrg({
    id: asOrgId(orgId),
    alias,
    instanceUrl: "https://example.my.salesforce.com",
    apiVersion: "62.0",
    createdAt: Date.now(),
  });
  await g.close();
}
