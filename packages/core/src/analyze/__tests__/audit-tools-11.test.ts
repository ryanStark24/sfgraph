import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { findDependents } from "../dependents.js";

// audit tools-11: a traversal seeded with a qname that has no node must say
// so (found: false) instead of a confident empty result.
const ORG = asOrgId("org_tools11");

describe("audit tools-11: traversal reports a missing seed", () => {
  it("findDependents on a nonexistent qname returns found: false", async () => {
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    store.mergeNodes([
      {
        orgId: ORG,
        qualifiedName: asQualifiedName("ApexClass:AccountTriggerHandler"),
        label: "ApexClass",
        attributes: {},
        sourceHash: asSha256("h"),
        firstSeenAt: 1,
        lastSeenAt: 1,
        lastModifiedAt: 1,
      },
    ]);
    const r = findDependents(store, ORG, asQualifiedName("ApexClass:AccountTrigerHandler"), 3);
    expect((r as { found?: boolean }).found).toBe(false);
    // and an existing seed is reported as found
    const ok = findDependents(store, ORG, asQualifiedName("ApexClass:AccountTriggerHandler"), 3);
    expect((ok as { found?: boolean }).found).toBe(true);
    await store.close();
  });
});
