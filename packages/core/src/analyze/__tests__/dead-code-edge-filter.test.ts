import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type OrgId, asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { findDeadCode, realIncomingRefCount } from "../dead-code.js";

const ORG: OrgId = asOrgId("org1");
let workDir: string;
let store: SqliteGraphStore;

beforeEach(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-dc-"));
  store = new SqliteGraphStore({
    dbPath: path.join(workDir, "g.sqlite"),
    backupDir: path.join(workDir, "b"),
  });
  await store.init();
});
afterEach(async () => {
  await store.close();
  rmSync(workDir, { recursive: true, force: true });
});

// A very old (stale) class so freshness alone won't keep it alive.
function staleClass(qname: string): NodeFact {
  return {
    orgId: ORG,
    qualifiedName: asQualifiedName(qname),
    label: "ApexClass",
    attributes: {},
    sourceHash: asSha256("h"),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
}
function edge(
  rel: string,
  src: string,
  dst: string,
  attrs: Record<string, unknown> = {},
): EdgeFact {
  return {
    orgId: ORG,
    srcQualifiedName: asQualifiedName(src),
    dstQualifiedName: asQualifiedName(dst),
    relType: rel as EdgeFact["relType"],
    attributes: attrs,
    firstSeenAt: 1,
    lastSeenAt: 1,
  };
}

describe("dead-code incoming-edge filtering", () => {
  it("GRANTS_* and reflection edges do NOT count as real references", () => {
    const cls = "ApexClass:Orphan";
    store.mergeNodes([staleClass(cls)]);
    // Only a permission grant + a reflection-guessed reference point at it.
    store.mergeEdges([
      edge("GRANTS_APEX_ACCESS", "PermissionSet:PS", cls, { enabled: true }),
      edge("REFERENCES", "OmniScript:OS", cls, { source: "reflection" }),
    ]);
    expect(realIncomingRefCount(store, ORG, asQualifiedName(cls))).toBe(0);
    expect(findDeadCode(store, ORG).some((n) => String(n.qualifiedName) === cls)).toBe(true);
  });

  it("a real CALLS edge keeps the class out of the dead set", () => {
    const cls = "ApexClass:Used";
    store.mergeNodes([staleClass(cls)]);
    store.mergeEdges([edge("CALLS", "ApexMethod:Other.go(0)", cls)]);
    expect(realIncomingRefCount(store, ORG, asQualifiedName(cls))).toBe(1);
    expect(findDeadCode(store, ORG).some((n) => String(n.qualifiedName) === cls)).toBe(false);
  });
});
