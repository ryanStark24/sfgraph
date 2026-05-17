import { describe, expect, it } from "vitest";
import {
  collectFindings,
  danglingEdgesToFindings,
  deadCodeToFindings,
  governorRisksToFindings,
  RULE_CATALOG,
  securityAuditToFindings,
} from "../findings.js";
import type { AuditResult } from "../audit-graph.js";
import type { GovernorRisk } from "../governor.js";
import type { SecurityAudit } from "../security.js";

describe("W3-01: Finding adapters", () => {
  it("RULE_CATALOG includes every ruleId the adapters can emit", () => {
    const referenced = new Set<string>();
    // Exercise every adapter on a representative input
    governorRisksToFindings([
      { qualifiedName: "X", risk: "soql_in_loop", evidence: "" },
      { qualifiedName: "X", risk: "dml_in_loop", evidence: "" },
      { qualifiedName: "X", risk: "unbounded_query", evidence: "" },
      { qualifiedName: "X", risk: "no_bulk", evidence: "" },
    ]).forEach((f) => referenced.add(f.ruleId));
    securityAuditToFindings({
      sharingFullAccess: ["CustomObject:X"],
      flsGaps: ["CustomField:X.Y"],
      fieldAccessMatrix: [],
    }).forEach((f) => referenced.add(f.ruleId));
    deadCodeToFindings([
      {
        orgId: "org" as never,
        qualifiedName: "X" as never,
        label: "ApexClass",
        attributes: {},
        sourceHash: "h" as never,
        firstSeenAt: 0,
        lastSeenAt: 0,
        lastModifiedAt: 0,
      },
    ]).forEach((f) => referenced.add(f.ruleId));
    danglingEdgesToFindings({
      totalEdges: 1,
      danglingCount: 1,
      byRel: {},
      byDstPrefix: {},
      sample: [{ src: "X", rel: "CALLS", dst: "Y" }],
    }).forEach((f) => referenced.add(f.ruleId));

    for (const id of referenced) {
      expect(RULE_CATALOG[id], `RULE_CATALOG should contain ${id}`).toBeDefined();
    }
  });

  it("governorRisksToFindings maps risk codes to dotted ruleIds", () => {
    const risks: GovernorRisk[] = [
      { qualifiedName: "ApexClass:Foo", risk: "soql_in_loop", evidence: "x" },
      { qualifiedName: "ApexClass:Bar", risk: "dml_in_loop", evidence: "y" },
    ];
    const findings = governorRisksToFindings(risks);
    expect(findings.map((f) => f.ruleId).sort()).toEqual([
      "governor.dml-in-loop",
      "governor.soql-in-loop",
    ]);
  });

  it("securityAuditToFindings emits both fls-gap and sharing-full-access", () => {
    const audit: SecurityAudit = {
      sharingFullAccess: ["CustomObject:Account"],
      flsGaps: ["CustomField:Account.SSN__c"],
      fieldAccessMatrix: [],
    };
    const findings = securityAuditToFindings(audit);
    const byId = new Map(findings.map((f) => [f.ruleId, f]));
    expect(byId.get("security.fls-gap")?.location.qualifiedName).toBe(
      "CustomField:Account.SSN__c",
    );
    expect(byId.get("security.sharing-full-access")?.location.qualifiedName).toBe(
      "CustomObject:Account",
    );
  });

  it("collectFindings merges multiple audit outputs into a single array", () => {
    const findings = collectFindings({
      governor: [{ qualifiedName: "X", risk: "soql_in_loop", evidence: "" }],
      security: { sharingFullAccess: [], flsGaps: ["CustomField:X.Y"], fieldAccessMatrix: [] },
    } as Parameters<typeof collectFindings>[0]);
    expect(findings.length).toBe(2);
    expect(findings.map((f) => f.ruleId).sort()).toEqual([
      "governor.soql-in-loop",
      "security.fls-gap",
    ]);
  });

  it("deadCodeToFindings preserves sourceUri from node attributes for SARIF physicalLocation", () => {
    const findings = deadCodeToFindings([
      {
        orgId: "org" as never,
        qualifiedName: "ApexClass:Unused" as never,
        label: "ApexClass",
        attributes: { sourceUri: "sf://org/ApexClass/Unused.cls" },
        sourceHash: "h" as never,
        firstSeenAt: 0,
        lastSeenAt: 0,
        lastModifiedAt: 0,
      },
    ]);
    expect(findings[0]?.location.sourceUri).toBe("sf://org/ApexClass/Unused.cls");
  });
});
