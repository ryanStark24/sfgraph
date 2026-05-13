import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteGraphStore, SqliteSnapshotStore } from "@ryanstark24/sfgraph-core";
import type { EdgeFact, NodeFact } from "@ryanstark24/sfgraph-core";
import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setToolContextFactory } from "../../context.js";
import { callTool } from "./_runner.js";

let workDir: string;
let graphStore: SqliteGraphStore;

const ORG_A = asOrgId("orgA");
const ORG_B = asOrgId("orgB");

beforeEach(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-tool-co-"));
  graphStore = new SqliteGraphStore({
    dbPath: path.join(workDir, "g.sqlite"),
    backupDir: path.join(workDir, "bkp"),
  });
  await graphStore.init();
  const snapshotStore = new SqliteSnapshotStore({
    dbPath: path.join(workDir, "g.sqlite"),
    db: (graphStore as unknown as { db: never }).db,
    skipMigrations: true,
  });
  await snapshotStore.init();
  setToolContextFactory(async () => ({ graphStore, snapshotStore, orgId: ORG_A }));

  function n(org: string, qn: string, hash: string): NodeFact {
    return {
      orgId: asOrgId(org),
      qualifiedName: asQualifiedName(qn),
      label: "ApexClass",
      attributes: {},
      sourceHash: asSha256(hash),
      firstSeenAt: 1,
      lastSeenAt: 1,
      lastModifiedAt: 1,
    };
  }
  graphStore.mergeNodes([
    n("orgA", "ApexClass:Only_A", "h1"),
    n("orgA", "ApexClass:Both", "v1"),
    n("orgB", "ApexClass:Both", "v2"),
    n("orgB", "ApexClass:Only_B", "h2"),
  ]);
});

afterEach(async () => {
  setToolContextFactory(null);
  await graphStore.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("cross_org_diff", () => {
  it("identifies only-in-A", async () => {
    const r = await callTool("cross_org_diff", { org_a: ORG_A, org_b: ORG_B });
    expect((r.data as { onlyInA: string[] }).onlyInA).toContain("ApexClass:Only_A");
  });
  it("identifies only-in-B", async () => {
    const r = await callTool("cross_org_diff", { org_a: ORG_A, org_b: ORG_B });
    expect((r.data as { onlyInB: string[] }).onlyInB).toContain("ApexClass:Only_B");
  });
  it("identifies changed", async () => {
    const r = await callTool("cross_org_diff", { org_a: ORG_A, org_b: ORG_B });
    expect((r.data as { changed: string[] }).changed).toContain("ApexClass:Both");
  });
});
