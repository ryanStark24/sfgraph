import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../sqlite/graph-store.js";

const ORG = asOrgId("org1");
let workDir: string;
let store: SqliteGraphStore;

beforeEach(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-nocase-"));
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

function node(label: string, qname: string): NodeFact {
  return {
    orgId: ORG,
    qualifiedName: asQualifiedName(qname),
    label,
    attributes: {},
    sourceHash: asSha256("h"),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
}
function edge(rel: string, src: string, dst: string): EdgeFact {
  return {
    orgId: ORG,
    srcQualifiedName: asQualifiedName(src),
    dstQualifiedName: asQualifiedName(dst),
    relType: rel as EdgeFact["relType"],
    attributes: {},
    firstSeenAt: 1,
    lastSeenAt: 1,
  };
}

describe("qname case-insensitivity (COLLATE NOCASE)", () => {
  it("getNode resolves regardless of the case queried", () => {
    store.mergeNodes([node("CustomObject", "CustomObject:Account")]);
    expect(store.getNode(ORG, asQualifiedName("CustomObject:account"))).not.toBeNull();
    expect(store.getNode(ORG, asQualifiedName("CUSTOMOBJECT:ACCOUNT"))).not.toBeNull();
  });

  it("mergeNodes dedups case variants into one row (display = first-seen)", () => {
    store.mergeNodes([node("CustomObject", "CustomObject:Account")]);
    store.mergeNodes([node("CustomObject", "CustomObject:account")]);
    expect(store.listNodesByLabel(ORG, "CustomObject").length).toBe(1);
    expect(String(store.getNode(ORG, asQualifiedName("CustomObject:ACCOUNT"))?.qualifiedName)).toBe(
      "CustomObject:Account",
    );
  });

  it("an edge written with a different-case dst resolves to the canonical node (no dangling)", () => {
    store.mergeNodes([
      node("CustomObject", "CustomObject:Account"),
      node("ApexMethod", "ApexMethod:Svc.run(0)"),
    ]);
    // SOQL `from account` produced a lower-cased dst.
    store.mergeEdges([edge("EXECUTES_SOQL", "ApexMethod:Svc.run(0)", "CustomObject:account")]);
    // listEdgesTo on the canonical node finds the edge despite the case mismatch.
    expect(store.listEdgesTo(ORG, asQualifiedName("CustomObject:Account")).length).toBe(1);
    // And the node is reachable from the edge's dst case too.
    expect(store.getNode(ORG, asQualifiedName("CustomObject:account"))).not.toBeNull();
  });

  it("mergeEdges dedups case-variant endpoints into one edge", () => {
    store.mergeEdges([edge("CALLS", "ApexMethod:A.go(0)", "ApexMethod:B.run(0)")]);
    store.mergeEdges([edge("CALLS", "ApexMethod:a.GO(0)", "ApexMethod:B.RUN(0)")]);
    expect(store.listEdgesFrom(ORG, asQualifiedName("ApexMethod:A.go(0)")).length).toBe(1);
  });
});
