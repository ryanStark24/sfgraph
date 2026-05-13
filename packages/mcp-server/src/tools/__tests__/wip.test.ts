import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, REL_TYPES, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

let fix: Fixture;
let projectRoot: string;

function w(rel: string, content: string): void {
  const abs = path.join(projectRoot, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

beforeEach(async () => {
  fix = await createFixture();
  projectRoot = mkdtempSync(path.join(tmpdir(), "sfg-wip-tool-"));
  // Seed: ApexClass:Foo and ApexClass:Bar with Bar extends Foo.
  fix.addNode({
    qualifiedName: "ApexClass:Foo",
    label: "ApexClass",
    sourceHash: "seed-foo",
  });
  fix.addNode({
    qualifiedName: "ApexClass:Bar",
    label: "ApexClass",
    sourceHash: "seed-bar",
  });
  fix.addEdge({
    srcQualifiedName: "ApexClass:Bar",
    dstQualifiedName: "ApexClass:Foo",
    relType: REL_TYPES.EXTENDS,
  });
  // Local Foo with different content -> "changed". And new Brand -> "added".
  w("force-app/main/default/classes/Foo.cls", "public class Foo { Integer y; }");
  w("force-app/main/default/classes/Brand.cls", "public class Brand {}");
});

afterEach(async () => {
  await fix.cleanup();
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("wip_impact", () => {
  it("returns changed + added qnames and mermaid", async () => {
    const r = await callTool("wip_impact", {
      org: fix.orgId,
      project_root: projectRoot,
    });
    const d = r.data as {
      changed: string[];
      added: string[];
      dependents: Array<{ qname: string }>;
    };
    expect(d.changed).toContain("ApexClass:Foo");
    expect(d.added).toContain("ApexClass:Brand");
    expect(d.dependents.some((x) => x.qname === "ApexClass:Bar")).toBe(true);
    expect(r.markdown).toContain("```mermaid");
  });
});

describe("wip_diff", () => {
  it("returns sets and no mermaid", async () => {
    const r = await callTool("wip_diff", {
      org: fix.orgId,
      project_root: projectRoot,
    });
    expect(r.markdown).not.toContain("```mermaid");
    const d = r.data as { changed: string[]; added: string[]; removed: string[] };
    expect(d.changed).toContain("ApexClass:Foo");
    expect(d.added).toContain("ApexClass:Brand");
  });
});

describe("wip_test_gap", () => {
  it("filters to uncovered dependents", async () => {
    const r = await callTool("wip_test_gap", {
      org: fix.orgId,
      project_root: projectRoot,
    });
    const d = r.data as { uncovered: Array<{ qname: string; coveredByTest: boolean }> };
    // Bar has no IS_TEST_FOR edge — so it's uncovered.
    expect(d.uncovered.some((x) => x.qname === "ApexClass:Bar")).toBe(true);
    expect(d.uncovered.every((x) => !x.coveredByTest)).toBe(true);
  });
});
