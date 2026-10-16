import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConsoleLogger } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilesystemMetadataSource } from "../../extractors/filesystem/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { liveIngest } from "../live-ingest.js";
import { offlineResolvedOrg } from "../offline-org.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-off-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function w(rel: string, c: string) {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, c, "utf8");
}

describe("offline liveIngest", () => {
  it("ingests a filesystem project without touching the connection", async () => {
    w("sfdx-project.json", JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
    w(
      "force-app/main/default/classes/Foo.cls",
      "public class Foo { public void a() { Account x = [SELECT Name FROM Account]; } }",
    );
    w(
      "force-app/main/default/objects/Account/Account.object-meta.xml",
      "<CustomObject><label>Account</label></CustomObject>",
    );
    w(
      "force-app/main/default/objects/Account/fields/Tier__c.field-meta.xml",
      "<CustomField><fullName>Tier__c</fullName><type>Text</type></CustomField>",
    );
    const graphStore = new SqliteGraphStore({ dbPath: ":memory:" });
    await graphStore.init();
    const resolved = offlineResolvedOrg(dir, "bench");
    const res = await liveIngest({
      alias: "bench",
      graphStore,
      mode: "auto",
      preResolved: resolved,
      metadataSource: await FilesystemMetadataSource.fromProjectRoot(dir),
      logger: new ConsoleLogger("error"),
      skipSnapshot: true,
    });
    expect(res.membersProcessed).toBeGreaterThanOrEqual(2);
    expect(graphStore.getNode(resolved.orgId, "ApexClass:Foo" as never)).not.toBeNull();
    expect(
      graphStore.getNode(resolved.orgId, "CustomField:Account.Tier__c" as never),
    ).not.toBeNull();
  });

  it("resolves DataRaptor alias, namespace-token and Rel__r.Field targets end to end", async () => {
    const NS = "%vlocity_namespace%__";
    w("sfdx-project.json", JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
    // Fields-only folders (no object-meta.xml), one namespaced.
    w(
      "force-app/main/default/objects/vlocity_ps__Widget__c/fields/Maker__c.field-meta.xml",
      "<CustomField><fullName>Maker__c</fullName><type>Lookup</type><referenceTo>Maker__c</referenceTo><relationshipName>Maker</relationshipName></CustomField>",
    );
    w(
      "force-app/main/default/objects/vlocity_ps__Widget__c/fields/Size__c.field-meta.xml",
      "<CustomField><fullName>Size__c</fullName><type>Text</type></CustomField>",
    );
    w(
      "force-app/main/default/objects/Maker__c/fields/Region__c.field-meta.xml",
      "<CustomField><fullName>Region__c</fullName><type>Text</type></CustomField>",
    );
    const dp = "vlocity/datapacks/DataRaptor/WidgetFetch";
    w(
      `${dp}/WidgetFetch_DataPack.json`,
      JSON.stringify({
        Name: "WidgetFetch",
        [`${NS}Type__c`]: "Extract",
        [`${NS}DRMapItem__c`]: "WidgetFetch_Mappings.json",
      }),
    );
    w(
      `${dp}/WidgetFetch_Mappings.json`,
      JSON.stringify([
        {
          [`${NS}InterfaceObjectName__c`]: `${NS}Widget__c`,
          [`${NS}InterfaceFieldAPIName__c`]: "Id",
          [`${NS}InterfaceObjectLookupOrder__c`]: 1,
          [`${NS}DomainObjectAPIName__c`]: "json",
          [`${NS}DomainObjectFieldAPIName__c`]: "W",
        },
        {
          [`${NS}InterfaceFieldAPIName__c`]: "W:Size__c",
          [`${NS}DomainObjectAPIName__c`]: "json",
          [`${NS}DomainObjectFieldAPIName__c`]: "W:Size",
        },
        {
          [`${NS}InterfaceFieldAPIName__c`]: "W:Maker__r.Region__c",
          [`${NS}DomainObjectAPIName__c`]: "json",
          [`${NS}DomainObjectFieldAPIName__c`]: "W:Region",
        },
      ]),
    );
    const graphStore = new SqliteGraphStore({ dbPath: ":memory:" });
    await graphStore.init();
    const resolved = offlineResolvedOrg(dir, "bench");
    await liveIngest({
      alias: "bench",
      graphStore,
      mode: "auto",
      preResolved: resolved,
      metadataSource: await FilesystemMetadataSource.fromProjectRoot(dir),
      logger: new ConsoleLogger("error"),
      skipSnapshot: true,
    });
    const obj = graphStore.getNode(resolved.orgId, "CustomObject:vlocity_ps__Widget__c" as never);
    expect(obj?.attributes.stub).toBe(true);
    const dsts = graphStore
      .listEdgesFrom(resolved.orgId, "DataRaptor:WidgetFetch" as never)
      .filter((e) => e.relType === "DR_READS_FIELD")
      .map((e) => String(e.dstQualifiedName))
      .sort();
    expect(dsts).toEqual([
      "CustomField:Maker__c.Region__c",
      "CustomField:vlocity_ps__Widget__c.Id",
      "CustomField:vlocity_ps__Widget__c.Maker__c",
      "CustomField:vlocity_ps__Widget__c.Size__c",
    ]);
  });

  it("offlineResolvedOrg is deterministic, valid-shaped, and its conn throws", () => {
    const a = offlineResolvedOrg(dir, "bench");
    expect(a.orgId).toMatch(/^00DFS[0-9A-F]{10}$/);
    expect(offlineResolvedOrg(dir, "bench").orgId).toBe(a.orgId);
    expect(() =>
      (a.conn as { query: (q: string) => unknown }).query("SELECT Id FROM Account"),
    ).toThrow(/offline source: no org connection/);
  });
});
