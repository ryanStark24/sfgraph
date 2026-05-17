import { describe, expect, it } from "vitest";
import { LwcBundleParser } from "../lwc/index.js";
import { makeTestCtx } from "./_harness.js";

describe("LWC template binding resolution (Phase 5)", () => {
  it("resolves `{record.Name}` to CustomField via @wire(getRecord) + schema imports", async () => {
    const js = `
      import { LightningElement, wire, api } from 'lwc';
      import { getRecord } from 'lightning/uiRecordApi';
      import NAME_FIELD from '@salesforce/schema/Account.Name';
      import PHONE_FIELD from '@salesforce/schema/Account.Phone';
      export default class AccountTile extends LightningElement {
        @api recordId;
        @wire(getRecord, { recordId: '$recordId', fields: [NAME_FIELD, PHONE_FIELD] })
        record;
      }
    `;
    const html = `
      <template>
        <lightning-card title={record.fields.Name}>
          <span class="phone">{record.Phone}</span>
        </lightning-card>
      </template>
    `;
    const parser = new LwcBundleParser();
    const result = await parser.parse(
      { bundleName: "accountTile", files: { "accountTile.js": js, "accountTile.html": html } },
      makeTestCtx(),
    );

    const fieldEdges = result.edges.filter((e) => e.relType === "LWC_BINDS_FIELD").map((e) => String(e.dstQualifiedName)).sort();
    expect(fieldEdges).toContain("CustomField:Account.Name");
    expect(fieldEdges).toContain("CustomField:Account.Phone");

    // Schema imports also emit READS_FIELD (independent of template).
    expect(
      result.edges.some(
        (e) => e.relType === "READS_FIELD" && e.dstQualifiedName === "CustomField:Account.Name",
      ),
    ).toBe(true);
  });

  it("resolves `{record.fields.Name.value}` v53+ getRecord proxy shape", async () => {
    const js = `
      import { LightningElement, wire, api } from 'lwc';
      import { getRecord } from 'lightning/uiRecordApi';
      import NAME_FIELD from '@salesforce/schema/Account.Name';
      export default class V53 extends LightningElement {
        @api recordId;
        @wire(getRecord, { recordId: '$recordId', fields: [NAME_FIELD] })
        record;
      }
    `;
    const html = `<template><span>{record.fields.Name.value}</span></template>`;
    const parser = new LwcBundleParser();
    const result = await parser.parse(
      { bundleName: "v53", files: { "v53.js": js, "v53.html": html } },
      makeTestCtx(),
    );
    const fieldEdges = result.edges
      .filter((e) => e.relType === "LWC_BINDS_FIELD")
      .map((e) => String(e.dstQualifiedName));
    expect(fieldEdges).toContain("CustomField:Account.Name");
    // Must NOT capture the proxy accessor as the field name.
    expect(fieldEdges).not.toContain("CustomField:Account.value");
  });

  it("W1-03: harvests lwc:if / lwc:elseif / lwc:for:each directive bindings with directive attribute", async () => {
    const js = `
      import { LightningElement } from 'lwc';
      export default class Cond extends LightningElement {
        isShown = false;
        items = [];
        state = { ready: true };
      }
    `;
    const html = `
      <template>
        <template lwc:if={isShown}>
          <span>Visible</span>
        </template>
        <template lwc:elseif={state.ready}>
          <span>Loading</span>
        </template>
        <template lwc:for:each={items} lwc:for:item="card">
          <span key={card.id}>{card.title}</span>
        </template>
      </template>
    `;
    const parser = new LwcBundleParser();
    const result = await parser.parse(
      { bundleName: "cond", files: { "cond.js": js, "cond.html": html } },
      makeTestCtx(),
    );

    const propEdges = result.edges.filter((e) => e.relType === "LWC_BINDS_PROPERTY");
    const ifEdge = propEdges.find((e) => e.attributes.directive === "lwc:if");
    const elseifEdge = propEdges.find((e) => e.attributes.directive === "lwc:elseif");
    const forEdge = propEdges.find((e) => e.attributes.directive === "lwc:for:each");

    expect(ifEdge).toBeDefined();
    expect(String(ifEdge?.dstQualifiedName)).toBe("LWCProperty:isShown");
    expect(elseifEdge).toBeDefined();
    expect(String(elseifEdge?.dstQualifiedName)).toBe("LWCProperty:state.ready");
    expect(forEdge).toBeDefined();
    expect(String(forEdge?.dstQualifiedName)).toBe("LWCProperty:items");
    expect(forEdge?.attributes.forItem).toBe("card");

    // De-dup check: the directive value should not also surface as a plain
    // property bind (would double-count the same binding).
    const isShownEdges = propEdges.filter((e) => String(e.dstQualifiedName) === "LWCProperty:isShown");
    expect(isShownEdges).toHaveLength(1);
  });

  it("W1-03: legacy if:true / if:false / for:each (template:1) syntax also recorded", async () => {
    const js = `
      import { LightningElement } from 'lwc';
      export default class Legacy extends LightningElement {
        isOpen = true;
        rows = [];
      }
    `;
    const html = `
      <template>
        <template if:true={isOpen}><span>Open</span></template>
        <template if:false={isOpen}><span>Closed</span></template>
        <template for:each={rows} for:item="row">
          <span key={row.id}>{row.name}</span>
        </template>
      </template>
    `;
    const parser = new LwcBundleParser();
    const result = await parser.parse(
      { bundleName: "legacy", files: { "legacy.js": js, "legacy.html": html } },
      makeTestCtx(),
    );

    const propEdges = result.edges.filter((e) => e.relType === "LWC_BINDS_PROPERTY");
    const ifTrue = propEdges.find((e) => e.attributes.directive === "if:true");
    const ifFalse = propEdges.find((e) => e.attributes.directive === "if:false");
    const forEach = propEdges.find((e) => e.attributes.directive === "for:each");

    expect(ifTrue).toBeDefined();
    expect(String(ifTrue?.dstQualifiedName)).toBe("LWCProperty:isOpen");
    // De-dup: if:true and if:false bind the same `isOpen` — emitted once.
    const isOpenEdges = propEdges.filter((e) => String(e.dstQualifiedName) === "LWCProperty:isOpen");
    expect(isOpenEdges).toHaveLength(1);
    expect(ifFalse).toBeUndefined(); // dropped by de-dup; isOpen already seen via if:true
    expect(forEach).toBeDefined();
    expect(forEach?.attributes.forItem).toBe("row");
  });

  it("falls back to LWC_BINDS_PROPERTY when the binding can't be resolved to a sObject", async () => {
    const js = `
      import { LightningElement } from 'lwc';
      export default class Plain extends LightningElement {
        count = 0;
        handleClick() {}
      }
    `;
    const html = `<template><button onclick={handleClick}>{count}</button></template>`;
    const parser = new LwcBundleParser();
    const result = await parser.parse(
      { bundleName: "plain", files: { "plain.js": js, "plain.html": html } },
      makeTestCtx(),
    );

    const props = result.edges
      .filter((e) => e.relType === "LWC_BINDS_PROPERTY")
      .map((e) => String(e.dstQualifiedName))
      .sort();
    expect(props).toContain("LWCProperty:count");
    expect(props).toContain("LWCProperty:handleClick");

    // No field binding edges since there was no wire.
    expect(result.edges.filter((e) => e.relType === "LWC_BINDS_FIELD")).toHaveLength(0);
  });
});
