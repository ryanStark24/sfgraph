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
  dir = mkdtempSync(path.join(tmpdir(), "sfg-wf-lineage-"));
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

const WF = `<?xml version="1.0" encoding="UTF-8"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
  <fieldUpdates>
    <fullName>Set_Status_Approved</fullName>
    <field>Status__c</field>
    <literalValue>Approved</literalValue>
    <operation>Literal</operation>
  </fieldUpdates>
  <fieldUpdates>
    <fullName>Copy_Total</fullName>
    <field>Total__c</field>
    <formula>Amount__c * IF(Status__c = "Other__c", 1, 2) + Parent__r.Name</formula>
    <operation>Formula</operation>
  </fieldUpdates>
  <rules>
    <fullName>Approve_Big_Orders</fullName>
    <active>true</active>
    <criteriaItems>
      <field>Acme_Order__c.Region__c</field>
      <operation>equals</operation>
      <value>West</value>
    </criteriaItems>
    <actions><name>Set_Status_Approved</name><type>FieldUpdate</type></actions>
    <triggerType>onCreateOnly</triggerType>
  </rules>
  <rules>
    <fullName>Recompute_Total</fullName>
    <active>true</active>
    <formula>AND(Amount__c &gt; 100, Priority__c = "High")</formula>
    <actions><name>Copy_Total</name><type>FieldUpdate</type></actions>
    <actions><name>Notify_Owner</name><type>Alert</type></actions>
    <triggerType>onAllChanges</triggerType>
  </rules>
</Workflow>`;

describe("S-1.8.1-009: workflow per-update writers and reads", () => {
  it("emits WorkflowFieldUpdate nodes with WRITES_FIELD and READS_FIELD edges", async () => {
    w(`${D}/workflows/Acme_Order__c.workflow-meta.xml`, WF);
    const { graphStore, orgId } = await ingest();
    const from = (q: string) =>
      graphStore
        .listEdgesFrom(orgId, q as never)
        .filter((e) => String(e.relType) !== "REFERENCES")
        .map((e) => `${String(e.relType)}>${String(e.dstQualifiedName)}`)
        .sort();

    const lit = "WorkflowFieldUpdate:Acme_Order__c.Set_Status_Approved";
    const frm = "WorkflowFieldUpdate:Acme_Order__c.Copy_Total";
    expect(graphStore.getNode(orgId, lit as never)).not.toBeNull();
    expect(graphStore.getNode(orgId, frm as never)).not.toBeNull();
    expect(from(lit)).toEqual(["WRITES_FIELD>CustomField:Acme_Order__c.Status__c"]);
    expect(from(frm)).toEqual([
      "READS_FIELD>CustomField:Acme_Order__c.Amount__c",
      "READS_FIELD>CustomField:Acme_Order__c.Parent__c",
      "READS_FIELD>CustomField:Acme_Order__c.Status__c",
      "WRITES_FIELD>CustomField:Acme_Order__c.Total__c",
    ]);

    expect(from("WorkflowRule:Acme_Order__c.Approve_Big_Orders")).toEqual([
      "READS_FIELD>CustomField:Acme_Order__c.Region__c",
      "TRIGGER_FIRES_ON>CustomObject:Acme_Order__c",
      `WORKFLOW_TRIGGERS>${lit}`,
    ]);
    expect(from("WorkflowRule:Acme_Order__c.Recompute_Total")).toEqual([
      "READS_FIELD>CustomField:Acme_Order__c.Amount__c",
      "READS_FIELD>CustomField:Acme_Order__c.Priority__c",
      "TRIGGER_FIRES_ON>CustomObject:Acme_Order__c",
      `WORKFLOW_TRIGGERS>${frm}`,
    ]);

    // The whole-file edge stays.
    expect(from("Workflow:Acme_Order__c")).toContain(
      "WORKFLOW_UPDATES_FIELD>CustomField:Acme_Order__c.Status__c",
    );
    // The per-update writer is visible from the field's side.
    const into = graphStore
      .listEdgesTo(orgId, "CustomField:Acme_Order__c.Status__c" as never)
      .filter((e) => String(e.relType) === "WRITES_FIELD")
      .map((e) => String(e.srcQualifiedName));
    expect(into).toContain(lit);
  });
});
