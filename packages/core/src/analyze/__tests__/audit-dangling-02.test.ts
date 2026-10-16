import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import type { EdgeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { auditDanglingEdges } from "../audit-graph.js";

// audit dangling-02: an empty object name (`CustomObject:`) is a parser bug,
// not a platform built-in; the audit must count it as unexpected.
const ORG = asOrgId("org_dangling02");

describe("audit dangling-02: empty CustomObject target is unexpected", () => {
  it("counts WorkflowRule -> `CustomObject:` as unexpected", async () => {
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    store.mergeNodes([
      {
        orgId: ORG,
        qualifiedName: asQualifiedName("WorkflowRule:.Notify_Owner"),
        label: "WorkflowRule",
        attributes: {},
        sourceHash: asSha256("h"),
        firstSeenAt: 1,
        lastSeenAt: 1,
        lastModifiedAt: 1,
      },
    ]);
    const e: EdgeFact = {
      orgId: ORG,
      srcQualifiedName: asQualifiedName("WorkflowRule:.Notify_Owner"),
      dstQualifiedName: asQualifiedName("CustomObject:"),
      relType: "TRIGGER_FIRES_ON" as EdgeFact["relType"],
      attributes: {},
      firstSeenAt: 1,
      lastSeenAt: 1,
    };
    store.mergeEdges([e]);
    const r = auditDanglingEdges(store, ORG);
    expect(r.danglingCount).toBe(1);
    expect(r.platformRefCount).toBe(0);
    expect(r.unexpectedCount).toBe(1);
    await store.close();
  });
});
