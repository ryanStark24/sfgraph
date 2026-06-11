import { asOrgId } from "@ryanstark24/sfgraph-shared";
import { ConsoleLogger } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { buildJsforceMock } from "../../extractors/live-org/__tests__/_jsforce-mock.js";
import { wrapConnectionReadOnly } from "../../extractors/live-org/read-only-proxy.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { liveIngest } from "../live-ingest.js";

const ORG = asOrgId("00Dxx0000000WMRK");

function makeResolved(conn: any) {
  return {
    orgId: ORG,
    alias: "test",
    username: "test@example.com",
    instanceUrl: "https://example.my.salesforce.com",
    apiVersion: "60.0",
    conn: wrapConnectionReadOnly(conn),
  };
}

/**
 * N4 regression: incremental can't fetch changed-member content yet, so it skips
 * those members. It must NOT advance the sync watermark past them — otherwise the
 * next incremental starts after the change and never sees it (silent data loss).
 */
describe("liveIngest incremental — watermark held when changes go unfetched", () => {
  it("does not advance last_synced_at when a changed (non-obsolete) member is skipped", async () => {
    const graphStore = new SqliteGraphStore({ dbPath: ":memory:" });
    await graphStore.init();
    const now = Date.now();
    const priorWatermark = now - 60_000;
    graphStore.upsertOrg({
      id: ORG,
      alias: "test",
      instanceUrl: "https://x",
      apiVersion: "60.0",
      createdAt: now - 120_000,
      lastSyncedAt: priorWatermark,
    });

    // SourceMember reports a CHANGED (not obsolete) class — incremental detects
    // it but cannot fetch its body, so it's counted + skipped.
    const conn = buildJsforceMock({
      toolingQueryResults: {
        "*": {
          records: [
            {
              Id: "smr1",
              MemberType: "ApexClass",
              MemberName: "ChangedClass",
              RevisionCounter: 2,
              IsNameObsolete: false,
              LastModifiedDate: new Date().toISOString(),
            },
          ],
          done: true,
        },
      },
      metadataList: {},
    });

    const result = await liveIngest({
      alias: "test",
      graphStore,
      mode: "incremental",
      preResolved: makeResolved(conn),
      logger: new ConsoleLogger("error"),
      skipSnapshot: true,
    });

    // It warned about the unfetched change…
    expect(result.warnings.some((w) => w.includes("contentNotFetched"))).toBe(true);
    // …and HELD the watermark at its prior value (did not step over the change).
    expect(graphStore.getOrg(ORG)?.lastSyncedAt).toBe(priorWatermark);
  });
});
