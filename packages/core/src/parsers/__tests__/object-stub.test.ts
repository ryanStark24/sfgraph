import { createHash } from "node:crypto";
import { asOrgId, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import type { ParseContext } from "../contract.js";
import { CustomObjectParser } from "../object/index.js";
import { DataRaptorParser } from "../vlocity/data-raptor.js";

const ctx: ParseContext = {
  orgId: "00Dxx0000000ABCEAA",
  sourceUri: "test://fixture",
  parseTimestamp: "2026-01-01T00:00:00.000Z",
  namespace: null,
  logger: { debug() {}, info() {}, warn() {}, error() {} } as ParseContext["logger"],
};

const FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
  <fullName>Size__c</fullName>
  <type>Text</type>
</CustomField>`;

describe("CustomObjectParser stub objects (fields-only folder)", () => {
  it("emits a stub CustomObject, its CustomField nodes and DEFINES_FIELD", async () => {
    const r = await new CustomObjectParser().parse(
      { apiName: "pkg__Widget__c", objectXml: "", stub: true, fields: { Size__c: FIELD_XML } },
      ctx,
    );
    const obj = r.nodes.find((n) => n.qualifiedName === "CustomObject:pkg__Widget__c");
    expect(obj?.label).toBe("CustomObject");
    expect(obj?.attributes.stub).toBe(true);
    const field = r.nodes.find((n) => n.qualifiedName === "CustomField:pkg__Widget__c.Size__c");
    expect(field?.label).toBe("CustomField");
    expect(
      r.edges.map((e) => `${e.srcQualifiedName}|${e.relType}|${e.dstQualifiedName}`),
    ).toContain("CustomObject:pkg__Widget__c|DEFINES_FIELD|CustomField:pkg__Widget__c.Size__c");
  });

  it("carries referenceTo / relationshipName on source-file lookup fields", async () => {
    const lookup = `<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
  <fullName>Maker__c</fullName>
  <type>Lookup</type>
  <referenceTo>Maker__c</referenceTo>
  <relationshipName>Makers</relationshipName>
</CustomField>`;
    const r = await new CustomObjectParser().parse(
      {
        apiName: "Widget__c",
        objectXml: "",
        stub: true,
        fields: { Maker__c: lookup, Size__c: FIELD_XML },
      },
      ctx,
    );
    const f = r.nodes.find((n) => n.qualifiedName === "CustomField:Widget__c.Maker__c");
    expect(f?.attributes.referenceTo).toEqual(["Maker__c"]);
    expect(f?.attributes.relationshipName).toBe("Makers");
    const plain = r.nodes.find((n) => n.qualifiedName === "CustomField:Widget__c.Size__c");
    expect(plain?.attributes.referenceTo).toBeUndefined();
  });

  it("does not mark objects with an object-meta.xml as stubs", async () => {
    const r = await new CustomObjectParser().parse(
      { apiName: "Gadget__c", objectXml: "<CustomObject><label>G</label></CustomObject>" },
      ctx,
    );
    const obj = r.nodes.find((n) => n.qualifiedName === "CustomObject:Gadget__c");
    expect(obj?.attributes.stub).toBeUndefined();
  });
});

// Graphs ingested before referenceTo / drRelationshipPaths existed stored
// these nodes with a hash of the unchanged source. A plain re-ingest must
// still refresh their attributes (the merge only rewrites on a hash change).
describe("parser-version salt on attribute-bearing node hashes", () => {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  async function store() {
    const s = new SqliteGraphStore({ dbPath: ":memory:" });
    await s.init();
    s.upsertOrg({
      id: asOrgId(ctx.orgId),
      alias: "t",
      instanceUrl: "https://example.test",
      apiVersion: "59.0",
      createdAt: 1,
    });
    return s;
  }

  it("re-merges an unchanged lookup field so referenceTo appears", async () => {
    const lookup =
      "<CustomField><fullName>Maker__c</fullName><type>Lookup</type><referenceTo>Maker__c</referenceTo><relationshipName>Maker</relationshipName></CustomField>";
    const r = await new CustomObjectParser().parse(
      { apiName: "Widget__c", objectXml: "", stub: true, fields: { Maker__c: lookup } },
      ctx,
    );
    const fresh = r.nodes.find((n) => n.qualifiedName === "CustomField:Widget__c.Maker__c");
    if (!fresh) throw new Error("no field node");
    const s = await store();
    const { referenceTo: _r, relationshipName: _n, ...oldAttrs } = fresh.attributes;
    s.mergeNodes([{ ...fresh, attributes: oldAttrs, sourceHash: asSha256(sha(lookup)) }]);
    s.mergeNodes([fresh]);
    expect(s.getNode(fresh.orgId, fresh.qualifiedName)?.attributes.referenceTo).toEqual([
      "Maker__c",
    ]);
  });

  it("re-merges an unchanged DataRaptor so drRelationshipPaths appears", async () => {
    const datapack = {
      Type: "Extract",
      elements: [
        {
          InterfaceObjectName: "Widget__c",
          InterfaceFieldAPIName: "Maker__r.Region__c",
          DomainObjectAPIName: "json",
          DomainObjectFieldAPIName: "R",
        },
      ],
    };
    const r = await new DataRaptorParser().parse({ name: "Sample", datapack }, ctx);
    const fresh = r.nodes[0];
    if (!fresh) throw new Error("no DR node");
    const s = await store();
    const { drRelationshipPaths: _p, ...oldAttrs } = fresh.attributes;
    s.mergeNodes([
      { ...fresh, attributes: oldAttrs, sourceHash: asSha256(sha(JSON.stringify(datapack))) },
    ]);
    s.mergeNodes([fresh]);
    expect(
      s.getNode(fresh.orgId, fresh.qualifiedName)?.attributes.drRelationshipPaths,
    ).toHaveLength(1);
  });
});
