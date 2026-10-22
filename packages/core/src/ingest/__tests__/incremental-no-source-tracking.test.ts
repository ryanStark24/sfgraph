import { asOrgId } from "@ryanstark24/sfgraph-shared";
import { ConsoleLogger } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { buildJsforceMock } from "../../extractors/live-org/__tests__/_jsforce-mock.js";
import { wrapConnectionReadOnly } from "../../extractors/live-org/read-only-proxy.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { liveIngest } from "../live-ingest.js";

const ORG = asOrgId("00Dxx0000000NOST");

/**
 * An org without source tracking (Partial / Full Copy sandbox, production)
 * has no SourceMember table. `--mode incremental` there used to query it
 * anyway and fail with "sObject type 'SourceMember' is not supported",
 * ingesting nothing. It now runs a full sync, as auto does.
 */
describe("liveIngest incremental on an org without source tracking", () => {
  it("falls back to full and never queries SourceMember", async () => {
    const graphStore = new SqliteGraphStore({ dbPath: ":memory:" });
    await graphStore.init();
    const now = Date.now();
    graphStore.upsertOrg({
      id: ORG,
      alias: "test",
      instanceUrl: "https://x",
      apiVersion: "60.0",
      createdAt: now - 120_000,
      lastSyncedAt: now - 60_000,
    });
    const toolingSoql: string[] = [];
    const conn = buildJsforceMock({ metadataList: {} });
    const query = conn.tooling.query;
    conn.tooling.query = async (soql: string) => {
      toolingSoql.push(soql);
      if (soql.includes("FROM SourceMember")) {
        throw new Error("sObject type 'SourceMember' is not supported.");
      }
      return query(soql);
    };

    const result = await liveIngest({
      alias: "test",
      graphStore,
      mode: "incremental",
      preResolved: {
        orgId: ORG,
        alias: "test",
        username: "test@example.com",
        instanceUrl: "https://example.my.salesforce.com",
        apiVersion: "60.0",
        conn: wrapConnectionReadOnly(conn),
      },
      logger: new ConsoleLogger("error"),
      skipSnapshot: true,
    });

    expect(result.mode).toBe("full");
    expect(result.warnings).toContain("mode:incremental-unavailable:no-source-tracking");
    expect(toolingSoql.some((q) => q.includes("FROM SourceMember"))).toBe(false);
  });
});
