import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import type { OrgId, QualifiedName } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findDependencies } from "../../analyze/dependencies.js";
import { findDependents } from "../../analyze/dependents.js";
import type { EdgeFact, NodeFact, RelType } from "../../domain/index.js";
import type { GraphStore } from "../interfaces.js";
import { SqliteGraphStore } from "../sqlite/graph-store.js";

/**
 * listEdgesFrom / listEdgesTo without a rel type read every edge table in one
 * UNION ALL statement. The reference is the per-table reads (one call per rel
 * type, in getEdgeRelTables order): same rows, same order. Traversals built
 * on them (trace_downstream / trace_upstream) must give the same results.
 */

const ORG = asOrgId("org_u");
const OTHER = asOrgId("org_v");

function perTable(store: SqliteGraphStore, dir: "from" | "to", org: OrgId, q: QualifiedName) {
  const out: EdgeFact[] = [];
  for (const rel of store.getEdgeRelTables().keys()) {
    out.push(
      ...(dir === "from"
        ? store.listEdgesFrom(org, q, rel as RelType)
        : store.listEdgesTo(org, q, rel as RelType)),
    );
  }
  return out;
}

/** The store, with untyped listEdgesFrom / listEdgesTo answered per table. */
function perTableStore(store: SqliteGraphStore): GraphStore {
  return new Proxy(store, {
    get(t, p, r) {
      if (p === "listEdgesFrom")
        return (o: OrgId, q: QualifiedName, rel?: RelType) =>
          rel ? t.listEdgesFrom(o, q, rel) : perTable(t, "from", o, q);
      if (p === "listEdgesTo")
        return (o: OrgId, q: QualifiedName, rel?: RelType) =>
          rel ? t.listEdgesTo(o, q, rel) : perTable(t, "to", o, q);
      const v = Reflect.get(t, p, r);
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as GraphStore;
}

function node(label: string, q: string): NodeFact {
  return {
    orgId: ORG,
    qualifiedName: asQualifiedName(q),
    label,
    attributes: {},
    sourceHash: asSha256(q),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
}

let dir: string;
let store: SqliteGraphStore;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-union-"));
  store = new SqliteGraphStore({
    dbPath: path.join(dir, "g.sqlite"),
    backupDir: path.join(dir, "bk"),
  });
  await store.init();
});
afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("listEdgesFrom / listEdgesTo over all edge tables", () => {
  it("return the per-table rows in the per-table order", () => {
    let seed = 3;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const names = [
      "ApexClass:A",
      "apexclass:a",
      "ApexClass:B",
      "ApexMethod:A.x(0)",
      "Flow:F",
      "X:Ü",
    ];
    const rels = ["CALLS", "REFERENCES", "READS_FIELD", "CONTAINS_METHOD", "IS_TEST_FOR"];
    // Also more tables than one UNION ALL statement holds (MAX_UNION_ARMS).
    for (let i = 0; i < 230; i++) rels.push(`EXTRA_REL_${i}`);
    const edges: EdgeFact[] = [];
    for (let i = 0; i < 1500; i++) {
      edges.push({
        orgId: rnd(6) === 0 ? OTHER : ORG,
        srcQualifiedName: asQualifiedName(names[rnd(names.length)] as string),
        dstQualifiedName: asQualifiedName(
          `${names[rnd(names.length)]}${rnd(3) === 0 ? "" : `#${rnd(40)}`}`,
        ),
        relType: (i < rels.length
          ? rels[i]
          : rels[rnd(8) === 0 ? rnd(rels.length) : rnd(5)]) as RelType,
        attributes: { i },
        firstSeenAt: i,
        lastSeenAt: i,
      });
    }
    store.mergeEdges(edges);
    expect(store.getEdgeRelTables().size).toBeGreaterThan(200);
    for (const org of [ORG, OTHER]) {
      for (const q of [...names, "ApexClass:A#7", "apexclass:a#7", "Nope:Z"]) {
        const qn = asQualifiedName(q);
        expect(store.listEdgesFrom(org, qn)).toEqual(perTable(store, "from", org, qn));
        expect(store.listEdgesTo(org, qn)).toEqual(perTable(store, "to", org, qn));
      }
    }
    expect(store.listEdgesFrom(ORG, asQualifiedName("ApexClass:A")).length).toBeGreaterThan(50);
  });

  it("give traces identical to per-table reads", () => {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const e = (rel: string, s: string, d: string, attributes = {}): void => {
      edges.push({
        orgId: ORG,
        srcQualifiedName: asQualifiedName(s),
        dstQualifiedName: asQualifiedName(d),
        relType: rel as RelType,
        attributes,
        firstSeenAt: 1,
        lastSeenAt: 1,
      });
    };
    for (let i = 0; i < 40; i++) {
      nodes.push(node("ApexClass", `ApexClass:C${i}`));
      for (let m = 0; m < 2; m++) {
        nodes.push(node("ApexMethod", `ApexMethod:C${i}.m${m}(0)`));
        e("CONTAINS_METHOD", `ApexClass:C${i}`, `ApexMethod:C${i}.m${m}(0)`);
        e(
          "CALLS",
          `ApexMethod:C${i}.m${m}(0)`,
          `ApexMethod:C${(i * 3 + m) % 40}.m${(i + m) % 2}(0)`,
        );
      }
      e("READS_FIELD", `ApexMethod:C${i}.m0(0)`, `CustomField:Account.F${i % 5}__c`);
      e("GRANTS_CLASS_ACCESS", `Profile:P${i % 3}`, `ApexClass:C${i}`);
      e("REFERENCES", `ApexClass:C${i}`, `ApexClass:C${(i + 7) % 40}`, { source: "reflection" });
      if (i % 4 === 0) e("REFERENCES", `Flow:F${i}`, `ApexClass:C${i}`);
    }
    for (let i = 0; i < 10; i++) {
      nodes.push(node("Flow", `Flow:F${i * 4}`));
      nodes.push(node("FlowVersion", `FlowVersion:F${i * 4}-1`));
      e("CONTAINS", `Flow:F${i * 4}`, `FlowVersion:F${i * 4}-1`);
    }
    store.mergeNodes(nodes);
    store.mergeEdges(edges);
    const ref = perTableStore(store);
    for (const seed of [
      "ApexClass:C0",
      "ApexMethod:C5.m1(0)",
      "CustomField:Account.F2__c",
      "Flow:F8",
    ]) {
      const q = asQualifiedName(seed);
      for (const depth of [1, 3, 5]) {
        for (const opts of [
          {},
          { excludeSecurity: true, excludeReflection: true },
          { rollupApexClass: true },
        ]) {
          expect(findDependencies(store, ORG, q, depth, opts)).toEqual(
            findDependencies(ref, ORG, q, depth, opts),
          );
          expect(findDependents(store, ORG, q, depth, opts)).toEqual(
            findDependents(ref, ORG, q, depth, opts),
          );
        }
      }
    }
  });
});
