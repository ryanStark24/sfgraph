import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REL_TYPES } from "../../domain/index.js";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/index.js";
import { analyzeLocalImpact } from "../wip-impact.js";

let workDir: string;
let dbPath: string;
let projectRoot: string;
let store: SqliteGraphStore;
const orgId = asOrgId("orgWip");

function seedNode(qname: string, label: string, sourceHash = "seeded-hash"): NodeFact {
  return {
    orgId,
    qualifiedName: asQualifiedName(qname),
    label,
    attributes: {},
    sourceHash: asSha256(sourceHash),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
}

function seedEdge(src: string, dst: string, relType: string): EdgeFact {
  return {
    orgId,
    srcQualifiedName: asQualifiedName(src),
    dstQualifiedName: asQualifiedName(dst),
    relType: relType as never,
    attributes: {},
    firstSeenAt: 1,
    lastSeenAt: 1,
  };
}

function w(rel: string, content: string): void {
  const abs = path.join(projectRoot, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

beforeEach(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-wip-"));
  dbPath = path.join(workDir, "g.sqlite");
  projectRoot = path.join(workDir, "proj");
  mkdirSync(projectRoot, { recursive: true });
  store = new SqliteGraphStore({ dbPath });
  await store.init();
  store.upsertOrg({
    id: orgId,
    alias: "wip-test",
    instanceUrl: "https://example",
    apiVersion: "60.0",
    createdAt: 1,
  });
});

afterEach(async () => {
  await store.close();
  rmSync(workDir, { recursive: true, force: true });
});

// Batch Q2 (task 14, B7): wip_test_gap evaluates the changed / added seeds
// themselves, rolls dependents up to their class, skips test classes and
// lists non-Apex labels as not applicable.
describe("analyzeLocalImpact testGaps", () => {
  it("evaluates seeds, rolls up to class, skips tests", async () => {
    const tested = (q: string, label: string, attributes: Record<string, unknown> = {}) => ({
      ...seedNode(q, label),
      attributes,
    });
    store.mergeNodes([
      seedNode("ApexClass:Old", "ApexClass"),
      seedNode("ApexMethod:Old.m(0)", "ApexMethod"),
      seedNode("ApexClass:Caller", "ApexClass"),
      seedNode("ApexMethod:Caller.use(0)", "ApexMethod"),
      seedNode("ApexMethod:Caller.other(0)", "ApexMethod"),
      seedNode("ApexClass:Covered", "ApexClass"),
      seedNode("ApexMethod:Covered.x(0)", "ApexMethod"),
      tested("ApexClass:CoveredTest", "ApexClass", { isTest: true }),
      tested("ApexMethod:CoveredTest.t(0)", "TestMethod", { isTest: true }),
      seedNode("LWC:ui", "LWC"),
    ]);
    store.mergeEdges([
      seedEdge("ApexClass:Old", "ApexMethod:Old.m(0)", REL_TYPES.CONTAINS_METHOD),
      seedEdge("ApexClass:Caller", "ApexMethod:Caller.use(0)", REL_TYPES.CONTAINS_METHOD),
      seedEdge("ApexClass:Caller", "ApexMethod:Caller.other(0)", REL_TYPES.CONTAINS_METHOD),
      seedEdge("ApexClass:Covered", "ApexMethod:Covered.x(0)", REL_TYPES.CONTAINS_METHOD),
      seedEdge("ApexClass:CoveredTest", "ApexMethod:CoveredTest.t(0)", REL_TYPES.CONTAINS_METHOD),
      seedEdge("ApexClass:CoveredTest", "ApexClass:Covered", REL_TYPES.IS_TEST_FOR),
      seedEdge("ApexMethod:Caller.use(0)", "ApexMethod:Old.m(0)", REL_TYPES.CALLS),
      seedEdge("ApexMethod:Covered.x(0)", "ApexMethod:Old.m(0)", REL_TYPES.CALLS),
      seedEdge("ApexMethod:CoveredTest.t(0)", "ApexMethod:Old.m(0)", REL_TYPES.CALLS),
      seedEdge("LWC:ui", "ApexMethod:Old.m(0)", REL_TYPES.IMPORTS_APEX),
    ]);
    w("force-app/main/default/classes/Old.cls", "public class Old { public static void m(){} }");
    w("force-app/main/default/classes/Fresh.cls", "public class Fresh { public void n(){} }");
    w(
      "force-app/main/default/classes/NewTest.cls",
      "@isTest private class NewTest { @isTest static void t(){ } }",
    );
    const r = await analyzeLocalImpact({
      graphStore: store,
      orgId,
      projectRoot,
      depth: 1,
      testGaps: true,
    });
    const g = r.testGaps;
    expect(g).toBeDefined();
    expect(g?.uncovered.map((d) => d.qname)).toEqual([
      "ApexClass:Caller",
      "ApexClass:Fresh",
      "ApexClass:Old",
    ]);
    expect(g?.uncovered.find((d) => d.qname === "ApexClass:Old")).toMatchObject({
      depth: 0,
      seed: "changed",
      coveredByTest: false,
    });
    expect(g?.uncovered.find((d) => d.qname === "ApexClass:Fresh")).toMatchObject({
      seed: "added",
    });
    expect(g?.uncovered.find((d) => d.qname === "ApexClass:Caller")).toMatchObject({
      depth: 1,
      viaRelType: REL_TYPES.CALLS,
    });
    expect(g?.covered).toEqual(["ApexClass:Covered"]);
    expect(g?.tests).toEqual(["ApexClass:CoveredTest", "ApexClass:NewTest"]);
    expect(g?.notApplicable).toEqual(["LWC:ui"]);
  });
});
