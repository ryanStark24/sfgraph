import { describe, expect, it } from "vitest";
import { formulaFieldRefs } from "../object/formula-refs.js";

const fields = [
  { apiName: "Phone__c", referenceTo: [], relationshipName: null },
  { apiName: "Name", referenceTo: [], relationshipName: null },
  { apiName: "Region__c", referenceTo: ["Region__c"], relationshipName: "Region" },
  { apiName: "OwnerId", referenceTo: ["User", "Group"], relationshipName: "Owner" },
];

describe("formulaFieldRefs (corecorr-04)", () => {
  it("resolves bare fields, single-target lookup hops and skips functions/strings", () => {
    const r = formulaFieldRefs(
      'IF(ISBLANK(Phone__c), Name & "Fake__c", Region__r.Code__c) & TEXT(TRUE)',
      "Patch__c",
      fields,
    );
    expect(r.fields.sort()).toEqual(
      ["Patch__c.Name", "Patch__c.Phone__c", "Patch__c.Region__c", "Region__c.Code__c"].sort(),
    );
  });

  it("reads a multi-target custom lookup field but never invents its target object", () => {
    const poly = [
      { apiName: "What__c", referenceTo: ["Account", "Case"], relationshipName: "What" },
    ];
    expect(formulaFieldRefs("What__r.Name", "Patch__c", poly).fields).toEqual(["Patch__c.What__c"]);
  });

  it("audit I-3: Owner/CreatedBy/LastModifiedBy hops are User fields plus the owning lookup", () => {
    // Formula syntax: a bare `Owner.` / `CreatedBy.` / `LastModifiedBy.` hop is always
    // User (queue owners must be written `Owner:Queue.X`), so the target is deterministic.
    const r = formulaFieldRefs("Owner.Region_Team__c", "Patch__c", fields);
    expect(r.fields.sort()).toEqual(["Patch__c.OwnerId", "User.Region_Team__c"]);
    const c = formulaFieldRefs("CreatedBy.Email & LastModifiedBy.Alias", "Contact", []);
    expect(c.fields.sort()).toEqual(
      ["Contact.CreatedById", "Contact.LastModifiedById", "User.Alias", "User.Email"].sort(),
    );
    // Longer chains stop after the first hop: the relationship field read on User.
    const m = formulaFieldRefs("Owner.Manager.Name & Owner.Team__r.Code__c", "Account", []);
    expect(m.fields.sort()).toEqual(["Account.OwnerId", "User.ManagerId", "User.Team__c"].sort());
  });

  it("maps $Setup, $CustomMetadata, $User and $Label to their own targets", () => {
    const r = formulaFieldRefs(
      "$Setup.App__c.Code__c & $CustomMetadata.Cfg__mdt.Rec1.Val__c & $User.Email & $Label.Greeting",
      "Patch__c",
      fields,
    );
    expect(r.fields.sort()).toEqual(["App__c.Code__c", "Cfg__mdt.Val__c", "User.Email"].sort());
    expect(r.labels).toEqual(["Greeting"]);
  });

  it("falls back to the standard-object convention only for standard SObject names", () => {
    expect(formulaFieldRefs("Account.Name", "Contact", []).fields).toEqual(["Account.Name"]);
    expect(formulaFieldRefs("Foo.Name", "Contact", []).fields).toEqual([]);
  });

  it("review M-7: ignores fields named only inside /* */ comments", () => {
    const r = formulaFieldRefs(
      '/* old: Legacy__c */ Phone__c & "/* not a comment */"',
      "Patch__c",
      fields,
    );
    expect(r.fields).toEqual(["Patch__c.Phone__c"]);
  });

  it("review N-6: a second hop uses the field that declares the relationship name", () => {
    const own = [
      { apiName: "Parent_Patch__c", referenceTo: ["Patch__c"], relationshipName: "ParentPatch" },
      {
        apiName: "Primary_Contact__c",
        referenceTo: ["Contact"],
        relationshipName: "PrimaryContact",
      },
      { apiName: "Region__c", referenceTo: ["Region__c"], relationshipName: "Region" },
    ];
    // Self-lookup: the target's fields are this object's, so the hop is exact.
    const self = formulaFieldRefs("ParentPatch__r.PrimaryContact__r.Email", "Patch__c", own);
    expect(self.fields.sort()).toEqual(["Patch__c.Parent_Patch__c", "Patch__c.Primary_Contact__c"]);
    expect(self.hops).toEqual({});
    // Another object: the parser can only fall back to `X__c`, and marks the
    // edge so the post-merge hop resolver can swap in the declaring field.
    const other = formulaFieldRefs("Region__r.Area_Lead__r.Email", "Patch__c", own);
    expect(other.fields.sort()).toEqual(["Patch__c.Region__c", "Region__c.Area_Lead__c"]);
    expect(other.hops).toEqual({ "Region__c.Area_Lead__c": "Area_Lead__r" });
  });

  it("review N-6: $User chains stop at the relationship field like Owner.", () => {
    expect(formulaFieldRefs("$User.Manager.Name", "Patch__c", fields).fields).toEqual([
      "User.ManagerId",
    ]);
  });
});
