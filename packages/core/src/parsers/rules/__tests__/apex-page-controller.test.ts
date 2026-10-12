import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { loadAllRules, parserRegistry } from "../../index.js";

/**
 * Task 14 batch P, rule 9: a filesystem `.page` / `.component` member arrives
 * as `{ name, xml: <markup> }` (no `body`), so the controller / extensions
 * attributes must be read from the markup. `standardController` is not an
 * Apex controller, and managed (`ns.Class`) or merge-field values are skipped.
 */
async function parse(type: string, name: string, xml: string) {
  await loadAllRules();
  const p = parserRegistry.for(type);
  if (!p) throw new Error(`no parser ${type}`);
  const r = await p.parse({ name, xml } as never, makeTestCtx());
  return r.edges.map((e) => `${e.relType} ${String(e.dstQualifiedName)}`).sort();
}

describe("ApexPage / ApexComponent controllers from markup", () => {
  it("controller= and extensions= on a .page", async () => {
    expect(
      await parse(
        "ApexPage",
        "MyPage",
        `<apex:page controller="LeadCheck" extensions="ExtOne, vlocity_cmt.VFPageControllerBase,ExtTwo" showHeader="false"><apex:form/></apex:page>`,
      ),
    ).toEqual([
      "CONTROLLED_BY ApexClass:LeadCheck",
      "EXTENDS_CONTROLLER ApexClass:ExtOne",
      "EXTENDS_CONTROLLER ApexClass:ExtTwo",
    ]);
  });

  it("standardController, managed and merge-field controllers emit nothing", async () => {
    expect(
      await parse(
        "ApexPage",
        "StdPage",
        `<apex:page standardController="Account" extensions="AccExt"><apex:detail/></apex:page>`,
      ),
    ).toEqual(["EXTENDS_CONTROLLER ApexClass:AccExt"]);
    expect(
      await parse(
        "ApexPage",
        "Managed",
        `<apex:page controller="vlocity_cmt.CardCanvasController"/>`,
      ),
    ).toEqual([]);
    expect(
      await parse("ApexPage", "Merge", `<apex:page standardController="{!stdController}"/>`),
    ).toEqual([]);
  });

  it("single-quoted attributes are read too", async () => {
    expect(
      await parse(
        "ApexPage",
        "Single",
        `<apex:page controller='PageCtrl' extensions='ExtA,ExtB'><apex:form/></apex:page>`,
      ),
    ).toEqual([
      "CONTROLLED_BY ApexClass:PageCtrl",
      "EXTENDS_CONTROLLER ApexClass:ExtA",
      "EXTENDS_CONTROLLER ApexClass:ExtB",
    ]);
    expect(
      await parse(
        "ApexComponent",
        "SingleComp",
        `<apex:component controller='CompCtrl' extensions='CompExt'/>`,
      ),
    ).toEqual(["CONTROLLED_BY ApexClass:CompCtrl", "EXTENDS_CONTROLLER ApexClass:CompExt"]);
  });

  it("the .component rule reads the same markup", async () => {
    expect(
      await parse(
        "ApexComponent",
        "Comp",
        `<apex:component controller="CompCtrl"></apex:component>`,
      ),
    ).toEqual(["CONTROLLED_BY ApexClass:CompCtrl"]);
  });
});
