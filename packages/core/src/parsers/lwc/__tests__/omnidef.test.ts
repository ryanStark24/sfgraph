import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { LwcBundleParser } from "../bundle.js";

const omnidef = {
  bpType: "Sales",
  bpSubType: "Wizard",
  bpLang: "English",
  propSetMap: { persistentComponent: [{ remoteClass: "", id: "vlcCart" }] },
  children: [
    {
      type: "Step",
      name: "Step1",
      propSetMap: { label: "Step 1" },
      children: [
        {
          eleArray: [
            {
              type: "DataRaptor Extract Action",
              name: "GetRecord",
              propSetMap: { bundle: "DRExtractSample", Record__c: "x" },
            },
            {
              type: "Custom Lightning Web Component",
              name: "Picker",
              propSetMap: { lwcName: "samplePicker" },
            },
          ],
        },
      ],
    },
    {
      type: "Integration Procedure Action",
      name: "Submit",
      propSetMap: { integrationProcedureKey: "Sales_SubmitOrder", remoteClass: "" },
    },
    {
      type: "Remote Action",
      name: "Calc",
      propSetMap: { remoteClass: "SampleRemoteCls", remoteMethod: "calc" },
    },
    {
      type: "Navigate Action",
      name: "GoNext",
      propSetMap: { targetType: "Vlocity OmniScript", targetLWC: "c:nextWizardEnglish" },
    },
    {
      type: "Navigate Action",
      name: "GoRecord",
      propSetMap: { targetType: "Record", targetLWC: "c:leftoverEnglish" },
    },
  ],
};

const edgeSet = (r: { edges: { relType: string; dstQualifiedName: unknown }[] }) =>
  r.edges
    .filter((e) => e.relType !== "CONTAINS_COMPONENT")
    .map((e) => `${e.relType} ${String(e.dstQualifiedName)}`)
    .sort();

const expected = [
  "LWC_CALLS_IP IntegrationProcedure:Sales_SubmitOrder",
  "OS_EMBEDS_LWC LWC:samplePicker",
  "OS_INVOKES_REMOTE Remote:SampleRemoteCls",
  "OS_USES_DR DataRaptor:DRExtractSample",
  "REFERENCES LWC:nextWizardEnglish",
  "REFERENCES OmniScript:Sales_Wizard_English",
];

describe("compiled-OmniScript LWC (_def.js OMNIDEF)", () => {
  it("classifies OMNIDEF elements and links the LWC to its OmniScript", async () => {
    const r = await new LwcBundleParser().parse(
      {
        bundleName: "salesWizardEnglish",
        files: {
          "salesWizardEnglish.js":
            "import { LightningElement } from 'lwc'; export default class X extends LightningElement {}",
          "salesWizardEnglish_def.js": `export const OMNIDEF = ${JSON.stringify(omnidef)};`,
        },
      },
      makeTestCtx(),
    );
    expect(edgeSet(r)).toEqual(expected);
    const os = r.edges.find(
      (e) => String(e.dstQualifiedName) === "OmniScript:Sales_Wizard_English",
    );
    expect(os?.attributes.via).toBe("compiled-omniscript");
    const lwc = r.nodes.find((n) => n.qualifiedName === "LWC:salesWizardEnglish");
    // OMNIDEF keys are not record payloads.
    expect(lwc?.attributes.recordFieldKeys).toBeUndefined();
  });

  it("decodes the chunked base64 form", async () => {
    const b64 = Buffer.from(encodeURIComponent(JSON.stringify(omnidef)), "latin1").toString(
      "base64",
    );
    const half = Math.floor(b64.length / 2);
    const r = await new LwcBundleParser().parse(
      {
        bundleName: "salesWizardEnglish",
        files: {
          "salesWizardEnglish_def.js": [
            "import { chunk0 } from './omnidef_chunk0.js';",
            "import { chunk1 } from './omnidef_chunk1.js';",
            "let def = '';",
            "def += chunk0;",
            "def += chunk1;",
            "def = decodeURIComponent(atob(def));",
            "export const OMNIDEF = JSON.parse(def);",
          ].join("\n"),
          "omnidef_chunk0.js": `export const chunk0 = "${b64.slice(0, half)}";`,
          "omnidef_chunk1.js": `export const chunk1 = "${b64.slice(half)}";`,
        },
      },
      makeTestCtx(),
    );
    expect(edgeSet(r)).toEqual(expected);
  });
});
