import { describe, expect, it } from "vitest";
import { isFlsRelevantField } from "../security.js";

describe("isFlsRelevantField", () => {
  it("keeps custom + standard non-system fields on real objects", () => {
    expect(isFlsRelevantField("CustomField:Account.Tier__c")).toBe(true);
    expect(isFlsRelevantField("CustomField:Order.CustomThing__c")).toBe(true);
    expect(isFlsRelevantField("CustomField:Account.Industry")).toBe(true);
  });
  it("drops Custom Metadata Type fields", () => {
    expect(isFlsRelevantField("CustomField:AMS_Bulk_Template__mdt.Is_Active__c")).toBe(false);
    expect(isFlsRelevantField("CustomField:Foo__mdt.DeveloperName")).toBe(false);
  });
  it("drops standard system/audit fields on any object", () => {
    for (const f of ["Id", "CreatedById", "LastModifiedDate", "SystemModstamp", "OwnerId"]) {
      expect(isFlsRelevantField(`CustomField:Account.${f}`)).toBe(false);
    }
  });
  it("drops platform-event and big-object fields", () => {
    expect(isFlsRelevantField("CustomField:MyEvent__e.Payload__c")).toBe(false);
    expect(isFlsRelevantField("CustomField:MyBig__b.Data__c")).toBe(false);
  });
});
