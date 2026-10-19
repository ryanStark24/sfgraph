import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REL_TYPES } from "../../domain/index.js";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/index.js";
import { findDependencies } from "../dependencies.js";
import { findDependents } from "../dependents.js";

let workDir: string;
let store: SqliteGraphStore;
const orgId = asOrgId("orgStruct");

beforeEach(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-struct-"));
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

function node(qn: string): NodeFact {
  return {
    orgId,
    qualifiedName: asQualifiedName(qn),
    label: qn.slice(0, qn.indexOf(":")),
    attributes: {},
    sourceHash: asSha256(`h-${qn}`),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
}
function edge(src: string, dst: string, rel: string): EdgeFact {
  return {
    orgId,
    srcQualifiedName: asQualifiedName(src),
    dstQualifiedName: asQualifiedName(dst),
    relType: rel as never,
    attributes: {},
    firstSeenAt: 1,
    lastSeenAt: 1,
  };
}
function add(nodes: string[], edges: Array<[string, string, string]>): void {
  store.mergeNodes(nodes.map(node));
  store.mergeEdges(edges.map(([s, d, r]) => edge(s, d, r)));
}
const q = asQualifiedName;
const names = (r: { nodes: NodeFact[] }): string[] => r.nodes.map((n) => n.qualifiedName);

/** DR -> object with 50 fields + a validation rule + a record type. */
function objectFixture(): void {
  const fields = Array.from({ length: 50 }, (_, i) => `CustomField:Big__c.F${i}__c`);
  add(
    [
      "DataRaptor:Writer",
      "CustomObject:Big__c",
      "ValidationRule:Big__c.VR1",
      "RecordType:Big__c.RT1",
      ...fields,
    ],
    [
      ["DataRaptor:Writer", "CustomObject:Big__c", REL_TYPES.REFERENCES_OBJECT],
      ["DataRaptor:Writer", "CustomField:Big__c.F0__c", REL_TYPES.DR_WRITES_FIELD],
      ["CustomObject:Big__c", "ValidationRule:Big__c.VR1", REL_TYPES.HAS_VALIDATION_RULE],
      ["CustomObject:Big__c", "RecordType:Big__c.RT1", REL_TYPES.HAS_RECORD_TYPE],
      ...fields.map((f): [string, string, string] => [
        "CustomObject:Big__c",
        f,
        REL_TYPES.DEFINES_FIELD,
      ]),
    ],
  );
}

describe("findDependencies leafStructure", () => {
  it("does not expand a reached object's 50 fields, VR or record type", () => {
    objectFixture();
    const r = findDependencies(store, orgId, q("DataRaptor:Writer"), 4, { leafStructure: true });
    expect(names(r).sort()).toEqual(["CustomField:Big__c.F0__c", "CustomObject:Big__c"]);
    expect(r.structural).toBe(52);
  });

  it("keeps the old expansion when leafStructure is off (default)", () => {
    objectFixture();
    const r = findDependencies(store, orgId, q("DataRaptor:Writer"), 4);
    expect(r.nodes.length).toBe(53);
    expect(names(r)).toContain("ValidationRule:Big__c.VR1");
    expect(names(r)).toContain("RecordType:Big__c.RT1");
  });

  it("treats a formula field as a leaf (no field -> field READS_FIELD)", () => {
    add(
      ["ApexMethod:C.m(0)", "CustomField:A__c.Formula__c", "CustomField:B.Status"],
      [
        ["ApexMethod:C.m(0)", "CustomField:A__c.Formula__c", REL_TYPES.READS_FIELD],
        ["CustomField:A__c.Formula__c", "CustomField:B.Status", REL_TYPES.READS_FIELD],
      ],
    );
    const on = findDependencies(store, orgId, q("ApexMethod:C.m(0)"), 3, { leafStructure: true });
    expect(names(on)).toEqual(["CustomField:A__c.Formula__c"]);
    const off = findDependencies(store, orgId, q("ApexMethod:C.m(0)"), 3);
    expect(names(off)).toContain("CustomField:B.Status");
  });

  it("still expands the root even if it is an object", () => {
    objectFixture();
    const r = findDependencies(store, orgId, q("CustomObject:Big__c"), 1, { leafStructure: true });
    expect(r.nodes.length).toBe(52);
  });

  it("upstream lists the defining object as a leaf (its own leafStructure, default on)", () => {
    objectFixture();
    const r = findDependents(store, orgId, q("CustomField:Big__c.F7__c"), 3);
    expect(names(r)).toEqual(["CustomObject:Big__c"]);
    const off = findDependents(store, orgId, q("CustomField:Big__c.F7__c"), 3, {
      leafStructure: false,
    });
    expect(names(off)).toContain("DataRaptor:Writer");
  });
});

describe("findDependencies rollupApexClass", () => {
  function classFixture(): void {
    add(
      [
        "LWC:cmp",
        "ApexClass:Ctl",
        "ApexMethod:Ctl.m1(0)",
        "ApexMethod:Ctl.m2(0)",
        "CustomObject:Obj__c",
        "CustomField:Obj__c.F__c",
      ],
      [
        ["LWC:cmp", "ApexMethod:Ctl.m1(0)", REL_TYPES.IMPORTS_APEX],
        ["ApexClass:Ctl", "ApexMethod:Ctl.m1(0)", REL_TYPES.CONTAINS_METHOD],
        ["ApexClass:Ctl", "ApexMethod:Ctl.m2(0)", REL_TYPES.CONTAINS_METHOD],
        ["ApexMethod:Ctl.m2(0)", "CustomObject:Obj__c", REL_TYPES.EXECUTES_SOQL],
        ["ApexMethod:Ctl.m2(0)", "CustomField:Obj__c.F__c", REL_TYPES.READS_FIELD],
      ],
    );
  }

  it("rolls a reached method up to its class and continues from sibling methods", () => {
    classFixture();
    const r = findDependencies(store, orgId, q("LWC:cmp"), 2, {
      leafStructure: true,
      rollupApexClass: true,
    });
    expect(names(r)).toContain("ApexClass:Ctl");
    expect(names(r)).toContain("ApexMethod:Ctl.m2(0)");
    expect(names(r)).toContain("CustomField:Obj__c.F__c");
    const byQ = new Map((r.reached ?? []).map((e) => [e.qualifiedName, e]));
    expect(byQ.get("ApexClass:Ctl")?.hop).toBe(1);
    expect(byQ.get("ApexMethod:Ctl.m2(0)")?.hop).toBe(1);
    expect(byQ.get("CustomField:Obj__c.F__c")?.hop).toBe(2);
  });

  it("does not roll up without the option", () => {
    classFixture();
    const r = findDependencies(store, orgId, q("LWC:cmp"), 2);
    expect(names(r)).not.toContain("CustomField:Obj__c.F__c");
  });
});

describe("findDependencies rollup runs once per class", () => {
  it("lists a class's sibling edges once even when many of its methods are reached", () => {
    const methods = Array.from({ length: 6 }, (_, i) => `ApexMethod:Big.m${i}(0)`);
    add(
      ["LWC:cmp", "ApexClass:Big", ...methods],
      [
        ...methods.map((m): [string, string, string] => ["LWC:cmp", m, REL_TYPES.IMPORTS_APEX]),
        ...methods.map((m): [string, string, string] => [
          "ApexClass:Big",
          m,
          REL_TYPES.CONTAINS_METHOD,
        ]),
      ],
    );
    const orig = store.listEdgesFrom.bind(store);
    let classScans = 0;
    store.listEdgesFrom = (o, qn, ...rest) => {
      if (qn === "ApexClass:Big") classScans += 1;
      return orig(o, qn, ...rest);
    };
    const r = findDependencies(store, orgId, q("LWC:cmp"), 2, { rollupApexClass: true });
    expect(names(r).filter((n) => n.startsWith("ApexMethod:Big.")).length).toBe(6);
    // Sanity bound only (roll-up scan + BFS expansion of the class). The rolledUp
    // guard is unreachable today, so this does not detect a regression of it.
    expect(classScans).toBeLessThanOrEqual(2);
  });
});

describe("findDependencies reached list", () => {
  it("records min hop, rel and dangling targets", () => {
    add(["DataRaptor:D"], [["DataRaptor:D", "CustomObject:NoRow", REL_TYPES.REFERENCES_OBJECT]]);
    const r = findDependencies(store, orgId, q("DataRaptor:D"), 2, { leafStructure: true });
    expect(r.nodes).toEqual([]);
    expect(r.reached).toEqual([
      {
        qualifiedName: "CustomObject:NoRow",
        label: "CustomObject",
        hop: 1,
        relType: REL_TYPES.REFERENCES_OBJECT,
        hasNode: false,
      },
    ]);
  });
});
