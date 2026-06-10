import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../../parsers/__tests__/_harness.js";
import { parserRegistry } from "../../../parsers/registry.js";
import { loadAllRules } from "../../../parsers/rules/_loader.js";
import type { RawMember } from "../../interfaces/metadata-source.js";
import { iterCustomSettings } from "../extractors/custom-settings.js";

async function collect(it: AsyncIterable<RawMember>): Promise<RawMember[]> {
  const out: RawMember[] = [];
  for await (const m of it) out.push(m);
  return out;
}

describe("iterCustomSettings", () => {
  it("discovers IsCustomSetting objects and captures their rows (minus system fields)", async () => {
    const conn = {
      tooling: {
        query: async (soql: string) => {
          expect(soql).toContain("IsCustomSetting = true");
          return { records: [{ QualifiedApiName: "Integration_Settings__c" }], done: true };
        },
      },
      query: async (soql: string) => {
        if (soql.includes("Integration_Settings__c")) {
          return {
            records: [
              {
                attributes: { type: "Integration_Settings__c" },
                Id: "a01x0000000001",
                SystemModstamp: "2025-01-01T00:00:00Z",
                Name: "Default",
                Endpoint__c: "https://api.example.com/orders",
                Timeout__c: 30000,
              },
            ],
            done: true,
          };
        }
        return { records: [], done: true };
      },
    };
    const members = await collect(iterCustomSettings(conn, "00Dtest"));
    expect(members).toHaveLength(1);
    const m = members[0]!;
    expect(m.ref.memberType).toBe("CustomSetting");
    expect(m.ref.memberName).toBe("Integration_Settings__c");
    const parsed = JSON.parse(m.content) as {
      name: string;
      rows: Array<Record<string, unknown>>;
    };
    expect(parsed.name).toBe("Integration_Settings__c");
    expect(parsed.rows).toHaveLength(1);
    // System/audit fields stripped, config fields kept.
    expect(parsed.rows[0]).not.toHaveProperty("Id");
    expect(parsed.rows[0]).not.toHaveProperty("SystemModstamp");
    expect(parsed.rows[0]?.Endpoint__c).toBe("https://api.example.com/orders");
  });

  it("yields nothing when the org has no custom settings", async () => {
    const conn = {
      tooling: { query: async () => ({ records: [], done: true }) },
      query: async () => ({ records: [], done: true }),
    };
    expect(await collect(iterCustomSettings(conn, "00Dtest"))).toEqual([]);
  });

  it("custom-setting rule turns the member into a CustomSetting node with rows + INSTANCE_OF edge", async () => {
    await loadAllRules();
    const parser = parserRegistry.for("CustomSetting");
    expect(parser).toBeDefined();
    const result = await parser!.parse(
      {
        name: "Integration_Settings__c",
        rows: [{ Name: "Default", Endpoint__c: "https://api.example.com/orders" }],
        rowCount: 1,
      } as never,
      makeTestCtx(),
    );
    const node = result.nodes.find((n) => n.label === "CustomSetting");
    expect(node).toBeDefined();
    expect(String(node!.qualifiedName)).toBe("CustomSetting:Integration_Settings__c");
    const rows = (node!.attributes as { customSettingRows?: unknown[] }).customSettingRows;
    expect(Array.isArray(rows)).toBe(true);
    // Linked to its schema object.
    expect(
      result.edges.some(
        (e) =>
          e.relType === "INSTANCE_OF" &&
          String(e.dstQualifiedName) === "CustomObject:Integration_Settings__c",
      ),
    ).toBe(true);
  });
});
