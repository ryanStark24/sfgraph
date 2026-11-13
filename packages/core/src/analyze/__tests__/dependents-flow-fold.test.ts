import { asOrgId, asQualifiedName } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestCtx } from "../../parsers/__tests__/_harness.js";
import { FlowParser } from "../../parsers/flow/index.js";
import { SqliteGraphStore } from "../../storage/index.js";
import { findDependents } from "../dependents.js";

// S-1.8.1-002 follow-up: the real flow parser emits Flow + FlowVersion with the
// trigger edge on the FlowVersion; findDependents folds the version into the
// Flow row, which must still carry the status and list the version in `folded`.
const orgId = asOrgId("org_test");
let store: SqliteGraphStore;
beforeEach(async () => {
  store = new SqliteGraphStore({ dbPath: ":memory:" });
  await store.init();
});
afterEach(async () => {
  await store.close();
});

const xml = (status: string) => `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <processType>AutoLaunchedFlow</processType>
    <status>${status}</status>
    <start>
        <object>Acme_Order__c</object>
        <triggerType>RecordAfterSave</triggerType>
        <recordTriggerType>CreateAndUpdate</recordTriggerType>
    </start>
</Flow>`;

describe("real flow parser output folds with status", () => {
  it("the Flow row has the status and lists the FlowVersion as folded", async () => {
    const res = await new FlowParser().parse(
      { fullName: "Acme_Order_Draft", xml: xml("Draft") },
      makeTestCtx(),
    );
    store.mergeNodes(res.nodes);
    store.mergeEdges(res.edges);
    const r = findDependents(store, orgId, asQualifiedName("CustomObject:Acme_Order__c"), 1, {});
    const row = (r.reached ?? []).find((e) => e.qualifiedName === "Flow:Acme_Order_Draft");
    expect(row?.status).toBe("Draft");
    expect(row?.folded).toEqual(["FlowVersion:Acme_Order_Draft.v59"]);
    expect(r.edges.some((e) => e.srcQualifiedName.startsWith("FlowVersion:"))).toBe(true);
  });
});
