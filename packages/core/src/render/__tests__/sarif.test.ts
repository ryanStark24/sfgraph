import { describe, expect, it } from "vitest";
import type { Finding } from "../../analyze/findings.js";
import { emitSarif, lintSarifReport } from "../sarif.js";

describe("W3-01/W3-02: SARIF 2.1.0 emitter", () => {
  it("emits a valid empty report when there are no findings", () => {
    const report = emitSarif({ version: "1.1.8", findings: [] });
    expect(report.version).toBe("2.1.0");
    expect(report.runs.length).toBe(1);
    expect(report.runs[0]?.tool.driver.rules).toEqual([]);
    expect(report.runs[0]?.results).toEqual([]);
    expect(lintSarifReport(report)).toEqual([]);
  });

  it("includes a rule definition only for ruleIds referenced by results", () => {
    const findings: Finding[] = [
      {
        ruleId: "governor.soql-in-loop",
        message: "Foo: SOQL inside loop",
        level: "error",
        location: { qualifiedName: "ApexClass:Foo" },
      },
      {
        ruleId: "security.fls-gap",
        message: "Bar: no FLS grants",
        level: "warning",
        location: { qualifiedName: "CustomField:Account.Bar__c" },
      },
    ];
    const report = emitSarif({ version: "1.1.8", findings });
    const rules = report.runs[0]?.tool.driver.rules ?? [];
    expect(rules.map((r) => r.id).sort()).toEqual([
      "governor.soql-in-loop",
      "security.fls-gap",
    ]);
    // Other rules in the catalog (e.g. dead-code.unreferenced) NOT emitted
    expect(rules.find((r) => r.id === "dead-code.unreferenced")).toBeUndefined();
  });

  it("populates physicalLocation when the finding has a sourceUri + line", () => {
    const finding: Finding = {
      ruleId: "governor.soql-in-loop",
      message: "Foo: SOQL inside loop",
      level: "error",
      location: {
        qualifiedName: "ApexClass:Foo",
        sourceUri: "sf://org/ApexClass/Foo.cls",
        line: 42,
        column: 8,
      },
    };
    const report = emitSarif({ version: "1.1.8", findings: [finding] });
    const loc = report.runs[0]?.results[0]?.locations[0];
    expect(loc?.physicalLocation?.artifactLocation.uri).toBe("sf://org/ApexClass/Foo.cls");
    expect(loc?.physicalLocation?.region?.startLine).toBe(42);
    expect(loc?.physicalLocation?.region?.startColumn).toBe(8);
    expect(loc?.logicalLocations?.[0]?.fullyQualifiedName).toBe("ApexClass:Foo");
  });

  it("emits only logicalLocation when the finding has no source URI (graph-only finding)", () => {
    const finding: Finding = {
      ruleId: "graph.dangling-edge",
      message: "missing dst",
      level: "note",
      location: { qualifiedName: "ApexClass:Caller" },
    };
    const report = emitSarif({ version: "1.1.8", findings: [finding] });
    const loc = report.runs[0]?.results[0]?.locations[0];
    expect(loc?.physicalLocation).toBeUndefined();
    expect(loc?.logicalLocations?.[0]?.fullyQualifiedName).toBe("ApexClass:Caller");
    // Still SARIF-valid: every result has at least one location entry.
    expect(lintSarifReport(report)).toEqual([]);
  });

  it("emits a stub rule definition for unknown ruleIds (doesn't drop the result)", () => {
    const finding: Finding = {
      ruleId: "future.experimental",
      message: "TBD",
      level: "note",
      location: { qualifiedName: "X:Y" },
    };
    const report = emitSarif({ version: "1.1.8", findings: [finding] });
    const rule = report.runs[0]?.tool.driver.rules.find((r) => r.id === "future.experimental");
    expect(rule).toBeDefined();
    expect(rule?.fullDescription.text).toMatch(/No catalog entry/);
    // No lint errors — the stub keeps the report valid.
    expect(lintSarifReport(report)).toEqual([]);
  });

  it("preserves Finding.properties on SARIF result properties bag", () => {
    const finding: Finding = {
      ruleId: "governor.soql-in-loop",
      message: "Foo: SOQL inside loop",
      level: "error",
      location: { qualifiedName: "ApexClass:Foo" },
      properties: { evidence: "attribute hasSoqlInLoop=true", count: 3 },
    };
    const report = emitSarif({ version: "1.1.8", findings: [finding] });
    expect(report.runs[0]?.results[0]?.properties).toEqual({
      evidence: "attribute hasSoqlInLoop=true",
      count: 3,
    });
  });

  it("lintSarifReport flags results that reference an undefined ruleId", () => {
    // Manually construct an invalid report (bypassing emitSarif which fixes
    // this for us) to exercise the lint check.
    const report = {
      $schema:
        "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
      version: "2.1.0" as const,
      runs: [
        {
          tool: {
            driver: {
              name: "sfgraph",
              version: "1.1.8",
              informationUri: "https://example.test",
              rules: [], // empty
            },
          },
          results: [
            {
              ruleId: "governor.soql-in-loop",
              level: "error" as const,
              message: { text: "x" },
              locations: [{ logicalLocations: [{ fullyQualifiedName: "X", kind: "module" }] }],
            },
          ],
        },
      ],
    };
    const errors = lintSarifReport(report);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("governor.soql-in-loop"))).toBe(true);
  });
});
