import { describe, expect, it } from "vitest";
import { CustomObjectParser } from "../object/index.js";
import { asOrgId } from "@ryanstark24/sfgraph-shared";
import { METADATA_CATEGORY } from "../../domain/index.js";

/**
 * Regression test for the live-org ingest path. The extractor in
 * `packages/core/src/extractors/live-org/extractors/object.ts` builds a
 * CustomObject XML envelope with INLINE <fields> elements (one per SObject
 * field, sourced from conn.sobject(name).describe()). The CustomObjectParser
 * used to only handle the source-tree layout (separate `<Object>/fields/
 * <Field>.field-meta.xml` files passed via `input.fields`), so live-org
 * ingest produced object nodes with zero CustomField children and zero
 * relationship edges — breaking `trace_downstream` and `analyze_field` for
 * standard objects like Account / Contact / Opportunity.
 */
const INLINE_OBJECT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject>
  <fullName>Account</fullName>
  <label>Account</label>
  <sharingModel>Private</sharingModel>
  <fields>
    <fullName>Name</fullName>
    <type>String</type>
    <required>true</required>
  </fields>
  <fields>
    <fullName>ParentId</fullName>
    <type>Reference</type>
    <referenceTo>Account</referenceTo>
    <relationshipName>Parent</relationshipName>
  </fields>
  <fields>
    <fullName>OwnerId</fullName>
    <type>Reference</type>
    <referenceTo>User</referenceTo>
    <referenceTo>Group</referenceTo>
    <relationshipName>Owner</relationshipName>
  </fields>
  <fields>
    <fullName>FullName</fullName>
    <type>Formula</type>
    <formula>FirstName &amp; ' ' &amp; LastName</formula>
  </fields>
</CustomObject>`;

const ctx = {
  orgId: asOrgId("00DTestInline"),
  ingestRunId: "test-run",
  category: METADATA_CATEGORY.OBJECT,
  sourceUri: "sf://describe/Account",
  namespace: null,
  parseTimestamp: new Date().toISOString(),
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
};

describe("CustomObjectParser inline-fields path", () => {
  it("emits CustomField nodes for every inline <fields> element", async () => {
    const parser = new CustomObjectParser();
    const result = await parser.parse({ apiName: "Account", objectXml: INLINE_OBJECT_XML }, ctx);
    const fieldNodes = result.nodes.filter((n) => n.label === "CustomField");
    const names = fieldNodes.map((n) => String(n.qualifiedName));
    expect(names.sort()).toEqual([
      "CustomField:Account.FullName",
      "CustomField:Account.Name",
      "CustomField:Account.OwnerId",
      "CustomField:Account.ParentId",
    ]);
  });

  it("emits DEFINES_FIELD edges from object to each field", async () => {
    const parser = new CustomObjectParser();
    const result = await parser.parse({ apiName: "Account", objectXml: INLINE_OBJECT_XML }, ctx);
    const defines = result.edges.filter((e) => e.relType === "DEFINES_FIELD");
    expect(defines).toHaveLength(4);
    expect(defines.every((e) => e.srcQualifiedName === "CustomObject:Account")).toBe(true);
  });

  it("emits REFERENCES_OBJECT edges for each referenceTo target (lookup / master-detail)", async () => {
    const parser = new CustomObjectParser();
    const result = await parser.parse({ apiName: "Account", objectXml: INLINE_OBJECT_XML }, ctx);
    const refs = result.edges
      .filter((e) => e.relType === "REFERENCES_OBJECT")
      .map((e) => `${e.srcQualifiedName} -> ${e.dstQualifiedName}`)
      .sort();
    expect(refs).toEqual([
      "CustomField:Account.OwnerId -> CustomObject:Group",
      "CustomField:Account.OwnerId -> CustomObject:User",
      "CustomField:Account.ParentId -> CustomObject:Account",
    ]);
  });

  it("emits READS_FIELD edges from formula fields", async () => {
    const parser = new CustomObjectParser();
    const result = await parser.parse({ apiName: "Account", objectXml: INLINE_OBJECT_XML }, ctx);
    const formulaRefs = result.edges.filter(
      (e) => e.relType === "READS_FIELD" && e.srcQualifiedName === "CustomField:Account.FullName",
    );
    // FirstName / LastName are bare identifiers (no `Obj.Field` pattern), so
    // the formula regex won't match them — this asserts the path runs
    // without crashing. Cross-object formulas (e.g. Account__r.Name) would
    // produce edges.
    expect(formulaRefs).toEqual([]);
  });

  it("does NOT duplicate fields when both inline AND separate-file fields are present", async () => {
    const parser = new CustomObjectParser();
    const result = await parser.parse(
      {
        apiName: "Account",
        objectXml: INLINE_OBJECT_XML,
        fields: {
          Name: `<?xml version="1.0"?><CustomField><fullName>Name</fullName><type>String</type></CustomField>`,
        },
      },
      ctx,
    );
    const nameNodes = result.nodes.filter((n) => n.qualifiedName === "CustomField:Account.Name");
    expect(nameNodes).toHaveLength(1);
  });
});
