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

function n(
  org: string,
  store: SqliteGraphStore,
  qn: string,
  hash: string,
  label = "ApexClass",
): void {
  const fact: NodeFact = {
    orgId: asOrgId(org),
    qualifiedName: asQualifiedName(qn),
    label,
    attributes: {},
    sourceHash: asSha256(hash),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
  store.mergeNodes([fact]);
}

beforeEach(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-tool-mfst-"));
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

  setToolContextFactory(async ({ orgId }) => {
    if (orgId === ORG_A) return { graphStore: storeA, snapshotStore: snapA, orgId: ORG_A };
    if (orgId === ORG_B) return { graphStore: storeB, snapshotStore: snapB, orgId: ORG_B };
    throw new Error(`unknown org in test: ${orgId}`);
  });
});

afterEach(async () => {
  setToolContextFactory(null);
  await storeA.close();
  await storeB.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("deployment_manifest_gen", () => {
  it("emits valid package.xml + destructiveChanges.xml structure", async () => {
    n("orgA", storeA, "ApexClass:NewOne", "h1");
    n("orgB", storeB, "ApexClass:Removed", "h2");
    const r = await callTool("deployment_manifest_gen", { from_org: ORG_A, to_org: ORG_B });
    const d = r.data as {
      packageXml: string;
      destructiveXml: string;
      summary: { addedOrChanged: number; removed: number };
    };
    expect(d.packageXml).toMatch(/<\?xml/);
    expect(d.packageXml).toMatch(/<Package/);
    expect(d.destructiveXml).toMatch(/<\?xml/);
    expect(d.destructiveXml).toMatch(/<Package/);
  });

  it("places added/changed members in package.xml", async () => {
    n("orgA", storeA, "ApexClass:NewOne", "h1");
    n("orgA", storeA, "ApexClass:Both", "v2");
    n("orgB", storeB, "ApexClass:Both", "v1"); // changed
    const r = await callTool("deployment_manifest_gen", { from_org: ORG_A, to_org: ORG_B });
    const d = r.data as { packageXml: string; summary: { addedOrChanged: number } };
    expect(d.packageXml).toContain("NewOne");
    expect(d.packageXml).toContain("Both");
    expect(d.summary.addedOrChanged).toBeGreaterThanOrEqual(2);
  });

  it("places removed members in destructiveChanges.xml only", async () => {
    n("orgA", storeA, "ApexClass:Keep", "h1");
    n("orgB", storeB, "ApexClass:Keep", "h1");
    n("orgB", storeB, "ApexClass:Gone", "h2");
    const r = await callTool("deployment_manifest_gen", { from_org: ORG_A, to_org: ORG_B });
    const d = r.data as {
      packageXml: string;
      destructiveXml: string;
      summary: { removed: number };
    };
    expect(d.destructiveXml).toContain("Gone");
    expect(d.packageXml).not.toContain("Gone");
    expect(d.summary.removed).toBeGreaterThanOrEqual(1);
  });

  it("never deletes managed-package or standard items found only in the target, and says so", async () => {
    n("orgB", storeB, "ApexClass:Gone", "h2");
    n("orgB", storeB, "CustomObject:acme__Invoice__c", "h3", "CustomObject");
    n("orgB", storeB, "CustomField:Account.Industry", "h4", "CustomField");
    const r = await callTool("deployment_manifest_gen", { from_org: ORG_A, to_org: ORG_B });
    const d = r.data as { destructiveXml: string; hidden: { managed: number; standard: number } };
    expect(d.destructiveXml).toContain("Gone");
    expect(d.destructiveXml).not.toContain("acme__Invoice__c");
    expect(d.destructiveXml).not.toContain("Account.Industry");
    expect(d.hidden).toEqual({ managed: 1, standard: 1 });
    expect(r.markdown).toContain("1 managed-package item and 1 standard Salesforce item");
    expect(r.markdown).toContain("`include_managed: true` or `include_standard: true`");

    const all = await callTool("deployment_manifest_gen", {
      from_org: ORG_A,
      to_org: ORG_B,
      include_managed: true,
      include_standard: true,
    });
    const dAll = all.data as { destructiveXml: string };
    expect(dAll.destructiveXml).toContain("acme__Invoice__c");
    expect(dAll.destructiveXml).toContain("Account.Industry");
    expect(all.markdown).not.toContain("Left out of both files");
  });

  it("returns zero counts when orgs are identical", async () => {
    n("orgA", storeA, "ApexClass:Same", "h1");
    n("orgB", storeB, "ApexClass:Same", "h1");
    const r = await callTool("deployment_manifest_gen", { from_org: ORG_A, to_org: ORG_B });
    const d = r.data as { summary: { addedOrChanged: number; removed: number } };
    expect(d.summary.addedOrChanged).toBe(0);
    expect(d.summary.removed).toBe(0);
    expect(r.summary).toContain("0 added/changed");
  });

  it("handles fully empty source org (everything in target becomes destructive)", async () => {
    n("orgB", storeB, "ApexClass:Existing", "h1");
    const r = await callTool("deployment_manifest_gen", { from_org: ORG_A, to_org: ORG_B });
    const d = r.data as { destructiveXml: string; summary: { removed: number } };
    expect(d.destructiveXml).toContain("Existing");
    expect(d.summary.removed).toBeGreaterThanOrEqual(1);
  });

  it("handles fully empty target org (everything new becomes package additions)", async () => {
    n("orgA", storeA, "ApexClass:Fresh", "h1");
    const r = await callTool("deployment_manifest_gen", { from_org: ORG_A, to_org: ORG_B });
    const d = r.data as { packageXml: string; summary: { addedOrChanged: number } };
    expect(d.packageXml).toContain("Fresh");
    expect(d.summary.addedOrChanged).toBeGreaterThanOrEqual(1);
  });

  it("renders both package and destructive sections as markdown XML fences", async () => {
    n("orgA", storeA, "ApexClass:X", "h1");
    const r = await callTool("deployment_manifest_gen", { from_org: ORG_A, to_org: ORG_B });
    expect(r.markdown).toContain("### package.xml");
    expect(r.markdown).toContain("### destructiveChanges.xml");
    expect(r.markdown).toMatch(/```xml/);
  });

  it("rejects empty from_org", async () => {
    await expect(
      callTool("deployment_manifest_gen", { from_org: "", to_org: ORG_B }),
    ).rejects.toThrow();
  });

  it("rejects missing to_org", async () => {
    await expect(callTool("deployment_manifest_gen", { from_org: ORG_A })).rejects.toThrow();
  });

  it("scales to many nodes (50-class manifest)", async () => {
    for (let i = 0; i < 50; i++) {
      n("orgA", storeA, `ApexClass:C${i}`, `h${i}`);
    }
    const r = await callTool("deployment_manifest_gen", { from_org: ORG_A, to_org: ORG_B });
    const d = r.data as { summary: { addedOrChanged: number } };
    expect(d.summary.addedOrChanged).toBe(50);
  });
});
