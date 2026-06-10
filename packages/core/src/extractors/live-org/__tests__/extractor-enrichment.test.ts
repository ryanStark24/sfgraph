import { asOrgId } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import type { RawMember } from "../../interfaces/metadata-source.js";
import type { OrgCapabilities } from "../capabilities.js";
import { iterApex } from "../extractors/apex.js";
import { iterOmnistudio } from "../extractors/omnistudio.js";
import { iterVlocityRecords } from "../vlocity/runner.js";

/**
 * Regression coverage for the three extractor↔parser shape-mismatch bugs
 * we just fixed:
 *
 *   1. Apex `apiVersion: null` on live ingest — extractor now selects
 *      ApiVersion/Status and emits a JSON envelope containing metaXml
 *      that adaptParserInput unwraps.
 *
 *   2. OmniStudio nodes had no inner element graph — extractor now
 *      second-passes OmniProcessElement and attaches `elements` so the
 *      parser walk emits OMNI_CALLS_DATA_TRANSFORM / OMNI_EMBEDS_UI_CARD /
 *      OMNI_CALLS_INTEGRATION_PROCEDURE edges.
 *
 *   3. Vlocity datapacks lacked PropertySet/Definition content — extractor
 *      now SELECTs the long-text blobs, fetches Element__c / DRMapItem__c
 *      children, and JSON-parses the blobs so parser walks find real
 *      `propertySet` / element trees instead of empty stubs.
 */

async function collect(iter: AsyncIterable<RawMember>): Promise<RawMember[]> {
  const out: RawMember[] = [];
  for await (const m of iter) out.push(m);
  return out;
}

describe("apex extractor — robustness", () => {
  it("does NOT leak unhandled rejections when one of the two parallel queries fails", async () => {
    // Track unhandled rejections during this test run.
    const orphans: unknown[] = [];
    const handler = (reason: unknown) => orphans.push(reason);
    process.on("unhandledRejection", handler);
    try {
      const conn = {
        tooling: {
          query: async (soql: string) => {
            if (soql.includes("FROM ApexTrigger"))
              throw new Error("INVALID_SESSION: simulated trigger query failure");
            return {
              records: [{ Id: "01p9", Name: "Survivor", Body: "class Survivor {}" }],
              done: true,
            };
          },
        },
      };
      const members = await collect(iterApex(conn));
      // Class results still come back even though trigger query rejected.
      expect(members.some((m) => m.ref.memberType === "ApexClass")).toBe(true);
      // Give microtasks a chance to flush any orphan rejections.
      await new Promise((r) => setImmediate(r));
    } finally {
      process.off("unhandledRejection", handler);
    }
    expect(orphans).toEqual([]);
  });
});

describe("apex extractor — apiVersion envelope", () => {
  it("emits content as a {body, metaXml} JSON envelope with apiVersion + status when present", async () => {
    const conn = {
      tooling: {
        query: async (soql: string) => {
          if (soql.startsWith("SELECT") && soql.includes("FROM ApexClass")) {
            return {
              records: [
                {
                  Id: "01p1",
                  Name: "Hello",
                  Body: "public class Hello {}",
                  ApiVersion: 60,
                  Status: "Active",
                  LastModifiedDate: "2026-05-15T00:00:00Z",
                },
              ],
              done: true,
            };
          }
          return { records: [], done: true };
        },
      },
    };
    const members = await collect(iterApex(conn));
    const classMember = members.find((m) => m.ref.memberType === "ApexClass");
    expect(classMember).toBeDefined();
    const parsed = JSON.parse(classMember!.content) as { body: string; metaXml?: string };
    expect(parsed.body).toContain("public class Hello");
    expect(parsed.metaXml).toBeDefined();
    expect(parsed.metaXml).toContain("<apiVersion>60</apiVersion>");
    expect(parsed.metaXml).toContain("<status>Active</status>");
  });

  it("omits metaXml when neither ApiVersion nor Status is present (filesystem-style ingestion)", async () => {
    const conn = {
      tooling: {
        query: async (soql: string) => {
          if (soql.includes("FROM ApexClass")) {
            return {
              records: [{ Id: "01p2", Name: "Bare", Body: "class Bare {}" }],
              done: true,
            };
          }
          return { records: [], done: true };
        },
      },
    };
    const members = await collect(iterApex(conn));
    const classMember = members.find((m) => m.ref.memberType === "ApexClass");
    const parsed = JSON.parse(classMember!.content) as { body: string; metaXml?: string };
    expect(parsed.body).toBe("class Bare {}");
    expect(parsed.metaXml).toBeUndefined();
  });
});

describe("omnistudio extractor — element graph", () => {
  it("attaches OmniProcessElement rows (with parsed PropertySet) under metadata.elements", async () => {
    const conn = {
      query: async (soql: string) => {
        if (soql.includes("FROM OmniProcess") && !soql.includes("OmniProcessElement")) {
          return {
            records: [
              {
                Id: "0OP1",
                Name: "MyProcess",
                LastModifiedDate: "2026-05-15T00:00:00Z",
              },
            ],
            done: true,
          };
        }
        if (soql.includes("FROM OmniProcessElement")) {
          return {
            records: [
              {
                Id: "0OE1",
                Name: "DR_Step",
                Type: "DataRaptorExtractAction",
                PropertySet: JSON.stringify({ dataTransformName: "DR_CustomerInfo" }),
                OmniProcessId: "0OP1",
              },
              {
                Id: "0OE2",
                Name: "UI_Step",
                Type: "OmniUiCard",
                PropertySet: JSON.stringify({ cardName: "CustomerSummary" }),
                OmniProcessId: "0OP1",
              },
            ],
            done: true,
          };
        }
        return { records: [], done: true };
      },
    };
    const members = await collect(iterOmnistudio(conn));
    const process = members.find((m) => m.ref.memberType === "OmniProcess");
    expect(process).toBeDefined();
    const parsed = JSON.parse(process!.content) as {
      elements?: Array<{
        Type: string;
        propertySet: { cardName?: string; dataTransformName?: string };
      }>;
    };
    expect(parsed.elements).toHaveLength(2);
    expect(parsed.elements?.[0]?.Type).toBe("DataRaptorExtractAction");
    expect(parsed.elements?.[0]?.propertySet?.dataTransformName).toBe("DR_CustomerInfo");
    expect(parsed.elements?.[1]?.propertySet?.cardName).toBe("CustomerSummary");
  });

  it("emits parent-only payloads for types without fetchElements (OmniDataTransform / OmniUiCard)", async () => {
    const conn = {
      query: async (soql: string) => {
        if (soql.includes("FROM OmniDataTransform")) {
          return {
            records: [{ Id: "0DT1", Name: "Transform1" }],
            done: true,
          };
        }
        if (soql.includes("FROM OmniProcessElement")) {
          // Even if elements were returned for a non-fetchElements type,
          // they should not leak onto the wrong parent.
          return { records: [], done: true };
        }
        return { records: [], done: true };
      },
    };
    const members = await collect(iterOmnistudio(conn));
    const dt = members.find((m) => m.ref.memberType === "OmniDataTransform");
    expect(dt).toBeDefined();
    const parsed = JSON.parse(dt!.content) as { elements?: unknown };
    expect(parsed.elements).toBeUndefined();
  });

  it("attaches OmniDataTransformItem rows under metadata.items for OmniDataTransform", async () => {
    const conn = {
      query: async (soql: string) => {
        if (soql.includes("FROM OmniDataTransformItem")) {
          return {
            records: [
              {
                Id: "0DI1",
                Name: "Transform1",
                InputObjectName: "Account",
                InputFieldName: "Name",
                OutputObjectName: "json",
                OutputFieldName: "Details:Name",
                OmniDataTransformationId: "0DT1",
              },
            ],
            done: true,
          };
        }
        if (soql.includes("FROM OmniDataTransform")) {
          return { records: [{ Id: "0DT1", Name: "Transform1" }], done: true };
        }
        return { records: [], done: true };
      },
    };
    const members = await collect(iterOmnistudio(conn));
    const dt = members.find((m) => m.ref.memberType === "OmniDataTransform");
    expect(dt).toBeDefined();
    const parsed = JSON.parse(dt!.content) as {
      items?: Array<{ InputObjectName?: string; InputFieldName?: string }>;
    };
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items?.[0]?.InputObjectName).toBe("Account");
    expect(parsed.items?.[0]?.InputFieldName).toBe("Name");
  });

  it("skipTypes suppresses the SOQL pass for retrieve-covered types", async () => {
    const queried: string[] = [];
    const conn = {
      query: async (soql: string) => {
        queried.push(soql);
        return { records: [], done: true };
      },
    };
    await collect(
      iterOmnistudio(conn, { skipTypes: new Set(["OmniDataTransform", "OmniUiCard"]) }),
    );
    expect(queried.some((s) => s.includes("FROM OmniProcess"))).toBe(true);
    expect(queried.some((s) => s.includes("FROM OmniDataTransform"))).toBe(false);
    expect(queried.some((s) => s.includes("FROM OmniUiCard"))).toBe(false);
  });
});

describe("vlocity runner — content blob + element children", () => {
  const caps: OrgCapabilities = {
    detectedNamespaces: ["vlocity_cmt"],
    vlocityNamespaces: ["vlocity_cmt"],
    vlocityLegacy: true,
    vlocityCmt: true,
    omnistudioOncore: false,
    agentforce: false,
    experienceCloud: false,
    sourceTracking: false,
  };

  it(
    "strips namespace prefix from row keys and parses PropertySet JSON for OmniScript",
    { timeout: 15_000 },
    async () => {
      const conn = {
        query: async (soql: string) => {
          if (soql.includes("__OmniScript__c") && !soql.includes("__Element__c")) {
            return {
              records: [
                {
                  Id: "a0O1",
                  vlocity_cmt__Type__c: "Account",
                  vlocity_cmt__SubType__c: "Summary",
                  vlocity_cmt__Language__c: "English",
                  vlocity_cmt__PropertySet__c: JSON.stringify({ persistentComponent: true }),
                },
              ],
              done: true,
            };
          }
          if (soql.includes("__Element__c")) {
            return {
              records: [
                {
                  Id: "a0E1",
                  Name: "DR_Step",
                  vlocity_cmt__Type__c: "DataRaptorExtractAction",
                  vlocity_cmt__PropertySet__c: JSON.stringify({
                    dataRaptorBundleName: "DR_AccountInfo",
                  }),
                  vlocity_cmt__OmniScriptId__c: "a0O1",
                },
              ],
              done: true,
            };
          }
          return { records: [], done: true };
        },
      };
      const members = await collect(iterVlocityRecords(conn, caps, "00DTestVloc"));
      const os = members.find((m) => m.ref.memberType === "OmniScript");
      expect(os).toBeDefined();
      const parsed = JSON.parse(os!.content) as {
        Type?: string;
        SubType?: string;
        PropertySet?: { persistentComponent?: boolean };
        propertySet?: { persistentComponent?: boolean };
        elements?: Array<{ Type: string; PropertySet: { dataRaptorBundleName?: string } }>;
      };
      expect(parsed.Type).toBe("Account");
      expect(parsed.SubType).toBe("Summary");
      expect(parsed.propertySet?.persistentComponent).toBe(true);
      expect(parsed.elements).toHaveLength(1);
      expect(parsed.elements?.[0]?.Type).toBe("DataRaptorExtractAction");
      expect(parsed.elements?.[0]?.PropertySet?.dataRaptorBundleName).toBe("DR_AccountInfo");
    },
  );

  it(
    "fetches DRMapItem__c children for DataRaptor and attaches as elements with real mapping columns",
    { timeout: 15_000 },
    async () => {
      let drMapItemSoql = "";
      const conn = {
        query: async (soql: string) => {
          if (soql.includes("__DRBundle__c")) {
            return {
              records: [{ Id: "a0D1", Name: "DR_Test" }],
              done: true,
            };
          }
          if (soql.includes("__DRMapItem__c")) {
            drMapItemSoql = soql;
            // Real DRMapItem field shape (Interface/Domain sides), NOT the
            // non-existent Input/OutputFieldName columns the query used to ask
            // for. DRMapItem correlates to its DRBundle by Name (no DRBundleId
            // field exists), so the child's Name carries the bundle name.
            return {
              records: [
                {
                  Id: "a0M1",
                  Name: "DR_Test",
                  vlocity_cmt__InterfaceObjectName__c: "Account",
                  vlocity_cmt__InterfaceFieldAPIName__c: "Name",
                  vlocity_cmt__DomainObjectAPIName__c: "json",
                  vlocity_cmt__DomainObjectFieldAPIName__c: "Details:FullName",
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
      // The query must ask for the real mapping columns and correlate by Name,
      // never the non-existent Input/OutputFieldName or DRBundleId columns.
      expect(drMapItemSoql).toContain("DomainObjectFieldAPIName__c");
      expect(drMapItemSoql).toContain("InterfaceFieldAPIName__c");
      expect(drMapItemSoql).toContain("WHERE Name IN");
      expect(drMapItemSoql).not.toContain("InputFieldName__c");
      expect(drMapItemSoql).not.toContain("DRBundleId__c");
      // Children attach under `elements` (what DataRaptorParser reads) with the
      // namespace/suffix stripped by normaliseRow.
      const parsed = JSON.parse(dr!.content) as {
        elements?: Array<{ InterfaceObjectName?: string; DomainObjectFieldAPIName?: string }>;
      };
      expect(parsed.elements).toHaveLength(1);
      expect(parsed.elements?.[0]?.InterfaceObjectName).toBe("Account");
      expect(parsed.elements?.[0]?.DomainObjectFieldAPIName).toBe("Details:FullName");
    },
  );

  it(
    "selects extra long-text blobs that the vendored YAML omits (VlocityCard Definition)",
    { timeout: 15_000 },
    async () => {
      const queries: string[] = [];
      const conn = {
        query: async (soql: string) => {
          queries.push(soql);
          if (soql.includes("__VlocityCard__c")) {
            return {
              records: [
                {
                  Id: "a0V1",
                  Name: "MyCard",
                  vlocity_cmt__Definition__c: JSON.stringify({ states: ["Active"] }),
                  vlocity_cmt__Active__c: true,
                },
              ],
              done: true,
            };
          }
          return { records: [], done: true };
        },
      };
      const members = await collect(iterVlocityRecords(conn, caps, "00DTestVloc"));
      // Verify the SOQL was enriched with the Definition__c column.
      const cardSoql = queries.find((q) => q.includes("__VlocityCard__c"));
      expect(cardSoql).toContain("vlocity_cmt__Definition__c");
      const card = members.find((m) => m.ref.memberType === "VlocityCard");
      expect(card).toBeDefined();
      const parsed = JSON.parse(card!.content) as {
        Definition?: { states?: string[] };
      };
      expect(parsed.Definition?.states).toEqual(["Active"]);
    },
  );
});

void asOrgId;
