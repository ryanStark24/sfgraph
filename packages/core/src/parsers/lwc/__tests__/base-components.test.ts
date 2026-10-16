import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { extractHtmlEdges } from "../html-visitor.js";

/**
 * Task 14 batch P, rule 7: `lightning-*` tags are Salesforce base components,
 * never org LWC bundles, so they produce no `LWC:<camel>` edge (they used to
 * leave hundreds of dangling `LWC:icon` / `LWC:button` targets). `c-*` tags
 * stay EMBEDS_LWC; other namespaces stay EMBEDS_AURA.
 */
describe("LWC template: base components", () => {
  it("skips lightning-* tags, keeps c-* and other namespaces", () => {
    const html = `<template>
      <lightning-icon icon-name="utility:add"></lightning-icon>
      <lightning-button label="x"></lightning-button>
      <c-account-detail></c-account-detail>
      <omnistudio-flex-card></omnistudio-flex-card>
    </template>`;
    const { extraEdges } = extractHtmlEdges(html, "LWC:host", makeTestCtx());
    const got = extraEdges
      .filter((e) => e.relType === "EMBEDS_LWC" || e.relType === "EMBEDS_AURA")
      .map((e) => `${e.relType} ${String(e.dstQualifiedName)}`)
      .sort();
    expect(got).toEqual([
      "EMBEDS_AURA AuraComponent:omnistudio:flex-card",
      "EMBEDS_LWC LWC:accountDetail",
    ]);
  });

  it("links a record form's literal object-api-name to its object, not a bound one", () => {
    const html = `<template>
      <lightning-record-view-form record-id={recordId} object-api-name="Order"></lightning-record-view-form>
      <lightning-record-edit-form object-api-name="Order"></lightning-record-edit-form>
      <lightning-record-form object-api-name={objectApiName}></lightning-record-form>
      <c-lookup object-api-name="City__c"></c-lookup>
    </template>`;
    const { extraEdges } = extractHtmlEdges(html, "LWC:host", makeTestCtx());
    const got = extraEdges
      .filter((e) => e.relType === "REFERENCES_OBJECT")
      .map((e) => `${String(e.dstQualifiedName)} ${String(e.attributes.via)}`);
    expect(got).toEqual(["CustomObject:Order record-form"]);
  });
});
