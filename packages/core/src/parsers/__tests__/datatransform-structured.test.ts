import { describe, expect, it } from "vitest";
import type { ParseContext } from "../contract.js";
import { OmniDataTransformParser } from "../omnistudio/data-transform.js";
import { DataRaptorParser } from "../vlocity/data-raptor.js";

/**
 * Structured field-mapping extraction tests covering the directions the
 * golden fixtures don't: Load (write) DataRaptors, lookup reads, and the
 * Metadata-API XML shape the OmniStudio retrieve path yields. Synthetic
 * inputs, shaped after the real DRMapItem / OmniDataTransformItem rows.
 */
const ctx: ParseContext = {
  orgId: "00Dtest",
  sourceUri: "test://fixture",
  parseTimestamp: "2026-01-01T00:00:00.000Z",
  namespace: "vlocity_cmt",
  logger: { debug() {}, info() {}, warn() {}, error() {} } as ParseContext["logger"],
};

function edgeSet(edges: Array<{ relType: string; dstQualifiedName: unknown }>): string[] {
  return edges.map((e) => `${e.relType}->${e.dstQualifiedName}`).sort();
}

describe("DataRaptorParser structured mappings", () => {
  it("Load map emits DR_WRITES_FIELD on the Domain (SObject) side only", async () => {
    const result = await new DataRaptorParser().parse(
      {
        name: "ContactUpsert",
        datapack: {
          Type: "Load",
          elements: [
            {
              DomainObjectAPIName: "Contact",
              DomainObjectFieldAPIName: "Email",
              InterfaceObjectName: "json",
              InterfaceFieldAPIName: "Step1:Email",
            },
            {
              DomainObjectAPIName: "Contact",
              DomainObjectFieldAPIName: "LastName",
              InterfaceObjectName: "json",
              InterfaceFieldAPIName: "Step1:LastName",
            },
          ],
        },
      },
      ctx,
    );
    expect(edgeSet(result.edges)).toEqual([
      "DR_WRITES_FIELD->CustomField:Contact.Email",
      "DR_WRITES_FIELD->CustomField:Contact.LastName",
      "REFERENCES_OBJECT->CustomObject:Contact",
    ]);
  });

  it("Formula expressions still surface Object.Field reads via regex", async () => {
    const result = await new DataRaptorParser().parse(
      {
        name: "FormulaDR",
        datapack: {
          Type: "Extract",
          elements: [
            {
              DomainObjectAPIName: "json",
              DomainObjectFieldAPIName: "Out:Total",
              Formula: "Account.AnnualRevenue * 0.1",
            },
          ],
        },
      },
      ctx,
    );
    expect(edgeSet(result.edges)).toContain("DR_READS_FIELD->CustomField:Account.AnnualRevenue");
  });

  it("JSON-to-JSON maps emit no field edges (no false positives)", async () => {
    const result = await new DataRaptorParser().parse(
      {
        name: "JsonOnly",
        datapack: {
          Type: "Transform",
          elements: [
            {
              DomainObjectAPIName: "json",
              DomainObjectFieldAPIName: "Out:Name",
              InterfaceObjectName: "json",
              InterfaceFieldAPIName: "In:Name",
            },
          ],
          SampleInputJSON: '{"Account.Name":"decoy"}',
        },
      },
      ctx,
    );
    expect(result.edges.filter((e) => e.relType !== "DR_TRANSFORMS")).toEqual([]);
  });
});

describe("OmniDataTransformParser structured mappings", () => {
  it("SOQL-shaped items emit reads, writes, and lookup reads", async () => {
    const result = await new OmniDataTransformParser().parse(
      {
        name: "AccountSync",
        metadata: {
          Type: "Load",
          items: [
            {
              InputObjectName: "",
              InputFieldName: "Payload:AccountName",
              OutputObjectName: "Account",
              OutputFieldName: "Name",
            },
            {
              InputObjectName: "Travel_Request__c",
              InputFieldName: "Status__c",
              OutputObjectName: "json",
              OutputFieldName: "status",
            },
            {
              LookupObjectName: "Account",
              LookupByFieldName: "AccountNumber",
              OutputObjectName: "Account",
              OutputFieldName: "ParentId",
            },
          ],
        },
      },
      ctx,
    );
    expect(edgeSet(result.edges)).toEqual([
      "DR_READS_FIELD->CustomField:Account.AccountNumber",
      "DR_READS_FIELD->CustomField:Travel_Request__c.Status__c",
      "DR_WRITES_FIELD->CustomField:Account.Name",
      "DR_WRITES_FIELD->CustomField:Account.ParentId",
      "REFERENCES_OBJECT->CustomObject:Account",
      "REFERENCES_OBJECT->CustomObject:Travel_Request__c",
    ]);
  });

  it("Metadata-API retrieve XML (lowerCamel keys) parses identically", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OmniDataTransform xmlns="http://soap.sforce.com/2006/04/metadata">
  <name>extractContact</name>
  <type>Extract</type>
  <sourceObject>Contact</sourceObject>
  <omniDataTransformItem>
    <inputObjectName>Contact</inputObjectName>
    <inputFieldName>Email</inputFieldName>
    <outputObjectName>json</outputObjectName>
    <outputFieldName>Details:Email</outputFieldName>
  </omniDataTransformItem>
  <omniDataTransformItem>
    <inputObjectName>Contact</inputObjectName>
    <inputFieldName>LastName</inputFieldName>
    <outputObjectName>json</outputObjectName>
    <outputFieldName>Details:LastName</outputFieldName>
  </omniDataTransformItem>
</OmniDataTransform>`;
    const result = await new OmniDataTransformParser().parse(
      { name: "extractContact", metadata: xml },
      ctx,
    );
    expect(edgeSet(result.edges)).toEqual([
      "DR_READS_FIELD->CustomField:Contact.Email",
      "DR_READS_FIELD->CustomField:Contact.LastName",
      "REFERENCES_OBJECT->CustomObject:Contact",
    ]);
  });
});
