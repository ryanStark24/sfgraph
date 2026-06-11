import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { ConsoleLogger } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildJsforceMock } from "../../extractors/live-org/__tests__/_jsforce-mock.js";
import { wrapConnectionReadOnly } from "../../extractors/live-org/read-only-proxy.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { liveIngest } from "../live-ingest.js";

const ORG = asOrgId("00Dxx0000000CASC");
function makeResolved(conn: any) {
  return {
    orgId: ORG,
    alias: "test",
    username: "t@e.com",
    instanceUrl: "https://x.my.salesforce.com",
    apiVersion: "60.0",
    conn: wrapConnectionReadOnly(conn),
  };
}

let store: SqliteGraphStore;
beforeEach(async () => {
  store = new SqliteGraphStore({ dbPath: ":memory:" });
  await store.init();
});
afterEach(async () => {
  await store.close();
});

function node(label: string, qname: string) {
  const now = Date.now();
  return {
    orgId: ORG,
    qualifiedName: asQualifiedName(qname),
    label,
    attributes: {},
    sourceHash: asSha256("a".repeat(64)),
    firstSeenAt: now,
    lastSeenAt: now,
    lastModifiedAt: now,
  };
}

describe("incremental obsolete-member deletion — label mapping + child cascade", () => {
  it("deletes an LWC (LightningComponentBundle) and a class's ApexMethod children", async () => {
    const now = Date.now();
    store.upsertOrg({
      id: ORG,
      alias: "test",
      instanceUrl: "https://x",
      apiVersion: "60.0",
      createdAt: now,
      lastSyncedAt: now - 1000,
    });
    // LWC stored as LWC:myCmp (NOT LightningComponentBundle:myCmp).
    store.mergeNodes([node("LWC", "LWC:myCmp")]);
    // Class with a method child wired via CONTAINS_METHOD.
    store.mergeNodes([
      node("ApexClass", "ApexClass:Foo"),
      node("ApexMethod", "ApexMethod:Foo.bar(0)"),
    ]);
    store.mergeEdges([
      {
        orgId: ORG,
        srcQualifiedName: asQualifiedName("ApexClass:Foo"),
        dstQualifiedName: asQualifiedName("ApexMethod:Foo.bar(0)"),
        relType: "CONTAINS_METHOD",
        attributes: {},
        firstSeenAt: now,
        lastSeenAt: now,
      },
    ]);

    const conn = buildJsforceMock({
      toolingQueryResults: {
        "*": {
          records: [
            {
              Id: "s1",
              MemberType: "LightningComponentBundle",
              MemberName: "myCmp",
              RevisionCounter: 1,
              IsNameObsolete: true,
              LastModifiedDate: new Date().toISOString(),
            },
            {
              Id: "s2",
              MemberType: "ApexClass",
              MemberName: "Foo",
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

    await liveIngest({
      alias: "test",
      graphStore: store,
      mode: "incremental",
      preResolved: makeResolved(conn),
      logger: new ConsoleLogger("error"),
      skipSnapshot: true,
    });

    // LWC delete now resolves (was a silent no-op under the wrong label).
    expect(store.getNode(ORG, asQualifiedName("LWC:myCmp"))).toBeNull();
    // Class + its orphan-prone method child are both gone.
    expect(store.getNode(ORG, asQualifiedName("ApexClass:Foo"))).toBeNull();
    expect(store.getNode(ORG, asQualifiedName("ApexMethod:Foo.bar(0)"))).toBeNull();
  });
});
