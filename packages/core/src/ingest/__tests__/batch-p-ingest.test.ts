import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConsoleLogger, asQualifiedName } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilesystemMetadataSource } from "../../extractors/filesystem/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { liveIngest } from "../live-ingest.js";
import { offlineResolvedOrg } from "../offline-org.js";

/**
 * Task 14 batch P end to end (filesystem project → full ingest):
 * ApexPage controllers from `.page` markup (rule 9), SOQL relationship paths
 * resolved through lookup metadata (rule 2) and lowercase test targets
 * resolved against known classes (rule 6).
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-batchp-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const D = "force-app/main/default";
function w(rel: string, c: string) {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, c, "utf8");
}
const META = `<?xml version="1.0" encoding="UTF-8"?><ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>59.0</apiVersion><status>Active</status></ApexClass>`;

async function ingest() {
  w("sfdx-project.json", JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
  const graphStore = new SqliteGraphStore({ dbPath: ":memory:" });
  await graphStore.init();
  const resolved = offlineResolvedOrg(dir, "bench");
  await liveIngest({
    alias: "bench",
    graphStore,
    mode: "full",
    preResolved: resolved,
    metadataSource: await FilesystemMetadataSource.fromProjectRoot(dir),
    logger: new ConsoleLogger("error"),
    skipSnapshot: true,
  });
  return { graphStore, orgId: resolved.orgId };
}

describe("batch P: full ingest", () => {
  it("links pages, relationship paths and lowercase test targets", async () => {
    w(
      `${D}/pages/LeadPage.page`,
      `<apex:page controller="LeadCheck" showHeader="false"><apex:form/></apex:page>`,
    );
    w(
      `${D}/pages/LeadPage.page-meta.xml`,
      `<?xml version="1.0" encoding="UTF-8"?><ApexPage xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>59.0</apiVersion><label>LeadPage</label></ApexPage>`,
    );
    w(
      `${D}/classes/LeadCheck.cls`,
      `public class LeadCheck {
        public LeadCheck() {
          List<Widget__c> ws = [SELECT Id, Maker__r.Region__c FROM Widget__c WHERE Maker__r.Active__c = true];
        }
      }`,
    );
    w(`${D}/classes/LeadCheck.cls-meta.xml`, META);
    w(
      `${D}/classes/LeadCheckTest.cls`,
      `@isTest private class LeadCheckTest {
        @isTest static void t() { LeadCheck v = new LeadCheck(); }
      }`,
    );
    w(`${D}/classes/LeadCheckTest.cls-meta.xml`, META);
    w(
      `${D}/objects/Widget__c/Widget__c.object-meta.xml`,
      `<?xml version="1.0" encoding="UTF-8"?><CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><label>Widget</label></CustomObject>`,
    );
    w(
      `${D}/objects/Widget__c/fields/Maker__c.field-meta.xml`,
      `<?xml version="1.0" encoding="UTF-8"?><CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>Maker__c</fullName><type>Lookup</type><referenceTo>Maker__c</referenceTo><relationshipName>Makers</relationshipName></CustomField>`,
    );
    w(
      `${D}/objects/Maker__c/Maker__c.object-meta.xml`,
      `<?xml version="1.0" encoding="UTF-8"?><CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><label>Maker</label></CustomObject>`,
    );
    const { graphStore, orgId } = await ingest();
    const from = (q: string) =>
      graphStore
        .listEdgesFrom(orgId, asQualifiedName(q))
        .map((e) => `${e.relType} ${String(e.dstQualifiedName)}`)
        .sort();
    expect(from("ApexPage:LeadPage")).toContain("CONTROLLED_BY ApexClass:LeadCheck");
    const cls = from("ApexClass:LeadCheck");
    expect(cls).toContain("EXECUTES_SOQL CustomObject:Widget__c");
    expect(cls).toContain("READS_FIELD CustomField:Maker__c.Region__c");
    expect(cls).toContain("READS_FIELD CustomField:Maker__c.Active__c");
    expect(cls).toContain("REFERENCES CustomObject:Maker__c");
    expect(cls.filter((d) => d.includes("Maker__r"))).toEqual([]);
    expect(from("ApexClass:LeadCheckTest")).toContain("IS_TEST_FOR ApexClass:LeadCheck");
  });
});
