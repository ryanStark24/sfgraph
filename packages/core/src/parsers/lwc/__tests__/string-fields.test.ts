import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { LwcBundleParser } from "../index.js";

/**
 * Fields named as `'Object.Field'` strings (instead of `@salesforce/schema`
 * imports) in uiRecordApi calls and record forms link to the field, the same
 * way a schema import does.
 */
const parse = async (js: string, html?: string, namespace: string | null = null) => {
  const files: Record<string, string> = { "cmp.js": js };
  if (html !== undefined) files["cmp.html"] = html;
  const r = await new LwcBundleParser().parse(
    { bundleName: "cmp", files },
    { ...makeTestCtx(), namespace },
  );
  return r.edges;
};
const fieldEdges = (edges: Awaited<ReturnType<typeof parse>>, rel: string) =>
  edges
    .filter((e) => e.relType === rel)
    .map((e) => `${String(e.dstQualifiedName)} ${String(e.attributes.via)}`)
    .sort();

describe("LWC: string field lists", () => {
  it("@wire(getRecord) fields / optionalFields of 'Object.Field' strings read those fields", async () => {
    const edges = await parse(`
      import { LightningElement, api, wire } from 'lwc';
      import { getRecord } from 'lightning/uiRecordApi';
      const FIELDS = ['Account.Tier__c', 'Account.Name'];
      export default class Cmp extends LightningElement {
        @api recordId;
        @wire(getRecord, { recordId: '$recordId', fields: FIELDS, optionalFields: ['Account.Rating', 'Account.Owner.Name'] })
        account;
        @wire(getRecord, { recordId: '$recordId', fields: ['Contact.Email'] })
        contact;
      }
    `);
    expect(fieldEdges(edges, "READS_FIELD")).toEqual([
      "CustomField:Account.Name wire",
      "CustomField:Account.Rating wire",
      "CustomField:Account.Tier__c wire",
      "CustomField:Contact.Email wire",
    ]);
    expect(fieldEdges(edges, "WRITES_FIELD")).toEqual([]);
  });

  it("a string-field wire binds the template's {record.fields.X.value} to the object", async () => {
    const edges = await parse(
      `
      import { LightningElement, api, wire } from 'lwc';
      import { getRecord } from 'lightning/uiRecordApi';
      export default class Cmp extends LightningElement {
        @api recordId;
        @wire(getRecord, { recordId: '$recordId', fields: ['Account.Tier__c'] })
        account;
      }`,
      "<template>{account.fields.Tier__c.value}</template>",
    );
    expect(
      edges.filter((e) => e.relType === "LWC_BINDS_FIELD").map((e) => String(e.dstQualifiedName)),
    ).toEqual(["CustomField:Account.Tier__c"]);
  });

  it("getRecords nests fields inside records[]", async () => {
    const edges = await parse(`
      import { LightningElement, wire } from 'lwc';
      import { getRecords } from 'lightning/uiRecordApi';
      export default class Cmp extends LightningElement {
        @wire(getRecords, { records: [{ recordIds: ['001'], fields: ['Account.Name'] }] })
        recs;
      }
    `);
    expect(fieldEdges(edges, "READS_FIELD")).toEqual(["CustomField:Account.Name wire"]);
  });

  it("getFieldValue / getFieldDisplayValue with a string or this.<prop> read the field", async () => {
    const edges = await parse(`
      import { LightningElement, api, wire } from 'lwc';
      import { getRecord, getFieldValue, getFieldDisplayValue } from 'lightning/uiRecordApi';
      import NAME_FIELD from '@salesforce/schema/Account.Name';
      const TIER = 'Account.Tier__c';
      export default class Cmp extends LightningElement {
        regionField = 'Account.Region__c';
        @wire(getRecord, { recordId: '$recordId', fields: [NAME_FIELD] }) account;
        get tier() { return getFieldValue(this.account.data, TIER); }
        get industry() { return getFieldDisplayValue(this.account.data, 'Account.Industry'); }
        get region() { return getFieldValue(this.account.data, this.regionField); }
        get name() { return getFieldValue(this.account.data, NAME_FIELD); }
      }
    `);
    expect(fieldEdges(edges, "READS_FIELD")).toEqual([
      "CustomField:Account.Industry getFieldValue",
      "CustomField:Account.Name schema-import",
      "CustomField:Account.Region__c getFieldValue",
      "CustomField:Account.Tier__c getFieldValue",
    ]);
  });

  it("ignores 'Object.Field' strings outside those calls, local getFieldValue, and dynamic values", async () => {
    const edges = await parse(`
      import { LightningElement, api, wire } from 'lwc';
      import { getRecord } from 'lightning/uiRecordApi';
      function getFieldValue(a, b) { return a[b]; }
      export default class Cmp extends LightningElement {
        label = 'Account.Name';
        @api fieldList;
        @wire(getRecord, { recordId: '$recordId', fields: '$fieldList' }) account;
        get x() { return getFieldValue(this.account, 'Account.Phone'); }
        get y() { return { fields: ['Account.Fax'] }; }
      }
    `);
    expect(fieldEdges(edges, "READS_FIELD")).toEqual([]);
  });

  it("createRecord / updateRecord fields write the fields when the object is known", async () => {
    const edges = await parse(`
      import { LightningElement } from 'lwc';
      import { createRecord, updateRecord } from 'lightning/uiRecordApi';
      import ACCOUNT_OBJECT from '@salesforce/schema/Account';
      import NAME_FIELD from '@salesforce/schema/Account.Name';
      import CONTACT_EMAIL from '@salesforce/schema/Contact.Email';
      import ID_FIELD from '@salesforce/schema/Contact.Id';
      export default class Cmp extends LightningElement {
        create() {
          const fields = {};
          fields[NAME_FIELD.fieldApiName] = this.name;
          fields.Tier__c = 'Gold';
          const recordInput = { apiName: ACCOUNT_OBJECT.objectApiName, fields };
          return createRecord(recordInput);
        }
        createCase() {
          return createRecord({ apiName: 'Case', fields: { Subject: 'x', Priority: 'High' } });
        }
        update() {
          const fields = { [CONTACT_EMAIL.fieldApiName]: this.email, Id: this.recordId };
          fields[ID_FIELD.fieldApiName] = this.recordId;
          return updateRecord({ fields });
        }
        updateUnknown() {
          return updateRecord({ fields: { Id: this.recordId, Site_Remarks__c: 'x' } });
        }
      }
    `);
    expect(fieldEdges(edges, "WRITES_FIELD")).toEqual([
      "CustomField:Account.Name createRecord",
      "CustomField:Account.Tier__c createRecord",
      "CustomField:Case.Priority createRecord",
      "CustomField:Case.Subject createRecord",
      "CustomField:Contact.Email updateRecord",
    ]);
  });

  it("strips the org's own namespace from string fields", async () => {
    const edges = await parse(
      `
      import { LightningElement, wire } from 'lwc';
      import { getRecord } from 'lightning/uiRecordApi';
      export default class Cmp extends LightningElement {
        @wire(getRecord, { recordId: '$recordId', fields: ['acme__Thing__c.acme__Size__c'] }) rec;
      }`,
      undefined,
      "acme",
    );
    expect(fieldEdges(edges, "READS_FIELD")).toEqual(["CustomField:Thing__c.Size__c wire"]);
  });
});

describe("LWC: record form fields", () => {
  const js = `
    import { LightningElement, api } from 'lwc';
    import ACCOUNT_OBJECT from '@salesforce/schema/Account';
    import NAME_FIELD from '@salesforce/schema/Account.Name';
    export default class Cmp extends LightningElement {
      @api recordId;
      @api dynamicObject;
      objectApiName = ACCOUNT_OBJECT;
      fields = ['Tier__c', 'Account.Rating'];
      viewFields = [NAME_FIELD, 'Phone'];
      emailField = 'Email';
    }`;

  it("lightning-record-form fields={prop}: reads, and writes unless readonly", async () => {
    const edges = await parse(
      js,
      `<template>
        <lightning-record-form record-id={recordId} object-api-name={objectApiName} fields={fields}></lightning-record-form>
        <lightning-record-form object-api-name="Account" fields={viewFields} mode="readonly"></lightning-record-form>
      </template>`,
    );
    expect(fieldEdges(edges, "READS_FIELD")).toEqual([
      "CustomField:Account.Name record-form",
      "CustomField:Account.Name schema-import",
      "CustomField:Account.Phone record-form",
      "CustomField:Account.Rating record-form",
      "CustomField:Account.Tier__c record-form",
    ]);
    expect(fieldEdges(edges, "WRITES_FIELD")).toEqual([
      "CustomField:Account.Rating record-form",
      "CustomField:Account.Tier__c record-form",
    ]);
  });

  it("input fields of an edit form read and write; output fields of a view form read", async () => {
    const edges = await parse(
      js,
      `<template>
        <lightning-record-edit-form object-api-name="Contact">
          <template if:true={ready}>
            <lightning-input-field field-name="LastName"></lightning-input-field>
          </template>
          <lightning-input-field field-name={emailField}></lightning-input-field>
        </lightning-record-edit-form>
        <lightning-record-view-form object-api-name="Lead" record-id={recordId}>
          <lightning-output-field field-name="Company"></lightning-output-field>
        </lightning-record-view-form>
        <lightning-input-field field-name="Orphan"></lightning-input-field>
      </template>`,
    );
    expect(fieldEdges(edges, "READS_FIELD")).toEqual([
      "CustomField:Account.Name schema-import",
      "CustomField:Contact.Email record-form",
      "CustomField:Contact.LastName record-form",
      "CustomField:Lead.Company record-form",
    ]);
    expect(fieldEdges(edges, "WRITES_FIELD")).toEqual([
      "CustomField:Contact.Email record-form",
      "CustomField:Contact.LastName record-form",
    ]);
  });

  it("a form whose object is not static links no fields", async () => {
    const edges = await parse(
      js,
      `<template>
        <lightning-record-form object-api-name={dynamicObject} fields={fields}></lightning-record-form>
        <lightning-record-form record-id={recordId} fields={unknownProp}></lightning-record-form>
      </template>`,
    );
    // 'Account.Rating' names its object itself, so it still links.
    expect(fieldEdges(edges, "READS_FIELD")).toEqual([
      "CustomField:Account.Name schema-import",
      "CustomField:Account.Rating record-form",
    ]);
  });
});
