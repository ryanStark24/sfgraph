import { ReadOnlyViolationError, asOrgId } from "@sfgraph/shared";
import { describe, expect, it } from "vitest";
import { buildJsforceMock } from "../../extractors/live-org/__tests__/_jsforce-mock.js";
import { wrapConnectionReadOnly } from "../../extractors/live-org/read-only-proxy.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { liveIngest } from "../live-ingest.js";

describe("read-only wrapping (integration)", () => {
  it("no writes are attempted during a live-ingest run", async () => {
    const writeCounter = { count: 0 };
    const conn = buildJsforceMock({
      writeCounter,
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
    const wrapped = wrapConnectionReadOnly(conn);

    const graphStore = new SqliteGraphStore({ dbPath: ":memory:" });
    await graphStore.init();

    const result = await liveIngest({
      alias: "ro-test",
      graphStore,
      mode: "full",
      preResolved: {
        orgId: asOrgId("00Dxx0000000RO_AA"),
        alias: "ro-test",
        username: "ro@example.com",
        instanceUrl: "https://example.my.salesforce.com",
        apiVersion: "60.0",
        conn: wrapped,
      },
      skipSnapshot: true,
    });
    expect(result).toBeDefined();
    expect(writeCounter.count).toBe(0);
  });

  it("wrapped connection throws synchronously on sobject.create({})", () => {
    const conn = buildJsforceMock();
    const wrapped = wrapConnectionReadOnly(conn);
    expect(() => wrapped.sobject("Account").create({})).toThrowError(ReadOnlyViolationError);
  });
});
