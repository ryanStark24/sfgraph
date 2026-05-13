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

describe("analyzeLocalImpact", () => {
  it("detects changed (modified) ApexClass file", async () => {
    // Seed persisted ApexClass:Foo with placeholder hash.
    store.mergeNodes([seedNode("ApexClass:Foo", "ApexClass")]);
    // Write a local source file (will hash differently from seed).
    w("force-app/main/default/classes/Foo.cls", "public class Foo { void m(){} }");
    const result = await analyzeLocalImpact({
      graphStore: store,
      orgId,
      projectRoot,
    });
    expect(result.changedQnames).toContain("ApexClass:Foo");
    expect(result.addedQnames).not.toContain("ApexClass:Foo");
  });

  it("detects added (new) ApexClass file", async () => {
    w("force-app/main/default/classes/Brand.cls", "public class Brand {}");
    const result = await analyzeLocalImpact({
      graphStore: store,
      orgId,
      projectRoot,
    });
    expect(result.addedQnames).toContain("ApexClass:Brand");
  });

  it("full-folder mode detects removed (org-only) nodes", async () => {
    store.mergeNodes([
      seedNode("ApexClass:OnlyInOrg", "ApexClass"),
      seedNode("ApexClass:Both", "ApexClass"),
    ]);
    w("force-app/main/default/classes/Both.cls", "public class Both {}");
    const result = await analyzeLocalImpact({
      graphStore: store,
      orgId,
      projectRoot,
      mode: "full-folder",
    });
    expect(result.removedQnames).toContain("ApexClass:OnlyInOrg");
    expect(result.removedQnames).not.toContain("ApexClass:Both");
  });

  it("finds dependents via reverse BFS", async () => {
    // Persisted: Bar EXTENDS Foo. Foo also exists.
    store.mergeNodes([
      seedNode("ApexClass:Foo", "ApexClass"),
      seedNode("ApexClass:Bar", "ApexClass"),
    ]);
    store.mergeEdges([seedEdge("ApexClass:Bar", "ApexClass:Foo", REL_TYPES.EXTENDS)]);
    // Local change to Foo
    w("force-app/main/default/classes/Foo.cls", "public class Foo { Integer x; }");
    const result = await analyzeLocalImpact({
      graphStore: store,
      orgId,
      projectRoot,
    });
    expect(result.changedQnames).toContain("ApexClass:Foo");
    const depQnames = result.dependents.map((d) => d.qname);
    expect(depQnames).toContain("ApexClass:Bar");
  });

  it("emits mermaid with WIP class defs and seed node id", async () => {
    store.mergeNodes([seedNode("ApexClass:Foo", "ApexClass")]);
    w("force-app/main/default/classes/Foo.cls", "public class Foo {}");
    const result = await analyzeLocalImpact({
      graphStore: store,
      orgId,
      projectRoot,
    });
    expect(result.mermaid).toContain("flowchart LR");
    expect(result.mermaid).toContain("classDef wip-changed");
    expect(result.mermaid).toContain("classDef wip-added");
    expect(result.mermaid).toContain("classDef risk");
    expect(result.mermaid).toContain("classDef safe");
    // Some node id for ApexClass:Foo
    expect(result.mermaid).toMatch(/ApexClass.?Foo/);
  });
});
