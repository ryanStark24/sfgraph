import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteGraphStore, SqliteSnapshotStore } from "@ryanstark24/sfgraph-core";
import type { NodeFact } from "@ryanstark24/sfgraph-core";
import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setToolContextFactory } from "../../context.js";
import { callTool } from "./_runner.js";

let workDir: string;
let storeA: SqliteGraphStore;
let storeB: SqliteGraphStore;
let snapA: SqliteSnapshotStore;
let snapB: SqliteSnapshotStore;

const ORG_A = asOrgId("orgA");
const ORG_B = asOrgId("orgB");

beforeEach(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-tool-co-"));
  storeA = new SqliteGraphStore({
    dbPath: path.join(workDir, "a.sqlite"),
    backupDir: path.join(workDir, "bkp-a"),
  });
  await storeA.init();
  snapA = new SqliteSnapshotStore({
    dbPath: path.join(workDir, "a.sqlite"),
    db: (storeA as unknown as { db: never }).db,
    skipMigrations: true,
  });
  await snapA.init();
  storeB = new SqliteGraphStore({
    dbPath: path.join(workDir, "b.sqlite"),
    backupDir: path.join(workDir, "bkp-b"),
  });
  await storeB.init();
  snapB = new SqliteSnapshotStore({
    dbPath: path.join(workDir, "b.sqlite"),
    db: (storeB as unknown as { db: never }).db,
    skipMigrations: true,
  });
  await snapB.init();

  // Factory dispatches to the correct store per orgId so the tool sees the
  // real per-org layout it'll see in production.
  setToolContextFactory(async ({ orgId }) => {
    if (orgId === ORG_A) return { graphStore: storeA, snapshotStore: snapA, orgId: ORG_A };
    if (orgId === ORG_B) return { graphStore: storeB, snapshotStore: snapB, orgId: ORG_B };
    throw new Error(`unknown org in test: ${orgId}`);
  });

  function n(org: string, store: SqliteGraphStore, qn: string, hash: string): void {
    const fact: NodeFact = {
      orgId: asOrgId(org),
      qualifiedName: asQualifiedName(qn),
      label: "ApexClass",
      attributes: {},
      sourceHash: asSha256(hash),
      firstSeenAt: 1,
      lastSeenAt: 1,
      lastModifiedAt: 1,
    };
    store.mergeNodes([fact]);
  }
  n("orgA", storeA, "ApexClass:Only_A", "h1");
  n("orgA", storeA, "ApexClass:Both", "v1");
  n("orgB", storeB, "ApexClass:Both", "v2");
  n("orgB", storeB, "ApexClass:Only_B", "h2");
});

afterEach(async () => {
  setToolContextFactory(null);
  await storeA.close();
  await storeB.close();
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
