import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import type { ParseContext } from "../../contract.js";
import { loadAllRules, parserRegistry } from "../../index.js";

/**
 * Visualforce merge fields and markup references: pages and components link
 * to the fields, objects and labels their `{!…}` expressions name, and to the
 * components, pages and templates their markup pulls in, so impact analysis
 * sees them and the dead-code audit does not report a component or page used
 * only from markup.
 */
async function parse(type: string, name: string, xml: string, ns: string | null = null) {
  await loadAllRules();
  const p = parserRegistry.for(type);
  if (!p) throw new Error(`no parser ${type}`);
  const ctx: ParseContext = { ...makeTestCtx(), namespace: ns };
  const r = await p.parse({ name, xml } as never, ctx);
  return r.edges
    .filter((e) => e.relType !== "CONTROLLED_BY" && e.relType !== "EXTENDS_CONTROLLER")
    .map((e) => `${e.relType} ${String(e.dstQualifiedName)}`)
    .sort();
}

const page = (name: string, xml: string, ns: string | null = null) =>
  parse("ApexPage", name, xml, ns);

describe("VF merge fields: fields, objects and labels", () => {
  it("standardController object: bare {!Account.X} reads, inputField writes", async () => {
    expect(
      await page(
        "AccView",
        `<apex:page standardController="Account">
           <h1>{!Account.Name}</h1>
           <apex:outputField value="{!Account.Industry}"/>
           <apex:form><apex:inputField value="{!Account.Phone}"/></apex:form>
         </apex:page>`,
      ),
    ).toEqual([
      "READS_FIELD CustomField:Account.Industry",
      "READS_FIELD CustomField:Account.Name",
      "REFERENCES_OBJECT CustomObject:Account",
      "WRITES_FIELD CustomField:Account.Phone",
    ]);
  });

  it("inputField on Contact.Email with a Contact standard controller is a write", async () => {
    expect(
      await page(
        "ContactEdit",
        `<apex:page standardController="Contact"><apex:inputField value="{!Contact.Email}" required="true"/></apex:page>`,
      ),
    ).toEqual(["REFERENCES_OBJECT CustomObject:Contact", "WRITES_FIELD CustomField:Contact.Email"]);
  });

  it("fields inside formulas, custom fields and custom relationship hops", async () => {
    expect(
      await page(
        "OppView",
        `<apex:page standardController="Opportunity">
           {!IF(Opportunity.IsWon, Opportunity.Amount, 'Opportunity.Fake')}
           {!opportunity.Region__c}
           {!Opportunity.Partner__r.Name}
         </apex:page>`,
      ),
    ).toEqual([
      "READS_FIELD CustomField:Opportunity.Amount",
      "READS_FIELD CustomField:Opportunity.IsWon",
      "READS_FIELD CustomField:Opportunity.Partner__c",
      "READS_FIELD CustomField:Opportunity.Region__c",
      "REFERENCES_OBJECT CustomObject:Opportunity",
    ]);
  });

  it("unknown roots (controller properties, vars) emit no field edge", async () => {
    expect(
      await page(
        "Custom",
        `<apex:page controller="AccCtrl">
           <apex:outputField value="{!acc.Industry}"/>
           {!Account.Name}
           <apex:repeat value="{!rows}" var="r">{!r.Name}</apex:repeat>
         </apex:page>`,
      ),
    ).toEqual([]);
    // A standard controller does not make other objects known.
    expect(
      await page(
        "Std",
        `<apex:page standardController="Account">{!Contact.Email} {!Account.Owner.Name}</apex:page>`,
      ),
    ).toEqual(["REFERENCES_OBJECT CustomObject:Account"]);
  });

  it("merge fields inside comments are ignored", async () => {
    expect(
      await page(
        "Commented",
        `<apex:page standardController="Account"><!-- {!Account.Name} {!$Label.Old} <c:Gone/> --></apex:page>`,
      ),
    ).toEqual(["REFERENCES_OBJECT CustomObject:Account"]);
  });

  it("$Label references the CustomLabel; own namespace stripped, foreign kept", async () => {
    expect(
      await page(
        "Labels",
        `<apex:page>{!$Label.My_Label} <apex:outputText value="{!$Label.acme__Greeting}"/> {!$Label.other__Thing}</apex:page>`,
        "acme",
      ),
    ).toEqual([
      "REFERENCES_LABEL CustomLabel:Greeting",
      "REFERENCES_LABEL CustomLabel:My_Label",
      "REFERENCES_LABEL CustomLabel:other__Thing",
    ]);
  });

  it("$ObjectType field and object describes", async () => {
    expect(
      await page(
        "Describe",
        "<apex:page>{!$ObjectType.Account.fields.Name.Label} {!$ObjectType.Case.Fields.Reason__c.inlineHelpText} {!$ObjectType.Lead.label}</apex:page>",
      ),
    ).toEqual([
      "READS_FIELD CustomField:Account.Name",
      "READS_FIELD CustomField:Case.Reason__c",
      "REFERENCES_OBJECT CustomObject:Account",
      "REFERENCES_OBJECT CustomObject:Case",
      "REFERENCES_OBJECT CustomObject:Lead",
    ]);
  });

  it("$ObjectType field edges are tagged as describes", async () => {
    await loadAllRules();
    const p = parserRegistry.for("ApexPage");
    const r = await p!.parse(
      {
        name: "D",
        xml: "<apex:page>{!$ObjectType.Account.fields.Name.Label}</apex:page>",
      } as never,
      makeTestCtx(),
    );
    const e = r.edges.find((x) => x.relType === "READS_FIELD");
    expect(e?.attributes).toMatchObject({ via: "$ObjectType" });
  });

  it("components get the same merge-field edges", async () => {
    expect(
      await parse(
        "ApexComponent",
        "Header",
        "<apex:component>{!$Label.Title} {!$ObjectType.Account.fields.Name.label}</apex:component>",
      ),
    ).toEqual([
      "READS_FIELD CustomField:Account.Name",
      "REFERENCES_LABEL CustomLabel:Title",
      "REFERENCES_OBJECT CustomObject:Account",
    ]);
  });
});

describe("VF markup references to components and pages", () => {
  it("<c:Comp>, apex:include, apex:composition and $Page", async () => {
    expect(
      await page(
        "Shell",
        `<apex:page>
           <apex:composition template="SiteTemplate">
             <apex:define name="body"><c:MyComp title="x"/><c:MyComp/></apex:define>
           </apex:composition>
           <apex:include pageName="Footer"/>
           <apex:outputLink value="{!$Page.Other}">go</apex:outputLink>
           <apex:outputText value="{!URLFOR($Page.Help)}"/>
         </apex:page>`,
      ),
    ).toEqual([
      "REFERENCES ApexComponent:MyComp",
      "REFERENCES ApexPage:Footer",
      "REFERENCES ApexPage:Help",
      "REFERENCES ApexPage:Other",
      "REFERENCES ApexPage:SiteTemplate",
    ]);
  });

  it("the org's own namespace prefix is a local component; others are not", async () => {
    expect(
      await page(
        "Ns",
        "<apex:page><acme:Banner/><c:Card/><other:Widget/><chatter:feed/><apex:detail/></apex:page>",
        "acme",
      ),
    ).toEqual(["REFERENCES ApexComponent:Banner", "REFERENCES ApexComponent:Card"]);
    // Without a configured namespace only `c:` is local.
    expect(await page("NoNs", "<apex:page><acme:Banner/><c:Card/></apex:page>")).toEqual([
      "REFERENCES ApexComponent:Card",
    ]);
  });

  it("components embed other components; merge-field page names are not literal", async () => {
    expect(
      await parse(
        "ApexComponent",
        "Outer",
        `<apex:component><c:Inner/><apex:include pageName="{!dynamicPage}"/></apex:component>`,
      ),
    ).toEqual(["REFERENCES ApexComponent:Inner"]);
  });

  it("edges carry how the reference was made", async () => {
    await loadAllRules();
    const p = parserRegistry.for("ApexPage");
    const r = await p!.parse(
      {
        name: "Via",
        xml: `<apex:page><c:A/><apex:include pageName="B"/><apex:composition template="C"/></apex:page>`,
      } as never,
      makeTestCtx(),
    );
    const via = Object.fromEntries(
      r.edges.map((e) => [String(e.dstQualifiedName), (e.attributes as { via?: string }).via]),
    );
    expect(via).toEqual({
      "ApexComponent:A": "c:A",
      "ApexPage:B": "apex:include",
      "ApexPage:C": "apex:composition",
    });
  });
});
