import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { ApexClassParser } from "../class.js";
import { soqlFieldRefs } from "../soql-fields.js";

/**
 * SOQL `TYPEOF <rel> WHEN <Type> THEN <fields> … [ELSE <fields>] END`: the
 * polymorphic relationship is a lookup of the FROM object (`What` -> its
 * `WhatId` field) and each WHEN branch's fields are read on that branch's
 * object. `TYPEOF` is never a field, and branch fields never land on the
 * FROM object.
 */
describe("soqlFieldRefs: TYPEOF", () => {
  it("splits a TYPEOF block into the lookup field and per-type fields", () => {
    const refs = soqlFieldRefs(
      " Id, TYPEOF What WHEN Account THEN Name, Phone WHEN Opportunity THEN Amount, Account.Name ELSE Name END, Subject FROM Event WHERE OwnerId = :u",
    );
    expect(refs.object).toBe("Event");
    expect(refs.fields).toEqual(["Id", "WhatId", "Subject", "OwnerId"]);
    expect(refs.typeOf).toEqual([
      { object: "Account", fields: ["Name", "Phone"], paths: [] },
      { object: "Opportunity", fields: ["Amount"], paths: ["Account.Name"] },
    ]);
  });

  it("a custom polymorphic relationship maps to its __c field; lowercase keywords work", () => {
    const refs = soqlFieldRefs(
      " typeof Owner when User then Email when Group then Name end FROM Case",
    );
    expect(refs.fields).toEqual(["OwnerId"]);
    expect(refs.typeOf.map((t) => t.object)).toEqual(["User", "Group"]);
  });

  it("a query without TYPEOF is unchanged", () => {
    const refs = soqlFieldRefs(" Id, Name FROM Account");
    expect(refs.fields).toEqual(["Id", "Name"]);
    expect(refs.typeOf).toEqual([]);
  });
});

describe("inline SOQL with TYPEOF (regex path)", () => {
  it("emits reads on the branch objects and no bogus Event.TYPEOF read", async () => {
    const body = `public class Ev {
      public void run() {
        List<Event> es = [SELECT TYPEOF What WHEN Account THEN Name, Phone WHEN Opportunity THEN Amount END FROM Event];
      }
    }`;
    const r = await new ApexClassParser().parse({ className: "Ev", body }, makeTestCtx());
    const reads = r.edges
      .filter((e) => e.relType === "READS_FIELD")
      .map((e) => String(e.dstQualifiedName))
      .sort();
    expect(reads).toEqual([
      "CustomField:Account.Name",
      "CustomField:Account.Phone",
      "CustomField:Event.WhatId",
      "CustomField:Opportunity.Amount",
    ]);
    const soql = r.edges
      .filter((e) => e.relType === "EXECUTES_SOQL")
      .map((e) => String(e.dstQualifiedName));
    expect(soql).toEqual(["CustomObject:Event"]);
  });
});
