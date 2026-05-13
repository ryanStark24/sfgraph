import { asOrgId, asQualifiedName } from "@ryanstark24/sfgraph-shared";
import { ConsoleLogger } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { buildJsforceMock } from "../../extractors/live-org/__tests__/_jsforce-mock.js";
import { wrapConnectionReadOnly } from "../../extractors/live-org/read-only-proxy.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { SqliteSnapshotStore } from "../../storage/sqlite/snapshot-store.js";
import { liveIngest } from "../live-ingest.js";

function makeResolved(conn: any) {
  return {
    orgId: asOrgId("00Dxx0000000ABCEAA"),
    alias: "test",
    username: "test@example.com",
    instanceUrl: "https://example.my.salesforce.com",
    apiVersion: "60.0",
    conn: wrapConnectionReadOnly(conn),
  };
}

describe("liveIngest", () => {
  it("ingests apex members from a mocked org and writes nodes", async () => {
    const conn = buildJsforceMock({
      toolingQueryResults: {
        "SELECT Id, Name, Body, NamespacePrefix, LastModifiedDate FROM ApexClass": {
          records: [
            {
              Id: "01p1",
              Name: "Hello",
              Body: "public class Hello { public void greet() {} }",
              LastModifiedDate: "2025-01-01T00:00:00Z",
            },
          ],
          done: true,
        },
        "SELECT Id, Name, Body, NamespacePrefix, LastModifiedDate, TableEnumOrId FROM ApexTrigger":
          {
            records: [],
            done: true,
          },
        "SELECT Id, DeveloperName, NamespacePrefix, LastModifiedDate FROM LightningComponentBundle":
          {
            records: [],
            done: true,
          },
        "SELECT QualifiedApiName, NamespacePrefix, LastModifiedDate FROM EntityDefinition WHERE IsCustomSetting=false AND IsCustomizable=true":
          { records: [], done: true },
      },
      metadataList: {
        Flow: [],
        Profile: [],
        PermissionSet: [],
        SharingRules: [],
        NamedCredential: [],
        ExternalServiceRegistration: [],
      },
    });

    const graphStore = new SqliteGraphStore({ dbPath: ":memory:" });
    await graphStore.init();

    const result = await liveIngest({
      alias: "test",
      graphStore,
      mode: "full",
      preResolved: makeResolved(conn),
      logger: new ConsoleLogger("error"),
      skipSnapshot: true,
    });

    expect(result.membersProcessed).toBeGreaterThan(0);
    expect(graphStore.countNodes(result.orgId)).toBeGreaterThan(0);
  });

  it("creates a pre-sync auto snapshot when a snapshotStore is provided", async () => {
    const conn = buildJsforceMock({
      toolingQueryResults: {
        "SELECT Id, Name, Body, NamespacePrefix, LastModifiedDate FROM ApexClass": {
          records: [],
          done: true,
        },
        "SELECT Id, Name, Body, NamespacePrefix, LastModifiedDate, TableEnumOrId FROM ApexTrigger":
          {
            records: [],
            done: true,
          },
        "SELECT Id, DeveloperName, NamespacePrefix, LastModifiedDate FROM LightningComponentBundle":
          {
            records: [],
            done: true,
          },
        "SELECT QualifiedApiName, NamespacePrefix, LastModifiedDate FROM EntityDefinition WHERE IsCustomSetting=false AND IsCustomizable=true":
          { records: [], done: true },
      },
      metadataList: {
        Flow: [],
        Profile: [],
        PermissionSet: [],
        SharingRules: [],
        NamedCredential: [],
        ExternalServiceRegistration: [],
      },
    });

    const graphStore = new SqliteGraphStore({ dbPath: ":memory:" });
    await graphStore.init();
    const snapshotStore = new SqliteSnapshotStore({
      dbPath: ":memory:",
      db: graphStore.db,
      skipMigrations: true,
    });
    await snapshotStore.init();

    const result = await liveIngest({
      alias: "test",
      graphStore,
      snapshotStore,
      mode: "full",
      preResolved: makeResolved(conn),
      logger: new ConsoleLogger("error"),
    });

    const snaps = snapshotStore.listSnapshots(result.orgId);
    expect(snaps.length).toBeGreaterThanOrEqual(1);
    expect(snaps[0]?.isAuto).toBe(true);
  });

  it("upserts snippets from the apex parser", async () => {
    const conn = buildJsforceMock({
      toolingQueryResults: {
        "SELECT Id, Name, Body, NamespacePrefix, LastModifiedDate FROM ApexClass": {
          records: [
            {
              Id: "01p1",
              Name: "Hello",
              Body: "public class Hello { public void greet() { return; } }",
              LastModifiedDate: "2025-01-01T00:00:00Z",
            },
          ],
          done: true,
        },
        "SELECT Id, Name, Body, NamespacePrefix, LastModifiedDate, TableEnumOrId FROM ApexTrigger":
          { records: [], done: true },
        "SELECT Id, DeveloperName, NamespacePrefix, LastModifiedDate FROM LightningComponentBundle":
          { records: [], done: true },
        "SELECT QualifiedApiName, NamespacePrefix, LastModifiedDate FROM EntityDefinition WHERE IsCustomSetting=false AND IsCustomizable=true":
          { records: [], done: true },
      },
      metadataList: {
        Flow: [],
        Profile: [],
        PermissionSet: [],
        SharingRules: [],
        NamedCredential: [],
        ExternalServiceRegistration: [],
      },
    });

    const graphStore = new SqliteGraphStore({ dbPath: ":memory:" });
    await graphStore.init();

    const result = await liveIngest({
      alias: "test",
      graphStore,
      mode: "full",
      preResolved: makeResolved(conn),
      logger: new ConsoleLogger("error"),
      skipSnapshot: true,
    });

    const snippet = graphStore.getSnippet(
      result.orgId,
      asQualifiedName("ApexMethod:Hello.greet(0)"),
    );
    expect(snippet).not.toBeNull();
    expect(snippet?.sourceFormat).toBe("apex");
    expect(snippet?.sourceText).toContain("return;");
  });
});
