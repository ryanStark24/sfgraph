import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { extractJsEdges } from "../js-visitor.js";

const run = (src: string) =>
  extractJsEdges(src, "LightningComponentBundle:c", makeTestCtx()).extraEdges.filter(
    (e) => e.relType === "LWC_CALLS_IP",
  );

describe("LWC_CALLS_IP", () => {
  it("emits one edge for static sMethodName on IntegrationProcedureService", () => {
    const edges = run(`
      const a = { sClassName: \`\${this._ns}IntegrationProcedureService\`, sMethodName: "Service_AssetToQuote", input: "{}" };
      const b = { sClassName: "vlocity_cmt.IntegrationProcedureService", sMethodName: name };
      const c = { sClassName: "OtherService", sMethodName: "X" };
    `);
    expect(edges.map((e) => String(e.dstQualifiedName))).toEqual([
      "IntegrationProcedure:Service_AssetToQuote",
    ]);
  });

  it("de-duplicates per bundle and handles string-literal class names", () => {
    const edges = run(`
      const a = { sClassName: "vlocity_cmt.IntegrationProcedureService", sMethodName: "A_B" };
      const b = { "sClassName": "IntegrationProcedureService", "sMethodName": "A_B" };
      const c = { sClassName: "IntegrationProcedureService", sMethodName: "C_D" };
    `);
    expect(edges.map((e) => String(e.dstQualifiedName)).sort()).toEqual([
      "IntegrationProcedure:A_B",
      "IntegrationProcedure:C_D",
    ]);
  });
});
