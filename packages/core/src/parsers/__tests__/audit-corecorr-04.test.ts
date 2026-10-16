import { describe, expect, it } from "vitest";
import { CustomObjectParser } from "../object/index.js";
import { makeTestCtx } from "./_harness.js";

/**
 * Audit corecorr-04: FORMULA_RE only matches `Obj.Field`, so bare same-object
 * field refs emit no READS_FIELD, and relationship/global names (`Owner.`,
 * `$Setup.`) are emitted as if they were object names, so the edges dangle.
 */
const field = (name: string, type: string, extra = "") => `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
  <fullName>${name}</fullName>
  <type>${type}</type>
  ${extra}
</CustomField>`;

async function formulaReads() {
  const result = await new CustomObjectParser().parse(
    {
      apiName: "Patch__c",
      objectXml: `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><label>Patch</label></CustomObject>`,
      fields: {
        Phone__c: field("Phone__c", "Text", "<length>40</length>"),
        Key__c: field(
          "Key__c",
          "Text",
          "<formula>Phone__c &amp; Owner.Region_Team__c &amp; $Setup.App_Settings__c.Code__c</formula>",
        ),
      },
    },
    makeTestCtx(),
  );
  return result.edges
    .filter(
      (e) =>
        e.relType === "READS_FIELD" && String(e.srcQualifiedName) === "CustomField:Patch__c.Key__c",
    )
    .map((e) => String(e.dstQualifiedName));
}

describe("audit corecorr-04: formula field references", () => {
  it("emits READS_FIELD for a bare same-object field reference", async () => {
    expect(await formulaReads()).toContain("CustomField:Patch__c.Phone__c");
  });

  it("does not emit relationship or $Setup names as object names", async () => {
    const reads = await formulaReads();
    expect(reads).not.toContain("CustomField:Owner.Region_Team__c");
    expect(reads.filter((d) => d.startsWith("CustomField:Setup."))).toEqual([]);
  });

  it("review I-3: an Owner. hop reads the owner lookup and the User field", async () => {
    const reads = await formulaReads();
    expect(reads).toContain("CustomField:Patch__c.OwnerId");
    expect(reads).toContain("CustomField:User.Region_Team__c");
  });
});
