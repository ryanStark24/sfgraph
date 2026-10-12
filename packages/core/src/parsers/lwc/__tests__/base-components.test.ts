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
});
