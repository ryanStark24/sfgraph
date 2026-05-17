import { describe, expect, it } from "vitest";
import { CustomObjectParser } from "../object/index.js";
import { makeTestCtx } from "./_harness.js";

const PARSER = new CustomObjectParser();

const ACCOUNT_OBJECT_HEADER = `<?xml version="1.0"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
  <fullName>Account</fullName>
  <label>Account</label>`;

describe("W2-04: MCD gap-fill edges via the object parser", () => {
  it("emits USES_GLOBAL_VALUE_SET when a picklist field references a GlobalValueSet", async () => {
    const xml = `${ACCOUNT_OBJECT_HEADER}
      <fields>
        <fullName>Industry__c</fullName>
        <type>Picklist</type>
        <valueSet>
          <valueSetName>IndustryGlobalValues</valueSetName>
        </valueSet>
      </fields>
    </CustomObject>`;
    const result = await PARSER.parse({ apiName: "Account", objectXml: xml }, makeTestCtx());
    const gvs = result.edges.find((e) => e.relType === "USES_GLOBAL_VALUE_SET");
    expect(gvs).toBeDefined();
    expect(String(gvs?.srcQualifiedName)).toBe("CustomField:Account.Industry__c");
    expect(String(gvs?.dstQualifiedName)).toBe("GlobalValueSet:IndustryGlobalValues");
    expect(gvs?.attributes.fieldType).toBe("Picklist");
  });

  it("emits DEPENDS_ON_FIELD when a dependent picklist references its controlling field", async () => {
    const xml = `${ACCOUNT_OBJECT_HEADER}
      <fields>
        <fullName>SubIndustry__c</fullName>
        <type>Picklist</type>
        <valueSet>
          <controllingField>Industry__c</controllingField>
          <valueSettings>
            <controllingFieldValue>Tech</controllingFieldValue>
            <valueName>SaaS</valueName>
          </valueSettings>
        </valueSet>
      </fields>
    </CustomObject>`;
    const result = await PARSER.parse({ apiName: "Account", objectXml: xml }, makeTestCtx());
    const dep = result.edges.find((e) => e.relType === "DEPENDS_ON_FIELD");
    expect(dep).toBeDefined();
    expect(String(dep?.srcQualifiedName)).toBe("CustomField:Account.SubIndustry__c");
    expect(String(dep?.dstQualifiedName)).toBe("CustomField:Account.Industry__c");
    expect(dep?.attributes.reason).toBe("dependent-picklist");
  });

  it("emits neither edge when the field has no valueSet structure", async () => {
    const xml = `${ACCOUNT_OBJECT_HEADER}
      <fields>
        <fullName>Phone</fullName>
        <type>Phone</type>
      </fields>
    </CustomObject>`;
    const result = await PARSER.parse({ apiName: "Account", objectXml: xml }, makeTestCtx());
    expect(result.edges.find((e) => e.relType === "USES_GLOBAL_VALUE_SET")).toBeUndefined();
    expect(result.edges.find((e) => e.relType === "DEPENDS_ON_FIELD")).toBeUndefined();
  });

  it("handles BOTH gap-fills on the same field (rare but valid)", async () => {
    const xml = `${ACCOUNT_OBJECT_HEADER}
      <fields>
        <fullName>Region__c</fullName>
        <type>Picklist</type>
        <valueSet>
          <valueSetName>RegionGVS</valueSetName>
          <controllingField>Country__c</controllingField>
        </valueSet>
      </fields>
    </CustomObject>`;
    const result = await PARSER.parse({ apiName: "Account", objectXml: xml }, makeTestCtx());
    expect(result.edges.some((e) => e.relType === "USES_GLOBAL_VALUE_SET")).toBe(true);
    expect(result.edges.some((e) => e.relType === "DEPENDS_ON_FIELD")).toBe(true);
  });
});
