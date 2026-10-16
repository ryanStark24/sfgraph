import { asOrgId } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import type { ParseContext } from "../../contract.js";
import { OpaqueNodeParser } from "../opaque-node-parser.js";

const ctx = { orgId: asOrgId("org1"), namespace: null } as unknown as ParseContext;
const parse = (metadataType: string, name: string) =>
  new OpaqueNodeParser().parse({ metadataType, name, raw: "<x/>" }, ctx);

describe("OpaqueNodeParser names", () => {
  it("names a message channel without __c, whichever form the source gave", async () => {
    // Source files say `Record_Selected`; imports (and the Metadata API) say
    // `Record_Selected__c`. LWC / Aura edges point at the bare name.
    for (const name of ["Record_Selected", "Record_Selected__c"]) {
      const { nodes } = await parse("LightningMessageChannel", name);
      expect(String(nodes[0]?.qualifiedName)).toBe("LightningMessageChannel:Record_Selected");
    }
  });

  it("keeps __c on other types", async () => {
    const { nodes } = await parse("CustomTab", "Invoice__c");
    expect(String(nodes[0]?.qualifiedName)).toBe("CustomTab:Invoice__c");
  });
});
