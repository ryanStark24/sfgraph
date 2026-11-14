import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteGraphStore, SqliteSnapshotStore } from "@ryanstark24/sfgraph-core";
import type { NodeFact } from "@ryanstark24/sfgraph-core";
import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setToolContextFactory } from "../../context.js";
import { REL_TYPES, createFixture } from "./_fixture.js";
import type { Fixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

/**
 * 1.8.2 F02: the store compares qualified names with SQLite NOCASE, so cross-org diff and the
 * deployment manifest must too. `ApexClass:BillingService` in one org and `ApexClass:billingservice`
 * in the other is one component, never an add plus a destructive remove. Two real SQLite stores.
 */
describe("case-only name differences across two orgs (F02)", () => {
  let workDir: string;
  let storeA: SqliteGraphStore;
  let storeB: SqliteGraphStore;
  const ORG_A = asOrgId("orgA");
  const ORG_B = asOrgId("orgB");

  const put = (
    store: SqliteGraphStore,
    org: string,
    label: string,
    qn: string,
    hash: string,
  ): void => {
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
  };

  beforeEach(async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "sfg-case-"));
    const mk = async (name: string) => {
      const s = new SqliteGraphStore({
        dbPath: path.join(workDir, `${name}.sqlite`),
        backupDir: path.join(workDir, `bkp-${name}`),
      });
      await s.init();
      const snap = new SqliteSnapshotStore({
        dbPath: path.join(workDir, `${name}.sqlite`),
        db: (s as unknown as { db: never }).db,
        skipMigrations: true,
      });
      await snap.init();
      return { s, snap };
    };
    const a = await mk("a");
    const b = await mk("b");
    storeA = a.s;
    storeB = b.s;
    setToolContextFactory(async ({ orgId }) => {
      if (orgId === ORG_A) return { graphStore: a.s, snapshotStore: a.snap, orgId: ORG_A };
      if (orgId === ORG_B) return { graphStore: b.s, snapshotStore: b.snap, orgId: ORG_B };
      throw new Error(`unknown org in test: ${orgId}`);
    });
  });

  afterEach(async () => {
    setToolContextFactory(null);
    await storeA.close();
    await storeB.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  // [label, source spelling, target spelling]
  const CASES: Array<[string, string, string]> = [
    ["ApexClass", "ApexClass:BillingService", "ApexClass:billingservice"],
    ["CustomField", "CustomField:Account.Foo__c", "CustomField:account.foo__c"],
    ["ApexMethod", "ApexMethod:BillingService.Run(0)", "ApexMethod:billingservice.run(0)"],
    ["CustomObject", "CustomObject:ns__Obj__c", "CustomObject:NS__obj__C"],
    ["CustomField", "CustomField:ns__Obj__c.ns__Fld__c", "CustomField:NS__OBJ__C.ns__fld__c"],
  ];

  for (const [label, src, tgt] of CASES) {
    it(`${src} vs ${tgt}, same hash: unchanged, nothing destructive`, async () => {
      put(storeA, "orgA", label, src, "same");
      put(storeB, "orgB", label, tgt, "same");
      const diff = await callTool("cross_org_diff", {
        org_a: ORG_A,
        org_b: ORG_B,
        include_managed: true,
        include_standard: true,
      });
      const d = diff.data as { onlyInA: string[]; onlyInB: string[]; changed: string[] };
      expect(d.onlyInA).toEqual([]);
      expect(d.onlyInB).toEqual([]);
      expect(d.changed).toEqual([]);
      const m = await callTool("deployment_manifest_gen", {
        from_org: ORG_A,
        to_org: ORG_B,
        include_managed: true,
        include_standard: true,
      });
      const md = m.data as { packageXml: string; destructiveXml: string };
      expect(md.destructiveXml).not.toContain("<members>");
      expect(md.packageXml).not.toContain("<members>");
    });
  }

  it("same name apart from case, different hash: one modification, source spelling shown, never destructive", async () => {
    put(storeA, "orgA", "ApexClass", "ApexClass:BillingService", "v2");
    put(storeB, "orgB", "ApexClass", "ApexClass:billingservice", "v1");
    const diff = await callTool("cross_org_diff", { org_a: ORG_A, org_b: ORG_B });
    const d = diff.data as { onlyInA: string[]; onlyInB: string[]; changed: string[] };
    expect(d.onlyInA).toEqual([]);
    expect(d.onlyInB).toEqual([]);
    expect(d.changed).toEqual(["ApexClass:BillingService"]);
    const m = await callTool("deployment_manifest_gen", { from_org: ORG_A, to_org: ORG_B });
    const md = m.data as {
      packageXml: string;
      destructiveXml: string;
      droppedFromDestructive: unknown[];
    };
    expect(md.packageXml).toContain("<members>BillingService</members>");
    expect(md.destructiveXml).not.toContain("<members>");
    expect(md.droppedFromDestructive).toEqual([]);
  });

  it("a real removal next to a case-only match still goes in destructiveChanges.xml", async () => {
    put(storeA, "orgA", "ApexClass", "ApexClass:BillingService", "same");
    put(storeB, "orgB", "ApexClass", "ApexClass:billingservice", "same");
    put(storeB, "orgB", "ApexClass", "ApexClass:Gone", "g");
    const m = await callTool("deployment_manifest_gen", { from_org: ORG_A, to_org: ORG_B });
    const md = m.data as { packageXml: string; destructiveXml: string };
    expect(md.destructiveXml).toContain("<members>Gone</members>");
    expect(md.destructiveXml).not.toMatch(/billingservice/i);
    expect(md.packageXml).not.toContain("<members>");
  });

  it("only ASCII letters fold, as in SQLite NOCASE: a non-ASCII case difference stays two names", async () => {
    put(storeA, "orgA", "ApexClass", "ApexClass:CafÉ", "h");
    put(storeB, "orgB", "ApexClass", "ApexClass:café", "h");
    const diff = await callTool("cross_org_diff", { org_a: ORG_A, org_b: ORG_B });
    const d = diff.data as { onlyInA: string[]; onlyInB: string[] };
    expect(d.onlyInA).toEqual(["ApexClass:CafÉ"]);
    expect(d.onlyInB).toEqual(["ApexClass:café"]);
  });

  it("final invariant: a component deployed from one entry is dropped from the delete file and reported", async () => {
    // Two sharing rules of one object map to the same SharingRules member (`Account`). Rule R1
    // changed in the source, rule R2 exists only in the target: deleting `Account` would remove
    // the whole object's sharing rules that package.xml is deploying.
    put(storeA, "orgA", "SharingRule", "SharingRule:Account.R1", "v2");
    put(storeB, "orgB", "SharingRule", "SharingRule:Account.R1", "v1");
    put(storeB, "orgB", "SharingRule", "SharingRule:Account.R2", "x");
    const m = await callTool("deployment_manifest_gen", { from_org: ORG_A, to_org: ORG_B });
    const md = m.data as {
      packageXml: string;
      destructiveXml: string;
      droppedFromDestructive: Array<{ type: string; member: string }>;
    };
    expect(md.packageXml).toContain("<members>Account</members>");
    expect(md.destructiveXml).not.toContain("<members>");
    expect(md.droppedFromDestructive).toEqual([{ type: "SharingRules", member: "Account" }]);
    expect(m.markdown).toContain("left out of the delete file");
  });
});

/**
 * 1.8.2 F10 and F09 through the security_audit and export_sarif tools.
 */
describe("security_audit and export_sarif: case identity and sharing wording (F10, F09)", () => {
  let fix: Fixture;
  let prevExports: string | undefined;

  beforeEach(async () => {
    fix = await createFixture();
    prevExports = process.env.SFGRAPH_EXPORTS_DIR;
    process.env.SFGRAPH_EXPORTS_DIR = path.join(fix.workDir, "exports");
  });
  afterEach(async () => {
    await fix.cleanup();
    if (prevExports === undefined) Reflect.deleteProperty(process.env, "SFGRAPH_EXPORTS_DIR");
    else process.env.SFGRAPH_EXPORTS_DIR = prevExports;
  });

  type Audit = {
    fieldAccessMatrix: Array<{ field: string; grantedBy: string[] }>;
    flsGaps: string[];
    sharingEditAccess: string[];
    sharingFullAccess: string[];
    sharingEditAccessTotal: number;
    sharingRuleAccess: Array<{ qualifiedName: string; access: string; audience?: string }>;
  };

  const seedMixedCase = () => {
    fix.addNode({ qualifiedName: "CustomField:Account.Secret__c", label: "CustomField" });
    fix.addNode({ qualifiedName: "PermissionSet:Reader", label: "PermissionSet" });
    fix.addEdge({
      srcQualifiedName: "PermissionSet:Reader",
      dstQualifiedName: "CustomField:account.secret__c",
      relType: REL_TYPES.GRANTS_FIELD_ACCESS,
    });
  };

  it("a grant to account.secret__c and a field Account.Secret__c: one matrix entry, no gap, field's own spelling", async () => {
    seedMixedCase();
    const r = await callTool("security_audit", { org: fix.orgId });
    const d = r.data as Audit;
    expect(d.flsGaps).toEqual([]);
    expect(d.fieldAccessMatrix).toEqual([
      { field: "CustomField:Account.Secret__c", grantedBy: ["PermissionSet:Reader"] },
    ]);
  });

  it("an object filter in any case finds the same single entry and no gap", async () => {
    seedMixedCase();
    for (const object of ["Account", "account", "CustomObject:ACCOUNT"]) {
      const d = (await callTool("security_audit", { org: fix.orgId, object })).data as Audit;
      expect(d.flsGaps).toEqual([]);
      expect(d.fieldAccessMatrix.map((m) => m.field)).toEqual(["CustomField:Account.Secret__c"]);
    }
  });

  it("a field filter in any case reports the field's own spelling and no gap", async () => {
    seedMixedCase();
    for (const field of ["CustomField:account.secret__c", "CustomField:ACCOUNT.SECRET__C"]) {
      const d = (await callTool("security_audit", { org: fix.orgId, field })).data as Audit;
      expect(d.flsGaps).toEqual([]);
      expect(d.fieldAccessMatrix).toEqual([
        { field: "CustomField:Account.Secret__c", grantedBy: ["PermissionSet:Reader"] },
      ]);
    }
  });

  it("two grants that differ only in case merge into one entry with both grantors", async () => {
    seedMixedCase();
    fix.addNode({ qualifiedName: "Profile:Support", label: "Profile" });
    fix.addEdge({
      srcQualifiedName: "Profile:Support",
      dstQualifiedName: "CustomField:ACCOUNT.SECRET__C",
      relType: REL_TYPES.GRANTS_FIELD_ACCESS,
    });
    const d = (await callTool("security_audit", { org: fix.orgId })).data as Audit;
    expect(d.fieldAccessMatrix).toHaveLength(1);
    expect([...d.fieldAccessMatrix[0]!.grantedBy].sort()).toEqual([
      "PermissionSet:Reader",
      "Profile:Support",
    ]);
  });

  it("a granted field with no node uses the grant's spelling; a genuine gap is still a gap", async () => {
    fix.addNode({ qualifiedName: "PermissionSet:Reader", label: "PermissionSet" });
    fix.addEdge({
      srcQualifiedName: "PermissionSet:Reader",
      dstQualifiedName: "CustomField:Account.NoNode__c",
      relType: REL_TYPES.GRANTS_FIELD_ACCESS,
    });
    fix.addNode({ qualifiedName: "CustomField:Account.Open__c", label: "CustomField" });
    const d = (await callTool("security_audit", { org: fix.orgId })).data as Audit;
    expect(d.fieldAccessMatrix.map((m) => m.field)).toEqual(["CustomField:Account.NoNode__c"]);
    expect(d.flsGaps).toEqual(["CustomField:Account.Open__c"]);
  });

  it("system fields are excluded from gaps without regard to case", async () => {
    fix.addNode({ qualifiedName: "CustomField:Account.createdbyid", label: "CustomField" });
    const d = (await callTool("security_audit", { org: fix.orgId })).data as Audit;
    expect(d.flsGaps).toEqual([]);
  });

  it("sharing: Edit and All are kept apart, the audience is shown, and the old name is a deprecated alias", async () => {
    fix.addNode({
      qualifiedName: "SharingRule:Case.EditRule",
      label: "SharingRule",
      attributes: { accessLevel: "Edit", sharedTo: { group: "SupportGroup" } },
    });
    fix.addNode({
      qualifiedName: "SharingRule:Case.AllRule",
      label: "SharingRule",
      attributes: { accessLevel: "All", sharedTo: "Role: Manager" },
    });
    fix.addNode({
      qualifiedName: "SharingRule:Case.ReadRule",
      label: "SharingRule",
      attributes: { accessLevel: "Read" },
    });
    const r = await callTool("security_audit", { org: fix.orgId });
    const d = r.data as Audit;
    expect([...d.sharingEditAccess].sort()).toEqual([
      "SharingRule:Case.AllRule",
      "SharingRule:Case.EditRule",
    ]);
    expect(d.sharingFullAccess).toEqual(d.sharingEditAccess);
    const byName = new Map(d.sharingRuleAccess.map((x) => [x.qualifiedName, x]));
    expect(byName.get("SharingRule:Case.EditRule")).toMatchObject({
      access: "Edit",
      audience: "group: SupportGroup",
    });
    expect(byName.get("SharingRule:Case.AllRule")).toMatchObject({
      access: "All",
      audience: "Role: Manager",
    });
    expect(r.markdown).toContain("record sharing only");
    expect(r.markdown).not.toMatch(/bypass|Modify All|View All|full[- ]access/i);
    expect(r.summary).not.toMatch(/full-access/i);
  });

  it("SARIF rule text and messages describe record access, not a CRUD/FLS bypass", async () => {
    fix.addNode({
      qualifiedName: "SharingRule:Case.EditRule",
      label: "SharingRule",
      attributes: { accessLevel: "Edit", sharedTo: { guestUser: "SiteGuest" } },
    });
    const r = await callTool("export_sarif", { org: fix.orgId, audits: ["security"] });
    const { report, findings } = r.data as {
      report: { runs: Array<{ tool: { driver: { rules: Array<Record<string, any>> } } }> };
      findings: Array<{ ruleId: string; message: string; level: string }>;
    };
    const rules = report.runs[0]!.tool.driver.rules;
    const rule = rules.find((x) => x.id === "security.sharing-edit-access");
    expect(rule).toBeDefined();
    expect(rules.find((x) => x.id === "security.sharing-full-access")).toBeUndefined();
    const text = JSON.stringify(rule);
    expect(text).not.toMatch(/bypass(es)?\b.*(FLS|CRUD)|Modify All \/ View All to/i);
    expect(rule!.fullDescription.text).toContain("record sharing only");
    expect(rule!.fullDescription.text).toContain("not Modify All or View All");
    const f = findings.find((x) => x.ruleId === "security.sharing-edit-access")!;
    expect(f.message).toContain("Edit access to records to guestUser: SiteGuest");
    expect(f.message).not.toMatch(/full access|bypass/i);
    expect(f.level).toBe("note");
  });
});
