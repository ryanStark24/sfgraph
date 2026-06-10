import { describe, expect, it } from "vitest";
import type { OrgCapabilities } from "../../extractors/live-org/capabilities.js";
import { iterVlocityRecords } from "../../extractors/live-org/vlocity/runner.js";
import type { ParseContext } from "../../parsers/contract.js";
import { parserRegistry } from "../../parsers/index.js";
import { adaptParserInput } from "../live-ingest.js";

/**
 * End-to-end coverage for the runner→dispatch→parser seam that shipped
 * broken: the Vlocity runner emits memberType "DataRaptor" /
 * "IntegrationProcedure" / "OmniScript" / "VlocityCard", but the four rich
 * parsers register under "Vlocity"-prefixed type names. adaptParserInput
 * didn't map between them, so every datapack except VlocityCard fell through
 * to the opaque node parser — shallow nodes, ZERO DR_/IP_/OS_ edges. The
 * golden tests call parsers directly and never exercised this seam, which is
 * how it stayed broken through a full live ingest.
 *
 * This test drives a mocked Vlocity org through the REAL runner (with child
 * fetches), then through the REAL dispatch + registry lookup + parse, and
 * asserts the resulting edges are the rich lineage edges — not opaque.
 */
const caps = {
  vlocityNamespaces: ["vlocity_cmt"],
  vlocityLegacy: true,
} as unknown as OrgCapabilities;

const ctx: ParseContext = {
  orgId: "00DTestVloc",
  sourceUri: "test://vloc",
  parseTimestamp: "2026-01-01T00:00:00.000Z",
  namespace: "vlocity_cmt",
  logger: { debug() {}, info() {}, warn() {}, error() {} } as ParseContext["logger"],
};

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const m of it) out.push(m);
  return out;
}

/** Run one runner-emitted member through the exact path live-ingest uses. */
async function dispatchAndParse(member: { ref: { memberType: string }; content: string }) {
  const adapted = adaptParserInput(member.ref as never, member.content);
  expect(adapted, `no adapter for ${member.ref.memberType}`).not.toBeNull();
  const parser = parserRegistry.for(adapted!.type);
  expect(parser, `no parser registered for ${adapted!.type}`).toBeDefined();
  return parser!.parse(adapted!.input, ctx);
}

function rels(edges: Array<{ relType: string }>): Set<string> {
  return new Set(edges.map((e) => e.relType));
}

describe("Vlocity runner → dispatch → parser integration", () => {
  it("DataRaptor: runner child mappings become DR_READS_FIELD lineage, not opaque", async () => {
    const conn = {
      query: async (soql: string) => {
        if (soql.includes("__DRBundle__c")) {
          return {
            records: [{ Id: "a0D1", Name: "AccountExtract", vlocity_cmt__Type__c: "Extract" }],
            done: true,
          };
        }
        if (soql.includes("__DRMapItem__c")) {
          return {
            records: [
              {
                Id: "a0M1",
                Name: "m1",
                vlocity_cmt__InterfaceObjectName__c: "Account",
                vlocity_cmt__InterfaceFieldAPIName__c: "Name",
                vlocity_cmt__DomainObjectAPIName__c: "json",
                vlocity_cmt__DomainObjectFieldAPIName__c: "Details:Name",
                vlocity_cmt__DRBundleId__c: "a0D1",
              },
            ],
            done: true,
          };
        }
        return { records: [], done: true };
      },
    };
    const members = await collect(iterVlocityRecords(conn, caps, "00DTestVloc"));
    const dr = members.find((m) => m.ref.memberType === "DataRaptor");
    expect(dr).toBeDefined();
    const result = await dispatchAndParse(dr!);
    // The decisive assertion: rich lineage edge, NOT an opaque node.
    const relSet = rels(result.edges);
    expect(relSet.has("DR_READS_FIELD")).toBe(true);
    expect(
      result.edges.some((e) => String(e.dstQualifiedName) === "CustomField:Account.Name"),
    ).toBe(true);
    // Node is the rich DataRaptor label, not OpaqueMetadata.
    expect(result.nodes[0]?.label).toBe("DataRaptor");
  });

  it("IntegrationProcedure: runner element graph becomes IP_* edges", async () => {
    const conn = {
      query: async (soql: string) => {
        if (soql.includes("__OmniScript__c") && soql.toLowerCase().includes("isprocedure")) {
          return {
            records: [{ Id: "a0I1", Name: "MyIP", vlocity_cmt__IsProcedure__c: true }],
            done: true,
          };
        }
        if (soql.includes("__Element__c")) {
          return {
            records: [
              {
                Id: "e1",
                Name: "callDR",
                vlocity_cmt__Type__c: "DataRaptor Extract Action",
                vlocity_cmt__PropertySet__c: JSON.stringify({ bundle: "AccountExtract" }),
                vlocity_cmt__OmniScriptId__c: "a0I1",
              },
            ],
            done: true,
          };
        }
        return { records: [], done: true };
      },
    };
    const members = await collect(iterVlocityRecords(conn, caps, "00DTestVloc"));
    const ip = members.find((m) => m.ref.memberType === "IntegrationProcedure");
    expect(ip).toBeDefined();
    const result = await dispatchAndParse(ip!);
    expect(result.nodes[0]?.label).toBe("IntegrationProcedure");
    expect(rels(result.edges).has("IP_CALLS_DR")).toBe(true);
  });

  it("maps each runner memberType to its rich parser (none fall to opaque)", () => {
    for (const [memberType, expectedParserType] of [
      ["DataRaptor", "VlocityDataRaptor"],
      ["IntegrationProcedure", "VlocityIntegrationProcedure"],
      ["OmniScript", "VlocityOmniScript"],
      ["VlocityCard", "VlocityCard"],
    ] as const) {
      const adapted = adaptParserInput(
        { memberType, memberName: "X" } as never,
        JSON.stringify({ Name: "X" }),
      );
      expect(adapted?.type, `${memberType} should map to ${expectedParserType}`).toBe(
        expectedParserType,
      );
      expect(adapted?.type).not.toBe("OpaqueMetadata");
      expect(parserRegistry.for(adapted!.type)).toBeDefined();
    }
  });
});
