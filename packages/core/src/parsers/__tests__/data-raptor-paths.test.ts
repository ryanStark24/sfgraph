import { describe, expect, it } from "vitest";
import type { ParseContext } from "../contract.js";
import { DataRaptorParser } from "../vlocity/data-raptor.js";

/**
 * DataRaptor field-target resolution: Extract step aliases, the
 * `%vlocity_namespace%__` token, relationship paths and formula
 * pseudo-targets. Synthetic rows shaped after real DRMapItem packs
 * (keys already normalised by the DataPack extractor).
 */
const ctx: ParseContext = {
  orgId: "00Dtest",
  sourceUri: "test://fixture",
  parseTimestamp: "2026-01-01T00:00:00.000Z",
  namespace: null,
  logger: { debug() {}, info() {}, warn() {}, error() {} } as ParseContext["logger"],
};

async function parse(type: string, elements: unknown[]) {
  return new DataRaptorParser().parse({ name: "Sample", datapack: { Type: type, elements } }, ctx);
}

function fieldEdges(edges: Array<{ relType: string; dstQualifiedName: unknown }>): string[] {
  return edges
    .filter((e) => e.relType.endsWith("_FIELD"))
    .map((e) => `${e.relType}->${e.dstQualifiedName}`)
    .sort();
}

// Extract step row: the real object for alias `W` (filter on Widget__c.Id).
const step = (obj: string, alias: string, filterField = "Id", order = 1) => ({
  InterfaceObjectName: obj,
  InterfaceFieldAPIName: filterField,
  InterfaceObjectLookupOrder: order,
  DomainObjectAPIName: "json",
  DomainObjectFieldAPIName: alias,
});
// Extract output row: `Alias:Path` on the interface side, JSON on the domain side.
const out = (path: string, outKey = "Out:X") => ({
  InterfaceFieldAPIName: path,
  DomainObjectAPIName: "json",
  DomainObjectFieldAPIName: outKey,
});

describe("DataRaptorParser Extract alias resolution", () => {
  it("resolves Alias:Field rows through the step row's InterfaceObjectName", async () => {
    const r = await parse("Extract", [step("Widget__c", "W"), out("W:Size__c"), out("W:Name")]);
    expect(fieldEdges(r.edges)).toEqual([
      "DR_READS_FIELD->CustomField:Widget__c.Id",
      "DR_READS_FIELD->CustomField:Widget__c.Name",
      "DR_READS_FIELD->CustomField:Widget__c.Size__c",
    ]);
  });

  it("resolves nested aliases (Parent:Child:Field) on the full alias path", async () => {
    const r = await parse("Extract", [
      step("Widget__c", "W"),
      step("Gadget__c", "W:Kid", "Widget__c", 2),
      out("W:Kid:Colour__c"),
    ]);
    expect(fieldEdges(r.edges)).toContain("DR_READS_FIELD->CustomField:Gadget__c.Colour__c");
    expect(fieldEdges(r.edges)).not.toContain("DR_READS_FIELD->CustomField:Widget__c.Colour__c");
  });

  it("emits nothing for an unknown alias", async () => {
    const r = await parse("Extract", [out("Nope:Size__c")]);
    expect(fieldEdges(r.edges)).toEqual([]);
  });

  it("strips the %vlocity_namespace%__ token from object and field values", async () => {
    const r = await parse("Extract", [
      step("%vlocity_namespace%__Gizmo__c", "G", "%vlocity_namespace%__ParentId__c"),
      out("G:%vlocity_namespace%__Weight__c"),
      out("G:Local__c"),
    ]);
    expect(fieldEdges(r.edges)).toEqual([
      "DR_READS_FIELD->CustomField:Gizmo__c.Local__c",
      "DR_READS_FIELD->CustomField:Gizmo__c.ParentId__c",
      "DR_READS_FIELD->CustomField:Gizmo__c.Weight__c",
    ]);
  });

  it("keeps real namespaces that the extractor substituted in", async () => {
    const r = await parse("Extract", [step("pkg__Gizmo__c", "G"), out("G:pkg__Weight__c")]);
    expect(fieldEdges(r.edges)).toContain(
      "DR_READS_FIELD->CustomField:pkg__Gizmo__c.pkg__Weight__c",
    );
  });
});

describe("DataRaptorParser relationship paths", () => {
  it("records X__r.F paths for the graph resolver and emits no guessed target", async () => {
    const r = await parse("Extract", [
      step("Widget__c", "W"),
      out("W:Maker__r.Region__c"),
      out("W:Account.Name"),
    ]);
    const edges = fieldEdges(r.edges);
    expect(edges).toEqual(["DR_READS_FIELD->CustomField:Widget__c.Id"]);
    const paths = r.nodes[0]?.attributes.drRelationshipPaths;
    expect(paths).toEqual([
      { object: "Widget__c", path: "Maker__r.Region__c", rel: "DR_READS_FIELD" },
      { object: "Widget__c", path: "Account.Name", rel: "DR_READS_FIELD" },
    ]);
  });

  it("records relationship paths on Turbo Extract rows (object on the same row)", async () => {
    const r = await parse("Turbo Extract", [
      {
        InterfaceObjectName: "Widget__c",
        InterfaceFieldAPIName: "Maker__r.Name",
        DomainObjectAPIName: "Turbo Extract",
        DomainObjectFieldAPIName: "widget",
      },
    ]);
    expect(r.nodes[0]?.attributes.drRelationshipPaths).toEqual([
      { object: "Widget__c", path: "Maker__r.Name", rel: "DR_READS_FIELD" },
    ]);
    expect(fieldEdges(r.edges)).toEqual([]);
  });
});

describe("DataRaptorParser formula and pseudo targets", () => {
  it("drops Formula.Formula and same-name pseudo pairs", async () => {
    const r = await parse("Transform", [
      { DomainObjectAPIName: "Formula", DomainObjectFieldAPIName: "Formula", Formula: "1 + 1" },
      { DomainObjectAPIName: "Settings", DomainObjectFieldAPIName: "Settings" },
    ]);
    expect(fieldEdges(r.edges)).toEqual([]);
  });

  it("resolves Alias:Field formula tokens and ignores $Vlocity / JSON-path tokens", async () => {
    const r = await parse("Extract", [
      step("Widget__c", "W"),
      {
        DomainObjectAPIName: "Formula",
        DomainObjectFieldAPIName: "Formula",
        Formula:
          "IF(W:Size__c != $Vlocity.NULL, W:Size__c, Out:Item_List.Value__c) && Some_Json.Path__c",
      },
    ]);
    expect(fieldEdges(r.edges)).toEqual([
      "DR_READS_FIELD->CustomField:Widget__c.Id",
      "DR_READS_FIELD->CustomField:Widget__c.Size__c",
    ]);
  });

  it("keeps Object.Field formula reads on known SObjects", async () => {
    const r = await parse("Transform", [
      {
        DomainObjectAPIName: "Formula",
        DomainObjectFieldAPIName: "Formula",
        Formula: "Account.Rating + Gadget__c.Score__c",
      },
    ]);
    expect(fieldEdges(r.edges)).toEqual([
      "DR_READS_FIELD->CustomField:Account.Rating",
      "DR_READS_FIELD->CustomField:Gadget__c.Score__c",
    ]);
  });
});

describe("DataRaptorParser alias edge cases and disabled rows", () => {
  it("emits nothing for an alias mapped to two different objects", async () => {
    const r = await parse("Extract", [
      step("Widget__c", "W"),
      step("Gadget__c", "W", "Id", 2),
      out("W:Size__c"),
    ]);
    expect(fieldEdges(r.edges).filter((e) => e.includes("Size__c"))).toEqual([]);
  });

  it("falls back to a unique case-insensitive alias match", async () => {
    const r = await parse("Extract", [step("Widget__c", "Wid"), out("WID:Size__c")]);
    expect(fieldEdges(r.edges)).toContain("DR_READS_FIELD->CustomField:Widget__c.Size__c");
  });

  it("skips IsDisabled mapping rows (no reads, writes or alias)", async () => {
    const r = await parse("Extract", [
      { ...step("Widget__c", "W"), IsDisabled: true },
      out("W:Size__c"),
      { ...step("Gadget__c", "G"), IsDisabled: false },
      { ...out("G:Colour__c"), IsDisabled: true },
      out("G:Score__c"),
    ]);
    expect(fieldEdges(r.edges)).toEqual([
      "DR_READS_FIELD->CustomField:Gadget__c.Id",
      "DR_READS_FIELD->CustomField:Gadget__c.Score__c",
    ]);
    const load = await parse("Load", [
      {
        InterfaceFieldAPIName: "In:Size",
        DomainObjectAPIName: "Widget__c",
        DomainObjectFieldAPIName: "Size__c",
        IsDisabled: true,
      },
    ]);
    expect(fieldEdges(load.edges)).toEqual([]);
  });
});
