import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../parsers/__tests__/_harness.js";
import { parserRegistry } from "../../parsers/registry.js";
import { loadAllRules } from "../../parsers/rules/_loader.js";
import { buildEmbedText } from "../live-ingest.js";

describe("buildEmbedText — config values fold into the embedding", () => {
  it("baseline: label + qname (+ description)", () => {
    expect(buildEmbedText("ApexClass", "ApexClass:Foo", { description: "does X" })).toBe(
      "ApexClass: ApexClass:Foo\ndoes X",
    );
  });

  it("CMDT field values (array of {field,value}) become searchable lines", () => {
    const text = buildEmbedText(
      "CustomMetadataRecord",
      "CustomMetadataRecord:End_Point_Urls.ProductPush",
      {
        values: [
          { field: "Endpoint__c", value: "https://api.example.com/cbs/product" },
          { field: "Order_Type__c", value: "Create" },
        ],
      },
    );
    expect(text).toContain("Endpoint__c = https://api.example.com/cbs/product");
    expect(text).toContain("Order_Type__c = Create");
  });

  it("CMDT values as a plain object also fold in", () => {
    const text = buildEmbedText("CustomMetadataRecord", "CustomMetadataRecord:X.Y", {
      values: { MatchingKeyFields__c: "GlobalKey__c", MatchingKeyObject__c: "Order__c" },
    });
    expect(text).toContain("MatchingKeyFields__c = GlobalKey__c");
  });

  it("Custom Label value folds in", () => {
    const text = buildEmbedText("CustomLabel", "CustomLabel:RecordTypeId", {
      value: "0122x000000QDjEAAW",
    });
    expect(text).toContain("0122x000000QDjEAAW");
  });

  it("Custom Setting rows fold in", () => {
    const text = buildEmbedText("CustomObject", "CustomObject:In_App_Checklist_Settings__c", {
      customSettingRows: [{ Name: "default", Page_URL__c: "/lightning/checklist" }],
    });
    expect(text).toContain("Page_URL__c=/lightning/checklist");
  });

  it("no config attrs → just the baseline (no crash on missing fields)", () => {
    expect(buildEmbedText("Flow", "Flow:MyFlow", undefined)).toBe("Flow: Flow:MyFlow");
  });

  it("folds a trigger's object + events so it's findable by what it acts on", () => {
    const text = buildEmbedText("ApexTrigger", "ApexTrigger:AccountTrigger", {
      object: "Account",
      events: ["before insert", "after update"],
    });
    expect(text).toContain("on Account before insert after update");
  });

  it("does NOT leak 'on <object>' onto a CustomField (only triggers act 'on' an object)", () => {
    const text = buildEmbedText("CustomField", "CustomField:Account.Tier__c", {
      object: "Account",
    });
    expect(text).not.toContain("on Account");
  });

  it("folds a Flow's process type", () => {
    const text = buildEmbedText("Flow", "Flow:MyFlow", { processType: "AutoLaunchedFlow" });
    expect(text).toContain("AutoLaunchedFlow");
  });
});

describe("CustomMetadata rule captures record values", () => {
  it("emits a CustomMetadataRecord node with the values array on attributes", async () => {
    await loadAllRules();
    const parser = parserRegistry.for("CustomMetadata");
    expect(parser).toBeDefined();
    // Mirrors the live-ingest shape: genericRuleInput promotes metadata.read's
    // keys (name, values, label) as siblings of an empty xml.
    const result = await parser!.parse(
      {
        xml: "",
        name: "End_Point_Urls.ProductPush_PLDT",
        label: "Product Push",
        values: [{ field: "Endpoint__c", value: "https://api.example.com/cbs/product" }],
      } as never,
      makeTestCtx(),
    );
    const rec = result.nodes.find((n) => n.label === "CustomMetadataRecord");
    expect(rec).toBeDefined();
    const vals = (rec!.attributes as { values?: Array<{ field?: string; value?: string }> }).values;
    expect(Array.isArray(vals)).toBe(true);
    expect(vals?.[0]?.field).toBe("Endpoint__c");
    expect(vals?.[0]?.value).toBe("https://api.example.com/cbs/product");
    // And the embed text built from that node surfaces the value.
    expect(buildEmbedText(rec!.label, String(rec!.qualifiedName), rec!.attributes)).toContain(
      "https://api.example.com/cbs/product",
    );
  });
});
