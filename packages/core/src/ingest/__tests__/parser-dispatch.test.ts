import { describe, expect, it } from "vitest";
import type { MemberRef } from "../../extractors/interfaces/metadata-source.js";
// Side-effect import registers all code parsers (incl. OpaqueMetadata).
import { loadAllRules, parserRegistry } from "../../parsers/index.js";
import { adaptParserInput } from "../live-ingest.js";

function ref(memberType: string, memberName: string): MemberRef {
  return {
    category: "OpaqueMetadata" as never,
    memberType,
    memberName,
    lastModifiedAt: null,
    sourceUri: `sf://test/${memberType}/${memberName}`,
    namespace: null,
  } as MemberRef;
}

/**
 * Regression coverage for the silent-drop dispatch bug: adaptParserInput
 * used to return null for every memberType outside a hardcoded 17-case
 * switch, so generic-extractor members (Layout, CustomTab, Bot, …) were
 * extracted, logged as ✓, and never merged into the graph — leaving e.g.
 * 59k GRANTS_TAB_ACCESS edges dangling on nodes that were never created.
 */
describe("live-ingest parser dispatch — long-tail fallback", () => {
  it("routes rule-based types (Layout) to their registered parser", async () => {
    await loadAllRules();
    const adapted = adaptParserInput(ref("Layout", "Account-Account Layout"), "{}");
    expect(adapted).not.toBeNull();
    expect(adapted?.type).toBe("Layout");
    expect(parserRegistry.for(adapted?.type ?? "")).toBeDefined();
  });

  it("falls back to OpaqueMetadata for types with no parser — never null", async () => {
    const adapted = adaptParserInput(
      ref("CustomTab", "Booking__c"),
      JSON.stringify({ fullName: "Booking__c", motif: "Custom20: Airplane" }),
    );
    expect(adapted?.type).toBe("OpaqueMetadata");
    const parser = parserRegistry.for("OpaqueMetadata");
    expect(parser).toBeDefined();
    const result = await parser?.parse(adapted?.input as never, {
      orgId: "00Dtest",
      sourceUri: "sf://test",
      parseTimestamp: new Date().toISOString(),
      namespace: null,
      logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
    });
    // The member becomes a real node with the grant-matching qname.
    expect(result?.nodes?.[0]?.qualifiedName).toBe("CustomTab:Booking__c");
  });

  it("passes JSON metadata.read payloads as sibling keys for xml-string rules", async () => {
    await loadAllRules();
    const adapted = adaptParserInput(
      ref("ApexPage", "MyPage"),
      JSON.stringify({ fullName: "MyPage", apiVersion: 60, label: "My Page" }),
    );
    expect(adapted?.type).toBe("ApexPage");
    const input = adapted?.input as Record<string, unknown>;
    expect(input.name).toBe("MyPage");
    expect(input.label).toBe("My Page");
    expect(input.xml).toBe("");
  });
});
