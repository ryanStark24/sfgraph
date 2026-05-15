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
