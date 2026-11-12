import { ConsoleLogger, asOrgId } from "@ryanstark24/sfgraph-shared";
import { afterEach, describe, expect, it } from "vitest";
import { buildJsforceMock } from "../../extractors/live-org/__tests__/_jsforce-mock.js";
import { wrapConnectionReadOnly } from "../../extractors/live-org/read-only-proxy.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { liveIngest } from "../live-ingest.js";

const APEX =
  "SELECT Id, Name, Body, NamespacePrefix, LastModifiedDate, ApiVersion, Status FROM ApexClass";

function org(withDescribe: { describes: string[] }) {
  const conn: any = buildJsforceMock({
    toolingQueryResults: {
      [APEX]: {
        records: [
          {
            Id: "01p1",
            Name: "Reader",
            Body: "public class Reader { public void go() { List<Zzzobj> l = [SELECT Id FROM Zzzobj]; } }",
            LastModifiedDate: "2025-01-01T00:00:00Z",
          },
        ],
        done: true,
      },
    },
  });
  // Zzzobj is a standard-looking name no gate lets through, but the org lists it.
  conn.describeGlobal = async () => ({
    sobjects: [{ name: "Zzzobj", queryable: true, label: "Zzz" }],
  });
  conn.sobject = (name: string) => ({
    describe: async () => {
      withDescribe.describes.push(name);
      return {
        name,
        label: "Zzz",
        fields: [
          { name: "Id", type: "id" },
          { name: "Size__c", type: "double", custom: true },
        ],
      };
    },
  });
  return {
    orgId: asOrgId("00Dxx0000000RECEAA"),
    alias: "rec",
    username: "t@example.com",
    instanceUrl: "https://example.my.salesforce.com",
    apiVersion: "60.0",
    conn: wrapConnectionReadOnly(conn),
  };
}

async function run(env?: string) {
  const prev = process.env.SFGRAPH_RECOVER_OBJECTS;
  if (env !== undefined) process.env.SFGRAPH_RECOVER_OBJECTS = env;
  try {
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    const calls = { describes: [] as string[] };
    const resolved = org(calls);
    const res = await liveIngest({
      alias: "rec",
      graphStore: store,
      mode: "full",
      preResolved: resolved,
      logger: new ConsoleLogger("error"),
      skipSnapshot: true,
    });
    return { store, res, calls, orgId: resolved.orgId };
  } finally {
    if (prev === undefined) Reflect.deleteProperty(process.env, "SFGRAPH_RECOVER_OBJECTS");
    else process.env.SFGRAPH_RECOVER_OBJECTS = prev;
  }
}

afterEach(() => {
  Reflect.deleteProperty(process.env, "SFGRAPH_RECOVER_OBJECTS");
});

describe("object recovery inside liveIngest", () => {
  it("describes and adds an object that code references but a gate dropped", async () => {
    const { store, res, orgId } = await run();
    expect(res.objectRecovery?.recovered).toEqual(["Zzzobj"]);
    expect(store.getNode(orgId, "CustomObject:Zzzobj" as never)).not.toBeNull();
    expect(store.getNode(orgId, "CustomField:Zzzobj.Size__c" as never)).not.toBeNull();
  });

  it("is off with SFGRAPH_RECOVER_OBJECTS=0", async () => {
    const { store, res, orgId, calls } = await run("0");
    expect(res.objectRecovery).toBeUndefined();
    expect(calls.describes).not.toContain("Zzzobj");
    expect(store.getNode(orgId, "CustomObject:Zzzobj" as never)).toBeNull();
  });
});
