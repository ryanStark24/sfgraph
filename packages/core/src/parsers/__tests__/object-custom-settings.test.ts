import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CustomObjectParser } from "../object/index.js";
import { makeTestCtx } from "./_harness.js";

/**
 * Hand-off from the analyze batch: the CustomObject node carries
 * `customSettingsType` (`List` / `Hierarchy`) so analyze can tell custom
 * settings from data objects.
 */
const xml = (inner: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><label>X</label>${inner}</CustomObject>`;

async function objNode(apiName: string, objectXml: string) {
  const r = await new CustomObjectParser().parse({ apiName, objectXml, fields: {} }, makeTestCtx());
  return r.nodes.find((n) => String(n.qualifiedName) === `CustomObject:${apiName}`);
}

describe("CustomObject customSettingsType", () => {
  it("copies <customSettingsType> into the node attrs", async () => {
    const n = await objNode(
      "App_Settings__c",
      xml("<customSettingsType>Hierarchy</customSettingsType><visibility>Public</visibility>"),
    );
    expect(n?.attributes.customSettingsType).toBe("Hierarchy");
  });

  it("leaves it absent on ordinary objects", async () => {
    const n = await objNode("Patch__c", xml("<sharingModel>ReadWrite</sharingModel>"));
    expect(n?.attributes.customSettingsType).toBeUndefined();
  });

  it("salts the node hash so a re-ingest of unchanged XML refreshes the attrs", async () => {
    const objectXml = xml("<customSettingsType>List</customSettingsType>");
    const n = await objNode("S__c", objectXml);
    expect(n?.sourceHash).not.toBe(createHash("sha256").update(objectXml).digest("hex"));
  });
});
