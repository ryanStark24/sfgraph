import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { LwcBundleParser } from "../bundle.js";
import { extractJsEdges } from "../js-visitor.js";

const refs = (src: string) =>
  extractJsEdges(src, "LWC:host", makeTestCtx())
    .extraEdges.filter((e) => e.relType === "REFERENCES")
    .map((e) => `${String(e.dstQualifiedName)}|${String(e.attributes.via)}`)
    .sort();

describe("LWC → LWC references from JS", () => {
  it("links `import … from 'c/x'` once per target", () => {
    expect(
      refs(`
        import { reduceErrors } from 'c/sharedUtils';
        import Modal from "c/detailModal";
        import { other } from 'c/sharedUtils';
        import { LightningElement } from 'lwc';
        import thing from 'lightning/navigation';
      `),
    ).toEqual(["LWC:detailModal|import", "LWC:sharedUtils|import"]);
  });

  it("links c__target: 'c:x' properties and c__target=c:x URL strings", () => {
    expect(
      refs(`
        const a = { state: { c__target: 'c:wizardStepEnglish', c__layout: 'lightning' } };
        const b = { "c__target": "c:otherTarget" };
        const url = '/lightning/cmp/ns__wrapper?c__target=c:urlTarget&c__layout=lightning';
        const t = \`/lightning/cmp/x?c__target=c:tplTarget\`;
        const n = { c__target: 'ns:managedOne' };
      `),
    ).toEqual([
      "LWC:otherTarget|c__target",
      "LWC:tplTarget|c__target",
      "LWC:urlTarget|c__target",
      "LWC:wizardStepEnglish|c__target",
    ]);
  });
});

describe("LWC object-literal custom-field keys", () => {
  it("records X__c keys on the LWC node, not datatable fieldName values", async () => {
    const r = await new LwcBundleParser().parse(
      {
        bundleName: "payloadBuilder",
        files: {
          "payloadBuilder.js": `
            const rec = { Id: x.id, Site_Remarks__c: x.r, 'Quoted_Key__c': 1, ns__Pkg_Field__c: 2 };
            const cols = [{ label: 'A', fieldName: 'Column_Only__c' }];
            const c = { [dyn]: 1 };
          `,
        },
      },
      makeTestCtx(),
    );
    const lwc = r.nodes.find((n) => n.qualifiedName === "LWC:payloadBuilder");
    expect(lwc?.attributes.recordFieldKeys).toEqual([
      "Quoted_Key__c",
      "Site_Remarks__c",
      "ns__Pkg_Field__c",
    ]);
    expect(r.edges.some((e) => e.relType === "LWC_BINDS_FIELD")).toBe(false);
  });
});
