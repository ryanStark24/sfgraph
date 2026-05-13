import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { ConsoleLogger } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { buildJsforceMock } from "../../extractors/live-org/__tests__/_jsforce-mock.js";
import { wrapConnectionReadOnly } from "../../extractors/live-org/read-only-proxy.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { liveIngest } from "../live-ingest.js";

function makeResolved(conn: any) {
  return {
    orgId: asOrgId("00Dxx0000000DELE"),
    alias: "test",
    username: "test@example.com",
    instanceUrl: "https://example.my.salesforce.com",
    apiVersion: "60.0",
    conn: wrapConnectionReadOnly(conn),
  };
}

describe("liveIngest incremental deletion via SourceMember", () => {
  it("deletes a node + its edges when SourceMember reports IsNameObsolete=true", async () => {
    const orgId = asOrgId("00Dxx0000000DELE");
    const qname = asQualifiedName("ApexClass:GoneClass");

    // Pre-seed the graph with one node and one edge involving GoneClass.
    const graphStore = new SqliteGraphStore({ dbPath: ":memory:" });
    await graphStore.init();
    const now = Date.now();
    graphStore.upsertOrg({
      id: orgId,
      alias: "test",
      instanceUrl: "https://x",
      apiVersion: "60.0",
      createdAt: now,
      // Mark already-synced so auto resolves to incremental once caps allow.
      lastSyncedAt: now - 1000,
    });
    graphStore.mergeNodes([
      {
        orgId,
        qualifiedName: qname,
        label: "ApexClass",
        attributes: { name: "GoneClass" },
        sourceHash: asSha256("a".repeat(64)),
        firstSeenAt: now,
        lastSeenAt: now,
        lastModifiedAt: now,
      },
    ]);
    graphStore.mergeEdges([
      {
        orgId,
        srcQualifiedName: qname,
        dstQualifiedName: asQualifiedName("ApexClass:Other"),
        relType: "REFERENCES",
        attributes: {},
        firstSeenAt: now,
        lastSeenAt: now,
      },
    ]);

    expect(graphStore.getNode(orgId, qname)).not.toBeNull();
    expect(graphStore.listEdgesFrom(orgId, qname).length).toBeGreaterThan(0);

    const conn = buildJsforceMock({
      // Use wildcard so any SourceMember SOQL (dynamic timestamp) matches.
      toolingQueryResults: {
        "*": {
          records: [
            {
              Id: "smr1",
              MemberType: "ApexClass",
              MemberName: "GoneClass",
              RevisionCounter: 1,
              IsNameObsolete: true,
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

    expect(result.deletions).toBeGreaterThanOrEqual(1);
    expect(graphStore.getNode(orgId, qname)).toBeNull();
    expect(graphStore.listEdgesFrom(orgId, qname).length).toBe(0);
  });
});
