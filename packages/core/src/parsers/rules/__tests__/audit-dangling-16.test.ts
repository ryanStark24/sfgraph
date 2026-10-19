import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConsoleLogger } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilesystemMetadataSource } from "../../../extractors/filesystem/index.js";
import { liveIngest } from "../../../ingest/live-ingest.js";
import { offlineResolvedOrg } from "../../../ingest/offline-org.js";
import { SqliteGraphStore } from "../../../storage/sqlite/graph-store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-audit-parsers-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function w(rel: string, c: string) {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, c, "utf8");
}
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
const D = "force-app/main/default";

/**
 * Audit dangling-16: APPROVAL_USES_FORMULA builds dst CustomField:<field>
 * with no object qualifier, so the edge dangles.
 */
describe("audit dangling-16: approval entry-formula fields are object-qualified", () => {
  it("targets CustomField:Opportunity.Amount_Band__c, which resolves", async () => {
    w(
      `${D}/objects/Opportunity/fields/Amount_Band__c.field-meta.xml`,
      '<?xml version="1.0" encoding="UTF-8"?><CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>Amount_Band__c</fullName><type>Text</type></CustomField>',
    );
    w(
      `${D}/approvalProcesses/Opportunity.Big_Deal.approvalProcess-meta.xml`,
      '<?xml version="1.0" encoding="UTF-8"?><ApprovalProcess xmlns="http://soap.sforce.com/2006/04/metadata"><active>true</active><entryCriteria><formula>ISPICKVAL(Amount_Band__c, \'High\')</formula></entryCriteria></ApprovalProcess>',
    );
    const { graphStore, orgId } = await ingest();
    const src = "ApprovalProcess:Opportunity.Big_Deal";
    expect(graphStore.getNode(orgId, src as never)).not.toBeNull();
    const uses = graphStore
      .listEdgesFrom(orgId, src as never)
      .filter((e) => String(e.relType) === "APPROVAL_USES_FORMULA")
      .map((e) => String(e.dstQualifiedName));
    expect(uses).toEqual(["CustomField:Opportunity.Amount_Band__c"]);
    expect(graphStore.getNode(orgId, uses[0] as never)).not.toBeNull();
  });

  it("qualifies lookup hops and criteria items, and skips quoted / other-object names", async () => {
    w(
      `${D}/approvalProcesses/Opportunity.Mixed.approvalProcess-meta.xml`,
      '<?xml version="1.0" encoding="UTF-8"?><ApprovalProcess xmlns="http://soap.sforce.com/2006/04/metadata"><active>true</active><entryCriteria><formula>Region__r.Code__c = "Fake__c" &amp;&amp; $Setup.App__c.On__c &amp;&amp; Band__c</formula><criteriaItems><field>Opportunity.StageName</field><operation>equals</operation><value>Won</value></criteriaItems></entryCriteria></ApprovalProcess>',
    );
    const { graphStore, orgId } = await ingest();
    const uses = graphStore
      .listEdgesFrom(orgId, "ApprovalProcess:Opportunity.Mixed" as never)
      .filter((e) => String(e.relType) === "APPROVAL_USES_FORMULA")
      .map((e) => String(e.dstQualifiedName))
      .sort();
    expect(uses).toEqual(
      [
        "CustomField:Opportunity.Band__c",
        "CustomField:Opportunity.Region__c",
        "CustomField:Opportunity.StageName",
      ].sort(),
    );
  });
});
