import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EdgeFact, NodeFact, Org } from "../../domain/index.js";
import { SqliteGraphStore } from "../sqlite/graph-store.js";

let workDir: string;
let store: SqliteGraphStore;

beforeEach(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-graph-"));
  store = new SqliteGraphStore({
    dbPath: path.join(workDir, "g.sqlite"),
    backupDir: path.join(workDir, "bkp"),
  });
  await store.init();
});

afterEach(async () => {
  await store.close();
  rmSync(workDir, { recursive: true, force: true });
});

function n(
  label: string,
  qname: string,
  hash: string,
  t = 1,
  attrs: Record<string, unknown> = {},
): NodeFact {
  return {
    orgId: asOrgId("org1"),
    qualifiedName: asQualifiedName(qname),
    label,
    attributes: attrs,
    sourceHash: asSha256(hash),
    firstSeenAt: t,
    lastSeenAt: t,
    lastModifiedAt: t,
  };
}

function e(
  relType: string,
  src: string,
  dst: string,
  attrs: Record<string, unknown> = {},
  t = 1,
): EdgeFact {
  return {
    orgId: asOrgId("org1"),
    srcQualifiedName: asQualifiedName(src),
    dstQualifiedName: asQualifiedName(dst),
    relType: relType as EdgeFact["relType"],
    attributes: attrs,
    firstSeenAt: t,
    lastSeenAt: t,
  };
}

describe("SqliteGraphStore", () => {
  it("upserts and reads an org", () => {
    const org: Org = {
      id: asOrgId("org1"),
      alias: "DevHub",
      instanceUrl: "https://x",
      apiVersion: "62.0",
      createdAt: 1,
    };
    store.upsertOrg(org);
    expect(store.getOrg(asOrgId("org1"))).toEqual(org);
    expect(store.getOrg(asOrgId("nope"))).toBeNull();
  });

  it("mergeNodes inserts new facts", () => {
    const r = store.mergeNodes([n("ApexClass", "Foo", "h1"), n("ApexClass", "Bar", "h2")]);
    expect(r).toEqual({ inserted: 2, updated: 0, unchanged: 0 });
    expect(store.countNodes(asOrgId("org1"))).toBe(2);
  });

  describe("mergeEdges reconcileSources (immortal-edge fix)", () => {
    const ORG = asOrgId("org1");

    it("prunes an outgoing edge the source no longer emits, keeps the rest", () => {
      // First ingest: method does two SOQL.
      store.mergeEdges(
        [
          e("EXECUTES_SOQL", "ApexMethod:Svc.run", "CustomObject:Account"),
          e("EXECUTES_SOQL", "ApexMethod:Svc.run", "CustomObject:Contact"),
        ],
        { reconcileSources: true },
      );
      expect(store.listEdgesFrom(ORG, asQualifiedName("ApexMethod:Svc.run")).length).toBe(2);

      // Re-ingest: the Contact SOQL was deleted from the method body.
      const r = store.mergeEdges(
        [e("EXECUTES_SOQL", "ApexMethod:Svc.run", "CustomObject:Account", {}, 9)],
        { reconcileSources: true },
      );
      expect(r.deleted).toBe(1);
      const remaining = store.listEdgesFrom(ORG, asQualifiedName("ApexMethod:Svc.run"));
      expect(remaining.map((x) => String(x.dstQualifiedName))).toEqual(["CustomObject:Account"]);
    });

    it("prunes a source's LAST edge of a relType (scans all tables, not just buckets)", () => {
      store.mergeEdges(
        [
          e("EXECUTES_SOQL", "ApexMethod:Svc.run", "CustomObject:Account"),
          e("EXECUTES_DML", "ApexMethod:Svc.run", "DML:insert"),
        ],
        { reconcileSources: true },
      );
      // Re-ingest emits only the SOQL — the DML is gone entirely.
      const r = store.mergeEdges(
        [e("EXECUTES_SOQL", "ApexMethod:Svc.run", "CustomObject:Account", {}, 9)],
        { reconcileSources: true },
      );
      expect(r.deleted).toBe(1);
      const remaining = store.listEdgesFrom(ORG, asQualifiedName("ApexMethod:Svc.run"));
      expect(remaining.map((x) => x.relType)).toEqual(["EXECUTES_SOQL"]);
    });

    it("never touches inbound edges from a not-reparsed caller", () => {
      // Caller A → Svc.run (inbound to the source we'll reconcile).
      store.mergeEdges([e("CALLS", "ApexMethod:A.go", "ApexMethod:Svc.run")]);
      store.mergeEdges([e("EXECUTES_SOQL", "ApexMethod:Svc.run", "CustomObject:Account")], {
        reconcileSources: true,
      });
      // Reconcile Svc.run again — A.go was NOT in this batch; its inbound CALLS must survive.
      store.mergeEdges([e("EXECUTES_SOQL", "ApexMethod:Svc.run", "CustomObject:Account", {}, 9)], {
        reconcileSources: true,
      });
      expect(store.listEdgesTo(ORG, asQualifiedName("ApexMethod:Svc.run")).length).toBe(1);
    });

    it("without reconcileSources, edges are additive (legacy resolver behaviour)", () => {
      store.mergeEdges([e("EXECUTES_SOQL", "ApexMethod:Svc.run", "CustomObject:Account")]);
      const r = store.mergeEdges([
        e("EXECUTES_SOQL", "ApexMethod:Svc.run", "CustomObject:Contact"),
      ]);
      expect(r.deleted).toBeUndefined();
      expect(store.listEdgesFrom(ORG, asQualifiedName("ApexMethod:Svc.run")).length).toBe(2);
    });
  });

  it("mergeNodes dedups by source_hash", () => {
    store.mergeNodes([n("ApexClass", "Foo", "h1")]);
    const r = store.mergeNodes([n("ApexClass", "Foo", "h1", 5)]);
    expect(r).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
  });

  it("mergeNodes updates lastModifiedAt only when hash changes", () => {
    store.mergeNodes([n("ApexClass", "Foo", "h1", 1)]);
    store.mergeNodes([n("ApexClass", "Foo", "h1", 5)]);
    let node = store.getNode(asOrgId("org1"), asQualifiedName("Foo"));
    expect(node?.lastModifiedAt).toBe(1);
    expect(node?.lastSeenAt).toBe(5);
    store.mergeNodes([n("ApexClass", "Foo", "h2", 10)]);
    node = store.getNode(asOrgId("org1"), asQualifiedName("Foo"));
    expect(node?.lastModifiedAt).toBe(10);
    expect(node?.sourceHash).toBe("h2");
  });

  it("mergeEdges inserts and dedups", () => {
    const r1 = store.mergeEdges([e("CALLS", "A", "B", { x: 1 })]);
    expect(r1).toEqual({ inserted: 1, updated: 0, unchanged: 0 });
    const r2 = store.mergeEdges([e("CALLS", "A", "B", { x: 1 })]);
    expect(r2.unchanged).toBe(1);
    const r3 = store.mergeEdges([e("CALLS", "A", "B", { x: 2 })]);
    expect(r3.updated).toBe(1);
  });

  it("getNode finds node via label index", () => {
    store.mergeNodes([n("Flow", "MyFlow", "h1", 1, { active: true })]);
    const got = store.getNode(asOrgId("org1"), asQualifiedName("MyFlow"));
    expect(got?.label).toBe("Flow");
    expect(got?.attributes).toEqual({ active: true });
  });

  it("listNodesByLabel returns only that label", () => {
    store.mergeNodes([n("ApexClass", "A", "h1"), n("Flow", "F", "h2")]);
    const a = store.listNodesByLabel(asOrgId("org1"), "ApexClass");
    expect(a).toHaveLength(1);
    expect(a[0]?.qualifiedName).toBe("A");
  });

  it("listEdgesFrom filters by relType", () => {
    store.mergeEdges([e("CALLS", "A", "B"), e("READS_FIELD", "A", "C")]);
    expect(store.listEdgesFrom(asOrgId("org1"), asQualifiedName("A"))).toHaveLength(2);
    expect(
      store.listEdgesFrom(asOrgId("org1"), asQualifiedName("A"), "CALLS" as EdgeFact["relType"]),
    ).toHaveLength(1);
  });

  it("listEdgesTo finds reverse edges", () => {
    store.mergeEdges([e("CALLS", "A", "B"), e("CALLS", "X", "B")]);
    expect(store.listEdgesTo(asOrgId("org1"), asQualifiedName("B"))).toHaveLength(2);
  });

  it("reverse traversal uses reverse index", () => {
    store.mergeEdges([e("CALLS", "A", "B")]);
    const plan = store._explainReverseEdgeQuery("CALLS" as EdgeFact["relType"]);
    expect(plan.toLowerCase()).toContain("rev");
  });

  it("countNodes / countEdges per org", () => {
    store.mergeNodes([n("ApexClass", "A", "h1"), n("ApexClass", "B", "h2")]);
    store.mergeEdges([e("CALLS", "A", "B")]);
    expect(store.countNodes(asOrgId("org1"))).toBe(2);
    expect(store.countEdges(asOrgId("org1"))).toBe(1);
  });

  it("countNodesByLabel scopes count to a single label (W1.5-07)", () => {
    store.mergeNodes([
      n("ApexClass", "A1", "h1"),
      n("ApexClass", "A2", "h2"),
      n("Flow", "F1", "h3"),
    ]);
    expect(store.countNodesByLabel(asOrgId("org1"), "ApexClass")).toBe(2);
    expect(store.countNodesByLabel(asOrgId("org1"), "Flow")).toBe(1);
    // Label whose table has not been created yet returns 0, not throw.
    expect(store.countNodesByLabel(asOrgId("org1"), "Profile")).toBe(0);
    // Unknown org returns 0.
    expect(store.countNodesByLabel(asOrgId("other"), "ApexClass")).toBe(0);
  });

  it("composite PK dedupes within a single merge call", () => {
    const r = store.mergeNodes([n("ApexClass", "Foo", "h1"), n("ApexClass", "Foo", "h1")]);
    // first insert, second sees it as unchanged.
    expect(r.inserted + r.unchanged).toBe(2);
  });

  it("transaction wraps callbacks", () => {
    const result = store.transaction(() => {
      store.mergeNodes([n("ApexClass", "T", "h1")]);
      return 42;
    });
    expect(result).toBe(42);
    expect(store.countNodes(asOrgId("org1"))).toBe(1);
  });

  it("deleteNode purges the derived snippet (no orphan rows)", () => {
    const ORG = asOrgId("org1");
    const qn = asQualifiedName("ApexClass:Gone");
    store.mergeNodes([n("ApexClass", "ApexClass:Gone", "h1")]);
    store.upsertSnippet({
      orgId: ORG,
      qualifiedName: qn,
      sourceFormat: "apex",
      sourceText: "public class Gone {}",
      sourceHash: asSha256("h1"),
    });
    expect(store.getSnippet(ORG, qn)).not.toBeNull();

    store.deleteNode(ORG, qn);
    expect(store.getNode(ORG, qn)).toBeNull();
    // The snippet (derived data) is gone too — not left as an orphan that
    // explain_code would still surface for a deleted class.
    expect(store.getSnippet(ORG, qn)).toBeNull();
  });
});

describe("label transition (audit critical #1 — silent live-node deletion)", () => {
  const ORG = asOrgId("org1");

  it("moving a qname to a new label deletes the stale old-label row (no ghost)", () => {
    // Sync 1: node exists as ApexMethod with an edge.
    store.mergeNodes([n("ApexMethod", "ApexMethod:Foo.bar(0)", "h1", 1)]);
    store.mergeEdges([e("CONTAINS_METHOD", "ApexClass:Foo", "ApexMethod:Foo.bar(0)")]);
    expect(store.listNodesByLabel(ORG, "ApexMethod").length).toBe(1);

    // Sync 2: bar() gains @isTest → same qname, new label TestMethod.
    store.mergeNodes([n("TestMethod", "ApexMethod:Foo.bar(0)", "h2", 2)]);

    // The node now lives ONLY under TestMethod; the stale ApexMethod row is gone.
    expect(store.listNodesByLabel(ORG, "TestMethod").length).toBe(1);
    expect(store.listNodesByLabel(ORG, "ApexMethod").length).toBe(0);
    // The live node still resolves, under the new label.
    const live = store.getNode(ORG, asQualifiedName("ApexMethod:Foo.bar(0)"));
    expect(live?.label).toBe("TestMethod");
    // Edges to the qname are preserved (qname unchanged across the relabel).
    expect(store.listEdgesTo(ORG, asQualifiedName("ApexMethod:Foo.bar(0)")).length).toBe(1);
  });

  it("a stale-under-old-label sweep can no longer delete the live relabeled node", () => {
    store.mergeNodes([n("ApexInterface", "ApexClass:Shape", "h1", 1)]);
    store.mergeNodes([n("ApexClass", "ApexClass:Shape", "h2", 2)]); // interface → class flip
    // Simulate the detect-deletions sweep over the OLD label: there are no rows
    // left under "ApexInterface", so nothing to (wrongly) delete.
    expect(store.listNodesByLabel(ORG, "ApexInterface").length).toBe(0);
    // The live node survives.
    expect(store.getNode(ORG, asQualifiedName("ApexClass:Shape"))?.label).toBe("ApexClass");
  });
});
