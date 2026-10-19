import { describe, expect, it } from "vitest";
import type { MemberRef } from "../../../extractors/interfaces/metadata-source.js";
import { adaptParserInput } from "../../../ingest/parse-member.js";
import { makeTestCtx } from "../../__tests__/_harness.js";
import "../../index.js";
import { AuraBundleParser } from "../bundle.js";

// audit corecorr-08 sub-points: controller, embeds (Aura vs LWC), labels.
const edges = async (files: Record<string, string>, bundleName = "Shell") => {
  const r = await new AuraBundleParser().parse({ bundleName, files }, makeTestCtx());
  return {
    node: r.nodes[0],
    keys: r.edges.map((e) => `${e.relType}|${String(e.dstQualifiedName)}`).sort(),
  };
};

describe("AuraBundleParser", () => {
  it("emits controller, embeds and label edges from markup and JS", async () => {
    const { node, keys } = await edges({
      "Shell.cmp": `<aura:component controller="acme.ShellCtrl" implements="force:hasRecordId">
        <!-- <c:CommentedOut/> and $Label.c.Commented -->
        <c:ChildPanel title="{!$Label.c.Panel_Title}"/>
        <c:recordTile recordId="{!v.recordId}"/>
        <c:ChildPanel/>
        <lightning:card title="x"/><ui:button/><force:recordData/>
        <aura:if isTrue="{!v.x}"/>
      </aura:component>`,
      "ShellController.js": `({ init: function (cmp) {
        /* $Label.c.InComment */
        var m = $A.get("$Label.c.Greeting");
        var o = $A.get("$Label.other.Foreign");
      } })`,
      "Shell.cmp-meta.xml": "<AuraDefinitionBundle/>",
    });
    expect(String(node?.qualifiedName)).toBe("AuraComponent:Shell");
    expect(node?.label).toBe("AuraComponent");
    expect(node?.attributes.bundleKind).toBe("component");
    expect(keys).toEqual([
      "CONTROLLED_BY|ApexClass:acme.ShellCtrl", // foreign ns kept (review I5)
      "EMBEDS_AURA|AuraComponent:ChildPanel",
      "EMBEDS_LWC|LWC:recordTile",
      "REFERENCES_LABEL|CustomLabel:Greeting",
      "REFERENCES_LABEL|CustomLabel:Panel_Title",
      "REFERENCES_LABEL|CustomLabel:other__Foreign",
    ]);
  });

  it("emits nothing but the node for a bundle without references", async () => {
    const { keys } = await edges({ "Evt.evt": '<aura:event type="APPLICATION"/>' }, "Evt");
    expect(keys).toEqual([]);
  });

  it("the node hash changes with any bundle file", async () => {
    const a = await edges({ "Shell.cmp": "<aura:component/>", "Shell.css": ".a{}" });
    const b = await edges({ "Shell.cmp": "<aura:component/>", "Shell.css": ".b{}" });
    expect(a.node?.sourceHash).not.toBe(b.node?.sourceHash);
  });
});

describe("adaptParserInput AuraDefinitionBundle", () => {
  const ref = {
    category: "AuraDefinitionBundle",
    memberType: "AuraDefinitionBundle",
    memberName: "Shell",
    lastModifiedAt: null,
    sourceUri: "x",
    namespace: null,
  } as unknown as MemberRef;
  it("routes filesystem bundle JSON to the Aura parser", () => {
    const a = adaptParserInput(
      ref,
      JSON.stringify({ bundleName: "Shell", files: { "Shell.cmp": "" } }),
    );
    expect(a?.type).toBe("AuraDefinitionBundle");
  });
  it("keeps live-org content (metadata.read JSON) on the opaque parser, as before", () => {
    const raw = JSON.stringify({ fullName: "Shell", type: "COMPONENT" });
    expect(adaptParserInput(ref, raw)).toEqual({
      type: "OpaqueMetadata",
      input: { metadataType: "AuraDefinitionBundle", name: "Shell", raw },
    });
    expect(adaptParserInput(ref, "<not json>")?.type).toBe("OpaqueMetadata");
  });
});

// review I5: only `c.` and the org's own namespace are local; a foreign
// namespace keeps the VF CONTROLLED_BY form (`ApexClass:ns.Cls`).
describe("review I5: Aura controller namespaces", () => {
  const ctrl = async (attr: string, namespace: string | null = null) => {
    const r = await new AuraBundleParser().parse(
      {
        bundleName: "Cmp",
        files: { "Cmp.cmp": `<aura:component controller="${attr}"></aura:component>` },
      },
      { ...makeTestCtx(), namespace },
    );
    return r.edges
      .filter((e) => e.relType === "CONTROLLED_BY")
      .map((e) => String(e.dstQualifiedName));
  };
  it("keeps a foreign namespace, strips c. and the own namespace", async () => {
    expect(await ctrl("vlocity_cmt.CardCanvasController")).toEqual([
      "ApexClass:vlocity_cmt.CardCanvasController",
    ]);
    expect(await ctrl("c.LocalCtrl")).toEqual(["ApexClass:LocalCtrl"]);
    expect(await ctrl("Plain")).toEqual(["ApexClass:Plain"]);
    expect(await ctrl("acme.OwnCtrl", "acme")).toEqual(["ApexClass:OwnCtrl"]);
  });
});

// review minor 9: markup/JS robustness.
describe("review minor 9: Aura parser robustness", () => {
  const ref9: MemberRef = { memberType: "AuraDefinitionBundle", memberName: "Shell" } as MemberRef;
  const parse = async (files: Record<string, string>) =>
    (await new AuraBundleParser().parse({ bundleName: "Cmp", files }, makeTestCtx())).edges
      .map((e) => `${e.relType}|${String(e.dstQualifiedName)}`)
      .sort();
  it("reads a single-quoted controller and ignores data-controller", async () => {
    expect(
      await parse({ "Cmp.cmp": "<aura:component controller='Single'></aura:component>" }),
    ).toEqual(["CONTROLLED_BY|ApexClass:Single"]);
    expect(
      await parse({ "Cmp.cmp": '<aura:component data-controller="Nope"></aura:component>' }),
    ).toEqual([]);
  });
  it("tolerates '>' inside a quoted root attribute", async () => {
    expect(
      await parse({
        "Cmp.cmp": '<aura:component description="a > b" controller="AfterGt"></aura:component>',
      }),
    ).toEqual(["CONTROLLED_BY|ApexClass:AfterGt"]);
  });
  it("ignores labels in trailing // comments", async () => {
    expect(
      await parse({
        "CmpController.js":
          '({ a: function () { var x = 1; // $Label.c.Gone\n var y = "$Label.c.Kept"; } })',
      }),
    ).toEqual(["REFERENCES_LABEL|CustomLabel:Kept"]);
  });
  it("falls back to opaque when a files value is not a string", () => {
    const raw = JSON.stringify({ bundleName: "Shell", files: { "Shell.cmp": 42 } });
    expect(adaptParserInput(ref9, raw)?.type).toBe("OpaqueMetadata");
  });
});

// review R1-5: regex literals and string escapes in the JS comment stripper.
describe("review R1-5: JS comment stripping understands regex literals and escapes", () => {
  const labels = async (js: string) =>
    (
      await new AuraBundleParser().parse(
        { bundleName: "Cmp", files: { "CmpController.js": js } },
        makeTestCtx(),
      )
    ).edges
      .map((e) => String(e.dstQualifiedName))
      .sort();
  it("a quote inside a regex literal does not open a string", async () => {
    expect(
      await labels(
        "({ a: function (s) { var t = s.replace(/'/g, ''); // $Label.c.Gone1\n var k = '$Label.c.Kept1'; } })",
      ),
    ).toEqual(["CustomLabel:Kept1"]);
  });
  it("an escaped slash closing a regex literal is not a // comment", async () => {
    expect(
      await labels('var re = /https?:\\/\\//; var k = "$Label.c.Kept2"; // $Label.c.Gone2\n'),
    ).toEqual(["CustomLabel:Kept2"]);
  });
  it("escaped quotes stay inside their string; division is not a regex", async () => {
    expect(
      await labels(
        "var a = 'it\\'s // $Label.c.InString'; var b = x / 2; // $Label.c.Gone3\nvar c = y / z / w; var d = \"$Label.c.Kept3\";",
      ),
    ).toEqual(["CustomLabel:InString", "CustomLabel:Kept3"]);
  });
});

describe("review R1-5: keyword before a regex", () => {
  it("`return /x'/` is a regex, `returnx / y` is division", async () => {
    const r = await new AuraBundleParser().parse(
      {
        bundleName: "Cmp",
        files: {
          "CmpHelper.js":
            "function f(){ return /x'/.test(s); } // $Label.c.Gone4\nvar returnx = 1; var q = returnx / 2; var k = '$Label.c.Kept4'; // $Label.c.Gone5\n",
        },
      },
      makeTestCtx(),
    );
    expect(r.edges.map((e) => String(e.dstQualifiedName)).sort()).toEqual(["CustomLabel:Kept4"]);
  });
});

// Server actions: `<anything>.get("c.method")` in the bundle JS names a method
// of the root tag's Apex controller, linked like an LWC `@salesforce/apex` import.
describe("Aura server actions link to the controller's Apex methods", () => {
  const apex = async (
    files: Record<string, string>,
    namespace: string | null = null,
  ): Promise<string[]> =>
    (
      await new AuraBundleParser().parse(
        { bundleName: "Cmp", files },
        { ...makeTestCtx(), namespace },
      )
    ).edges
      .filter((e) => e.relType === "IMPORTS_APEX")
      .map((e) => {
        const a = e.attributes;
        return `${String(e.dstQualifiedName)} ${String(a.className)}.${String(a.methodName)} ${String(a.via)}`;
      })
      .sort();
  const cmp = (ctrl: string) => `<aura:component controller="${ctrl}"></aura:component>`;
  const edge = (cls: string, m: string) => `ApexMethod:${cls}.${m}(?) ${cls}.${m} aura-action`;

  it("links component.get / cmp.get / any receiver, single or double quotes", async () => {
    expect(
      await apex({
        "Cmp.cmp": cmp("MyApexCtrl"),
        "CmpController.js": `({ init: function (component, event, helper) {
          var action = component.get("c.getAccounts");
          $A.enqueueAction(action);
          helper.save(component);
        } })`,
        "CmpHelper.js": `({ save: function (cmp) {
          var a = cmp.get('c.saveAccount'); a.setParams({ x: cmp.get("v.record") });
          var b = someOther.get( "c.getAccounts" );
          $A.enqueueAction(a);
        } })`,
      }),
    ).toEqual([edge("MyApexCtrl", "getAccounts"), edge("MyApexCtrl", "saveAccount")]);
  });

  it("ignores v. attributes, `c.` strings not passed to get(), comments and $A.get", async () => {
    expect(
      await apex({
        "Cmp.cmp": cmp("MyApexCtrl"),
        "CmpController.js": `({ init: function (component) {
          var r = component.get("v.record");
          var s = "c.notAnAction";
          console.log('c.alsoNot');
          // component.get("c.commentedOut")
          /* cmp.get('c.blockComment') */
          var g = $A.get("c.notServer");
          var dyn = component.get("c." + name);
          var t = component.getNot("c.wrongMethod");
        } })`,
      }),
    ).toEqual([]);
  });

  it("emits nothing without a controller, or for a foreign-namespace controller", async () => {
    const js = { "CmpController.js": '({ a: function (c) { c.get("c.load"); } })' };
    expect(await apex({ "Cmp.cmp": "<aura:component></aura:component>", ...js })).toEqual([]);
    expect(await apex({ "Cmp.cmp": cmp("vlocity_cmt.Foreign"), ...js })).toEqual([]);
    expect(await apex({ "Cmp.cmp": cmp("acme.OwnCtrl"), ...js }, "acme")).toEqual([
      edge("OwnCtrl", "load"),
    ]);
    expect(await apex({ "Cmp.cmp": cmp("c.LocalCtrl"), ...js })).toEqual([
      edge("LocalCtrl", "load"),
    ]);
  });

  it("does not depend on file order", async () => {
    expect(
      await apex({
        "A_first.js": '({ a: function (c) { c.get("c.early"); } })',
        "Cmp.cmp": cmp("Ctrl"),
      }),
    ).toEqual([edge("Ctrl", "early")]);
  });
});

// Platform events (lightning:empApi) and Lightning Message Service
// (lightning:messageChannel) in Aura bundles.
describe("Aura empApi and message channels", () => {
  const evts = async (files: Record<string, string>) =>
    (await new AuraBundleParser().parse({ bundleName: "Cmp", files }, makeTestCtx())).edges
      .filter((e) => e.relType === "PUBLISHES_EVENT" || e.relType === "SUBSCRIBES_TO_EVENT")
      .map((e) => `${e.relType}|${String(e.dstQualifiedName)}`)
      .sort();

  it("an empApi bundle subscribes to the /event/ channels it names", async () => {
    expect(
      await evts({
        "Cmp.cmp": `<aura:component>
          <aura:attribute name="channel" type="String" default="/event/Order_Placed__e"/>
          <lightning:empApi aura:id="empApi"/>
        </aura:component>`,
        "CmpController.js": `({ init: function (cmp) {
          var empApi = cmp.find("empApi");
          empApi.subscribe('/event/Shipment__e', -1, function () {});
          empApi.subscribe(cmp.get("v.channel"), -1, function () {});
          var cdc = "/data/AccountChangeEvent";
          // '/event/Commented__e'
        } })`,
      }),
    ).toEqual([
      "SUBSCRIBES_TO_EVENT|PlatformEvent:Order_Placed__e",
      "SUBSCRIBES_TO_EVENT|PlatformEvent:Shipment__e",
    ]);
  });

  it("an /event/ string without lightning:empApi is not a subscription", async () => {
    expect(
      await evts({
        "Cmp.cmp": "<aura:component></aura:component>",
        "CmpController.js": "({ a: function () { var x = '/event/Foo__e'; } })",
      }),
    ).toEqual([]);
  });

  it("lightning:messageChannel subscribes with onMessage, publishes via find().publish()", async () => {
    expect(
      await evts({
        "Cmp.cmp": `<aura:component>
          <lightning:messageChannel type="Record_Selected__c" onMessage="{!c.handle}"/>
          <lightning:messageChannel type="Cart_Update__c" aura:id="cartChannel"/>
          <lightning:messageChannel type="Unused__c" aura:id="unused"/>
          <!-- <lightning:messageChannel type="Commented__c" onMessage="{!c.x}"/> -->
        </aura:component>`,
        "CmpController.js": `({ go: function (cmp) {
          cmp.find("cartChannel").publish({ id: 1 });
          cmp.find("unknownId").publish({ id: 2 });
        } })`,
      }),
    ).toEqual([
      "PUBLISHES_EVENT|LightningMessageChannel:Cart_Update",
      "SUBSCRIBES_TO_EVENT|LightningMessageChannel:Record_Selected",
    ]);
  });
});
