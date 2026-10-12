import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { findDeadCode, realIncomingRefCount } from "../dead-code.js";
import { populateDeadCodeScores, readDeadCodeScores } from "../populate.js";

/**
 * Task 14 batch P, rule 11: a Custom Metadata record field naming an Apex
 * class (`ClassName__c = 'AttributeLookupFunction'`) is how
 * metadata-driven dispatch (`Type.forName`) wires a handler, so the
 * reflection walker's unambiguous CMDT-record -> ApexClass edge is a real
 * reference for dead-code. Every other reflection guess still is not.
 */
const ORG = asOrgId("org_cmdt");
let store: SqliteGraphStore;
const cls = (q: string): NodeFact => ({
  orgId: ORG,
  qualifiedName: asQualifiedName(q),
  label: "ApexClass",
  attributes: {},
  sourceHash: asSha256(q),
  firstSeenAt: 1,
  lastSeenAt: 1,
  lastModifiedAt: 1,
});
const edge = (src: string, dst: string, attrs: Record<string, unknown>): EdgeFact => ({
  orgId: ORG,
  srcQualifiedName: asQualifiedName(src),
  dstQualifiedName: asQualifiedName(dst),
  relType: "REFERENCES" as EdgeFact["relType"],
  attributes: attrs,
  firstSeenAt: 1,
  lastSeenAt: 1,
});
const REFL = { source: "reflection", confidence: "pattern-match", viaKey: "#text" };

beforeEach(async () => {
  store = new SqliteGraphStore({ dbPath: ":memory:" });
  await store.init();
});
afterEach(async () => {
  await store.close();
});

describe("dead-code: CMDT record -> ApexClass reflection edges", () => {
  it("an unambiguous CMDT record value naming the class counts as a real reference", () => {
    store.mergeNodes([cls("ApexClass:AttributeLookupFunction")]);
    store.mergeEdges([
      edge(
        "CustomMetadataRecord:FunctionDefinition.GetAttributes",
        "ApexClass:AttributeLookupFunction",
        REFL,
      ),
    ]);
    expect(
      realIncomingRefCount(store, ORG, asQualifiedName("ApexClass:AttributeLookupFunction")),
    ).toBe(1);
  });

  it("ambiguous CMDT matches and non-CMDT reflection sources still do not count", () => {
    store.mergeNodes([cls("ApexClass:Amb"), cls("ApexClass:Other")]);
    store.mergeEdges([
      edge("CustomMetadataRecord:X.Y", "ApexClass:Amb", { ...REFL, ambiguous: true }),
      edge("OmniScript:OS", "ApexClass:Other", REFL),
      edge("CustomMetadataRecord:X.Z", "ApexMethod:Other.run(0)", REFL),
    ]);
    expect(realIncomingRefCount(store, ORG, asQualifiedName("ApexClass:Amb"))).toBe(0);
    expect(realIncomingRefCount(store, ORG, asQualifiedName("ApexClass:Other"))).toBe(0);
  });

  it("the audit lists exactly the classes with no counted reference (live and cached)", () => {
    store.mergeNodes([
      cls("ApexClass:AttributeLookupFunction"),
      cls("ApexClass:Amb"),
      cls("ApexClass:Other"),
    ]);
    store.mergeEdges([
      edge(
        "CustomMetadataRecord:FunctionDefinition.GetAttributes",
        "ApexClass:AttributeLookupFunction",
        REFL,
      ),
      edge("CustomMetadataRecord:X.Y", "ApexClass:Amb", { ...REFL, ambiguous: true }),
      edge("OmniScript:OS", "ApexClass:Other", REFL),
    ]);
    const expected = ["ApexClass:Amb", "ApexClass:Other"];
    expect(
      findDeadCode(store, ORG)
        .map((n) => String(n.qualifiedName))
        .sort(),
    ).toEqual(expected);
    const db = (store as unknown as { db: Database.Database }).db;
    expect(populateDeadCodeScores(store, ORG, db)).toBe(2);
    expect((readDeadCodeScores(db, ORG) ?? []).map((r) => r.qualifiedName).sort()).toEqual(
      expected,
    );
  });
});
