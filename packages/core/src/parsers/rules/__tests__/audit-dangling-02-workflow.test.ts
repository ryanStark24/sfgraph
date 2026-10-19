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
 * Audit dangling-02 (parser half): on the filesystem path the Workflow rule
 * reads `record.object` as empty, so every workflow file collapses into one
 * `Workflow:` node, rules become `WorkflowRule:.<name>`, and edges target
 * `CustomObject:` / `CustomField:.<field>`.
 */
const wf = (rule: string, field: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Workflow xmlns="http://soap.sforce.com/2006/04/metadata"><fieldUpdates><fullName>Set_${field}</fullName><field>${field}</field><operation>Literal</operation></fieldUpdates><rules><fullName>${rule}</fullName><active>true</active><triggerType>onCreateOnly</triggerType></rules></Workflow>`;

describe("audit dangling-02: workflow object name comes from the file name", () => {
  it("qualifies Workflow, WorkflowRule and their edges with the object", async () => {
    w(`${D}/workflows/Case.workflow-meta.xml`, wf("Case_Rule", "Status__c"));
    w(`${D}/workflows/Opportunity.workflow-meta.xml`, wf("Opp_Rule", "Stage__c"));
    const { graphStore, orgId } = await ingest();

    expect(graphStore.getNode(orgId, "Workflow:Case" as never)).not.toBeNull();
    expect(graphStore.getNode(orgId, "Workflow:Opportunity" as never)).not.toBeNull();
    expect(graphStore.getNode(orgId, "Workflow:" as never)).toBeNull();

    const fires = graphStore
      .listEdgesFrom(orgId, "WorkflowRule:Case.Case_Rule" as never)
      .filter((e) => String(e.relType) === "TRIGGER_FIRES_ON")
      .map((e) => String(e.dstQualifiedName));
    expect(fires).toEqual(["CustomObject:Case"]);

    const updates = graphStore
      .listEdgesFrom(orgId, "Workflow:Case" as never)
      .filter((e) => String(e.relType) === "WORKFLOW_UPDATES_FIELD")
      .map((e) => String(e.dstQualifiedName));
    expect(updates).toEqual(["CustomField:Case.Status__c"]);

    expect(graphStore.listEdgesByDstLike(orgId, "CustomObject:")).toEqual([]);
    expect(graphStore.listEdgesByDstLike(orgId, "CustomField:.%")).toEqual([]);
  });
});
