import { describe, expect, it, vi } from "vitest";
import { memberNameFor, normaliseRow } from "../row.js";

describe("memberNameFor", () => {
  it("OmniScript uses Type_SubType_Language", () => {
    expect(
      memberNameFor("OmniScript", {
        Id: "a1",
        Type: "Change",
        SubType: "BulkRetention",
        Language: "English",
      }),
    ).toBe("Change_BulkRetention_English");
  });
  it("IntegrationProcedure uses Type_SubType; Language 'Procedure' is ignored", () => {
    expect(
      memberNameFor("IntegrationProcedure", {
        Id: "a2",
        Type: "Shop",
        SubType: "Checkout",
        Language: "Procedure",
      }),
    ).toBe("Shop_Checkout");
    expect(
      memberNameFor("IntegrationProcedure", { Id: "a2", Type: "Shop", SubType: "Checkout" }),
    ).toBe("Shop_Checkout");
  });
  it("falls back to Name/Id with a callback when keys are missing", () => {
    const cb = vi.fn();
    expect(memberNameFor("OmniScript", { Id: "a3" }, cb)).toBe("a3");
    expect(cb).toHaveBeenCalledWith("a3");
  });
  it("other types use Name", () => {
    expect(memberNameFor("DataRaptor", { Id: "x", Name: "AcmeGetAccount" })).toBe("AcmeGetAccount");
  });
});

describe("normaliseRow", () => {
  it("strips %vlocity_namespace% prefix and __c, decodes PropertySet", () => {
    const r = normaliseRow(
      {
        "%vlocity_namespace%__Type__c": "Remote Action",
        "%vlocity_namespace%__PropertySet__c": '{"remoteClass":"X"}',
      },
      "%vlocity_namespace%",
    );
    expect(r.Type).toBe("Remote Action");
    expect(r.propertySet).toEqual({ remoteClass: "X" });
  });
});
