import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { FlowParser } from "../parser.js";

/**
 * Task 14 batch P, rule 8: a Process Builder process (`processType`
 * Workflow) has no `<start><object>`; its object is the top-level
 * `processMetadataValues` entry named `ObjectType`.
 */
const flow = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Flow xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>49.0</apiVersion>${body}</Flow>`;
const pmv = (name: string, value: string) =>
  `<processMetadataValues><name>${name}</name><value><stringValue>${value}</stringValue></value></processMetadataValues>`;

const fires = async (xml: string) => {
  const r = await new FlowParser().parse({ fullName: "PB_One", xml }, makeTestCtx());
  return r.edges
    .filter((e) => e.relType === "TRIGGER_FIRES_ON")
    .map((e) => {
      const { sourceUri: _uri, ...attrs } = e.attributes as Record<string, unknown>;
      return { dst: String(e.dstQualifiedName), attrs };
    });
};

describe("Process Builder object", () => {
  it("reads processMetadataValues ObjectType for processType Workflow", async () => {
    const got = await fires(
      flow(
        `${pmv("ObjectType", "Service_Request__c")}${pmv("TriggerType", "onAllChanges")}<processType>Workflow</processType><startElementReference>myDecision</startElementReference>`,
      ),
    );
    expect(got).toEqual([
      {
        dst: "CustomObject:Service_Request__c",
        attrs: { triggerType: null, recordTriggerType: null, processTriggerType: "onAllChanges" },
      },
    ]);
  });

  it("ignores ObjectType outside Workflow processes and nested element metadata", async () => {
    expect(
      await fires(
        flow(`${pmv("ObjectType", "Account")}<processType>AutoLaunchedFlow</processType>`),
      ),
    ).toEqual([]);
    expect(
      await fires(
        flow(
          `<processType>Workflow</processType><recordUpdates><name>u</name>${pmv("ObjectType", "Case")}</recordUpdates>`,
        ),
      ),
    ).toEqual([]);
  });
});
