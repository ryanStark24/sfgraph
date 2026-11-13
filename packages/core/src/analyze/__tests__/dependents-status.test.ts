import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteGraphStore } from "../../storage/index.js";
import { findDependents } from "../dependents.js";

// S-1.8.1-002: the stored status / active / events attributes survive the
// sqlite round trip and are carried onto the reached rows.
const orgId = asOrgId("orgStatus");
let store: SqliteGraphStore;
beforeEach(async () => {
  store = new SqliteGraphStore({ dbPath: ":memory:" });
  await store.init();
});
afterEach(async () => {
  await store.close();
});

function node(qn: string, attributes: Record<string, unknown>) {
  return {
    orgId,
    qualifiedName: asQualifiedName(qn),
    label: qn.slice(0, qn.indexOf(":")),
    attributes,
    sourceHash: asSha256(`h-${qn}`),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
}

describe("reached rows carry status, active and events", () => {
  it("reads them from node attributes after storage; absent when not stored", () => {
    store.mergeNodes([
      node("CustomObject:Acme_Order__c", {}),
      node("Flow:F_Draft", { status: "Draft", processType: "AutoLaunchedFlow" }),
      node("WorkflowRule:Acme_Order__c.R", { active: false }),
      node("ApexTrigger:T", { events: ["before insert", "after update"] }),
      node("ApexClass:C", { name: "C" }),
    ]);
    store.mergeEdges(
      [
        ["Flow:F_Draft", "TRIGGER_FIRES_ON"],
        ["WorkflowRule:Acme_Order__c.R", "TRIGGER_FIRES_ON"],
        ["ApexTrigger:T", "TRIGGERS_ON"],
        ["ApexClass:C", "REFERENCES"],
      ].map(([s, r]) => ({
        orgId,
        srcQualifiedName: asQualifiedName(s as string),
        dstQualifiedName: asQualifiedName("CustomObject:Acme_Order__c"),
        relType: r as never,
        attributes: {},
        firstSeenAt: 1,
        lastSeenAt: 1,
      })),
    );
    const r = findDependents(store, orgId, asQualifiedName("CustomObject:Acme_Order__c"), 1, {});
    const by = new Map((r.reached ?? []).map((e) => [e.qualifiedName, e]));
    expect(by.get("Flow:F_Draft")?.status).toBe("Draft");
    expect(by.get("WorkflowRule:Acme_Order__c.R")?.active).toBe(false);
    expect(by.get("ApexTrigger:T")?.events).toEqual(["before insert", "after update"]);
    const cls = by.get("ApexClass:C");
    expect(cls && "status" in cls).toBe(false);
    expect(cls && "active" in cls).toBe(false);
    expect(cls && "events" in cls).toBe(false);
  });
});
