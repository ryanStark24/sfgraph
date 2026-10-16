import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adaptParserInput } from "../../../ingest/live-ingest.js";
import type { ParseContext } from "../../../parsers/contract.js";
import { parserRegistry } from "../../../parsers/index.js";
import { FilesystemMetadataSource } from "../index.js";
import { iterDataPacks } from "../vlocity-datapacks.js";

const NS = "%vlocity_namespace%__";
let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "sfg-dp-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const w = (rel: string, v: unknown) => {
  const a = path.join(root, rel);
  mkdirSync(path.dirname(a), { recursive: true });
  writeFileSync(a, typeof v === "string" ? v : JSON.stringify(v));
};
async function all(report = { skipped: [] as any[], types: {} as Record<string, number> }) {
  const out = [];
  for await (const m of iterDataPacks(root, report)) out.push(m);
  return { out, report };
}

const writeIp = () => {
  w("IntegrationProcedure/Shop_Checkout/Shop_Checkout_DataPack.json", {
    [`${NS}Type__c`]: "Shop",
    [`${NS}SubType__c`]: "Checkout",
    [`${NS}Language__c`]: "Procedure",
    [`${NS}Element__c`]: ["Shop_Checkout_Element_RA.json"],
    [`${NS}PropertySet__c`]: "Shop_Checkout_PropertySet.json",
    Name: "Checkout",
  });
  w("IntegrationProcedure/Shop_Checkout/Shop_Checkout_Element_RA.json", {
    [`${NS}Type__c`]: "Remote Action",
    [`${NS}PropertySet__c`]: { remoteClass: "CheckoutSvc", remoteMethod: "submit" },
    [`${NS}OmniScriptId__c`]: {
      VlocityDataPackType: "VlocityMatchingKeyObject",
      [`${NS}Type__c`]: "Shop",
    },
  });
  w("IntegrationProcedure/Shop_Checkout/Shop_Checkout_PropertySet.json", {
    trackingCustomData: {},
  });
};

describe("iterDataPacks", () => {
  it("IP: inlines elements and keys by Type_SubType", async () => {
    writeIp();
    const { out } = await all();
    expect(out).toHaveLength(1);
    expect(out[0]!.ref.memberType).toBe("IntegrationProcedure");
    expect(out[0]!.ref.memberName).toBe("Shop_Checkout");
    const c = JSON.parse(out[0]!.content);
    expect(c.elements[0].Type).toBe("Remote Action");
    expect(c.elements[0].propertySet.remoteClass).toBe("CheckoutSvc");
    expect(c.elements[0].OmniScriptId).toBeUndefined();
  });
  it("inlines orphan *_Element_*.json siblings not listed in the pack", async () => {
    writeIp();
    w("IntegrationProcedure/Shop_Checkout/Shop_Checkout_Element_Orphan.json", {
      [`${NS}Type__c`]: "Remote Action",
      [`${NS}PropertySet__c`]: { remoteClass: "OrphanSvc" },
    });
    w("IntegrationProcedure/Shop_Checkout/Shop_Checkout_Element_Bad.json", "{nope");
    const { out, report } = await all();
    const c = JSON.parse(out[0]!.content);
    expect(c.elements.map((e: any) => e.propertySet.remoteClass).sort()).toEqual([
      "CheckoutSvc",
      "OrphanSvc",
    ]);
    expect(report.skipped.some((s) => s.path.includes("Element_Bad"))).toBe(true);
  });
  it("OmniScript keyed by Type_SubType_Language", async () => {
    w("OmniScript/Plan_Select_English/Plan_Select_English_DataPack.json", {
      [`${NS}Type__c`]: "Plan",
      [`${NS}SubType__c`]: "Select",
      [`${NS}Language__c`]: "English",
      [`${NS}Element__c`]: [],
    });
    expect((await all()).out[0]!.ref.memberName).toBe("Plan_Select_English");
  });
  it("DataRaptor: DRMapItem file becomes elements; Card Definition inlined", async () => {
    w("DataRaptor/AMSX/AMSX_DataPack.json", {
      Name: "AMSX",
      [`${NS}Type__c`]: "Extract",
      [`${NS}DRMapItem__c`]: "AMSX_Mappings.json",
    });
    w("DataRaptor/AMSX/AMSX_Mappings.json", [
      { [`${NS}InterfaceObjectName__c`]: "OrderItem", [`${NS}InterfaceFieldAPIName__c`]: "Id" },
    ]);
    w("VlocityCard/Plan-Cards/Plan-Cards_DataPack.json", {
      Name: "Plan Cards",
      [`${NS}Definition__c`]: "Plan-Cards.json",
    });
    w("VlocityCard/Plan-Cards/Plan-Cards.json", { states: [] });
    const { out } = await all();
    const dr = JSON.parse(out.find((m) => m.ref.memberType === "DataRaptor")!.content);
    expect(dr.elements[0].InterfaceObjectName).toBe("OrderItem");
    const card = out.find((m) => m.ref.memberType === "VlocityCard")!;
    expect(card.ref.memberName).toBe("Plan Cards");
    expect(JSON.parse(card.content).Definition).toEqual({ states: [] });
  });
  it("malformed pack is skipped and reported; missing sibling keeps the string; EPC types skipped", async () => {
    w("DataRaptor/Bad/Bad_DataPack.json", "{not json");
    w("DataRaptor/Ok/Ok_DataPack.json", { Name: "Ok", [`${NS}DRMapItem__c`]: "Ok_Mappings.json" });
    w("Product2/P1/P1_DataPack.json", { Name: "P1" });
    const { out, report } = await all();
    expect(out.map((m) => m.ref.memberName)).toEqual(["Ok"]);
    expect(JSON.parse(out[0]!.content).DRMapItem).toBe("Ok_Mappings.json");
    expect(report.skipped.some((s) => s.path.includes("Bad"))).toBe(true);
    expect(report.types.Product2).toBeUndefined();
  });
  it("malformed sibling keeps the filename string and the pack is still yielded", async () => {
    w("DataRaptor/Ok/Ok_DataPack.json", { Name: "Ok", [`${NS}DRMapItem__c`]: "Ok_Mappings.json" });
    w("DataRaptor/Ok/Ok_Mappings.json", "[oops");
    const { out } = await all();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!.content).DRMapItem).toBe("Ok_Mappings.json");
  });
  it("falls back to the single *_DataPack.json; folder without one is skipped and reported", async () => {
    w("DataRaptor/Odd/Other_DataPack.json", { Name: "Odd" });
    w("DataRaptor/Empty/readme.txt", "x");
    const { out, report } = await all();
    expect(out.map((m) => m.ref.memberName)).toEqual(["Odd"]);
    expect(report.skipped.some((s) => s.path.includes("Empty"))).toBe(true);
    expect(report.types.DataRaptor).toBe(1);
  });
  it("FilesystemMetadataSource yields DataPacks from vlocity/datapacks and exposes the report", async () => {
    w("sfdx-project.json", { packageDirectories: [{ path: "force-app" }] });
    w("vlocity/datapacks/OmniScript/Plan_Select_English/Plan_Select_English_DataPack.json", {
      [`${NS}Type__c`]: "Plan",
      [`${NS}SubType__c`]: "Select",
      [`${NS}Language__c`]: "English",
    });
    const src = FilesystemMetadataSource.fromProjectRoot(root);
    const got = [];
    for await (const m of src.iter()) got.push(m);
    expect(got.map((m) => m.ref.memberName)).toEqual(["Plan_Select_English"]);
    expect(src.dataPackReport.types.OmniScript).toBe(1);
  });
  it("substitutes %vlocity_namespace% in DataRaptor mapping values with the source tree's package namespace", async () => {
    w("sfdx-project.json", { packageDirectories: [{ path: "force-app" }] });
    w(
      "force-app/main/default/objects/vlocity_ins__Thing__c/fields/Size__c.field-meta.xml",
      "<CustomField/>",
    );
    w("vlocity/datapacks/DataRaptor/Drx/Drx_DataPack.json", {
      Name: "Drx",
      [`${NS}Type__c`]: "Extract",
      [`${NS}DRMapItem__c`]: "Drx_Mappings.json",
    });
    w("vlocity/datapacks/DataRaptor/Drx/Drx_Mappings.json", [
      {
        [`${NS}InterfaceObjectName__c`]: `${NS}Thing__c`,
        [`${NS}InterfaceFieldAPIName__c`]: `T:${NS}Weight__c`,
      },
    ]);
    const src = FilesystemMetadataSource.fromProjectRoot(root);
    const got = [];
    for await (const m of src.iter()) got.push(m);
    const dr = JSON.parse(got.find((m) => m.ref.memberType === "DataRaptor")!.content);
    expect(dr.elements[0].InterfaceObjectName).toBe("vlocity_ins__Thing__c");
    expect(dr.elements[0].InterfaceFieldAPIName).toBe("T:vlocity_ins__Weight__c");
  });
  it("leaves the %vlocity_namespace% token for the parser when no package namespace is detected", async () => {
    w("DataRaptor/Drx/Drx_DataPack.json", {
      Name: "Drx",
      [`${NS}DRMapItem__c`]: "Drx_Mappings.json",
    });
    w("DataRaptor/Drx/Drx_Mappings.json", [{ [`${NS}InterfaceObjectName__c`]: `${NS}Thing__c` }]);
    const dr = JSON.parse((await all()).out[0]!.content);
    expect(dr.elements[0].InterfaceObjectName).toBe(`${NS}Thing__c`);
  });
});

describe("DataPack → dispatch → parser", () => {
  it("IP remote action yields IP_INVOKES_REMOTE to Remote:CheckoutSvc and no lookup-derived edge", async () => {
    writeIp();
    const { out } = await all();
    const ctx: ParseContext = {
      orgId: "00DTest",
      sourceUri: "test://dp",
      parseTimestamp: "2026-01-01T00:00:00.000Z",
      namespace: "vlocity_cmt",
      logger: { debug() {}, info() {}, warn() {}, error() {} } as ParseContext["logger"],
    };
    const adapted = adaptParserInput(out[0]!.ref as never, out[0]!.content);
    expect(adapted).not.toBeNull();
    const res = await parserRegistry.for(adapted!.type)!.parse(adapted!.input, ctx);
    const edges = res.edges as Array<{ relType: string; toId?: string; to?: string }>;
    const remote = edges.filter((e) => e.relType === "IP_INVOKES_REMOTE");
    expect(remote.length).toBeGreaterThan(0);
    expect(JSON.stringify(remote)).toContain("Remote:CheckoutSvc");
    expect(JSON.stringify(edges)).not.toMatch(/VlocityMatchingKeyObject/);
  });
});
