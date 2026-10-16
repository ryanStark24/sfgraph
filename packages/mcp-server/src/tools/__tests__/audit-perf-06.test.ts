import { analyze } from "@ryanstark24/sfgraph-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fixture, REL_TYPES, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

/**
 * Audit perf-06: security_audit returns unbounded data.flsGaps /
 * data.fieldAccessMatrix (only the markdown honours `limit`) and a
 * field-filtered call still scans the grants of every Profile/PermissionSet.
 */
let fix: Fixture;

beforeEach(async () => {
  fix = await createFixture();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fix.cleanup();
});

describe("audit perf-06: security_audit payload and scan", () => {
  it("applies `limit` to data.flsGaps, not just the markdown", async () => {
    for (let i = 0; i < 200; i++) {
      fix.addNode({ qualifiedName: `CustomField:Account.Gap${i}__c`, label: "CustomField" });
    }
    const r = await callTool("security_audit", { org: fix.orgId, limit: 10 });
    const d = r.data as { flsGaps: string[] };
    expect(d.flsGaps.length).toBeLessThanOrEqual(10);
  });

  it("field-filtered audit does not read grants of every permission set", async () => {
    const PS = 60;
    fix.addNode({ qualifiedName: "CustomField:Account.Target__c", label: "CustomField" });
    for (let i = 0; i < PS; i++) {
      const ps = `PermissionSet:PS${i}`;
      fix.addNode({ qualifiedName: ps, label: "PermissionSet" });
      fix.addEdge({
        srcQualifiedName: ps,
        dstQualifiedName: `CustomField:Account.Other${i}__c`,
        relType: REL_TYPES.GRANTS_FIELD_ACCESS,
        attributes: { read: true },
      });
    }
    const spy = vi.spyOn(fix.ctx.graphStore, "listEdgesFrom");
    await callTool("security_audit", { org: fix.orgId, field: "CustomField:Account.Target__c" });
    const grantReads = spy.mock.calls.filter((c) => String(c[2]) === "GRANTS_FIELD_ACCESS").length;
    expect(grantReads).toBeLessThan(PS);
  });

  it("applies `limit` to data.fieldAccessMatrix and reports full totals", async () => {
    for (let i = 0; i < 30; i++) {
      fix.addNode({ qualifiedName: `PermissionSet:G${i}`, label: "PermissionSet" });
      fix.addEdge({
        srcQualifiedName: `PermissionSet:G${i}`,
        dstQualifiedName: `CustomField:Account.F${i}__c`,
        relType: REL_TYPES.GRANTS_FIELD_ACCESS,
      });
    }
    const r = await callTool("security_audit", { org: fix.orgId, limit: 5 });
    const d = r.data as {
      fieldAccessMatrix: unknown[];
      fieldAccessMatrixTotal: number;
      limited: boolean;
    };
    expect(d.fieldAccessMatrix.length).toBe(5);
    expect(d.fieldAccessMatrixTotal).toBe(30);
    expect(d.limited).toBe(true);
  });

  it("field-filtered fast path matches the core audit", async () => {
    fix.addNode({ qualifiedName: "Profile:Admin", label: "Profile" });
    fix.addNode({ qualifiedName: "PermissionSet:Sales", label: "PermissionSet" });
    fix.addNode({ qualifiedName: "ApexClass:NotAGrantor", label: "ApexClass" });
    fix.addNode({
      qualifiedName: "SharingRule:Account.All",
      label: "SharingRule",
      attributes: { accessLevel: "All" },
    });
    const fields = [
      "CustomField:Account.Granted__c",
      "CustomField:Account.Gap__c",
      "CustomField:Cfg__mdt.Value__c",
      "CustomField:Account.Name",
    ];
    for (const f of fields) fix.addNode({ qualifiedName: f, label: "CustomField" });
    for (const src of ["Profile:Admin", "PermissionSet:Sales", "ApexClass:NotAGrantor"]) {
      fix.addEdge({
        srcQualifiedName: src,
        dstQualifiedName: "CustomField:Account.Granted__c",
        relType: REL_TYPES.GRANTS_FIELD_ACCESS,
      });
    }
    // A grant to a field that has no node is still part of the matrix.
    fix.addEdge({
      srcQualifiedName: "PermissionSet:Sales",
      dstQualifiedName: "CustomField:Account.NoNode__c",
      relType: REL_TYPES.GRANTS_FIELD_ACCESS,
    });
    const norm = (a: analyze.SecurityAudit) => ({
      sharingFullAccess: [...a.sharingFullAccess].sort(),
      fieldAccessMatrix: a.fieldAccessMatrix.map((m) => ({
        ...m,
        grantedBy: [...m.grantedBy].sort(),
      })),
      flsGaps: [...a.flsGaps].sort(),
      flsGapsExcluded: a.flsGapsExcluded,
    });
    for (const field of [...fields, "CustomField:Account.NoNode__c", "CustomField:Missing.X__c"]) {
      for (const include of [false, true]) {
        const r = await callTool("security_audit", {
          org: fix.orgId,
          field,
          include_non_fls_fields: include,
        });
        const core = analyze.securityAudit(fix.ctx.graphStore, fix.orgId, {
          field,
          includeNonFlsFields: include,
        });
        expect(norm(r.data as analyze.SecurityAudit)).toEqual(norm(core));
      }
    }
  });

  it("caps sharingFullAccess and cachedFindings at `limit` with totals (review M6)", async () => {
    for (let i = 0; i < 25; i++) {
      fix.addNode({
        qualifiedName: `SharingRule:Account.R${i}`,
        label: "SharingRule",
        attributes: { accessLevel: "Edit" },
      });
    }
    const db = (fix.ctx.graphStore as unknown as { db: never }).db;
    (fix.ctx as { db?: unknown }).db = db;
    analyze.populateSecurityFindings(fix.ctx.graphStore, fix.orgId, db);
    const r = await callTool("security_audit", { org: fix.orgId, limit: 4 });
    const d = r.data as {
      sharingFullAccess: string[];
      sharingFullAccessTotal: number;
      cachedFindings: unknown[];
      cachedFindingsTotal: number;
      limited: boolean;
    };
    expect(d.sharingFullAccess.length).toBe(4);
    expect(d.sharingFullAccessTotal).toBe(25);
    expect(d.cachedFindings.length).toBe(4);
    expect(d.cachedFindingsTotal).toBe(25);
    expect(d.limited).toBe(true);
    expect(r.summary).toMatch(/25 full-access rules/);
  });
});
