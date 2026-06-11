import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { ApexTriggerParser } from "../trigger.js";

/**
 * Triggers previously stored NO source and got ZERO body analysis — the most
 * governor-risk-prone Salesforce artifact was invisible. These assert the
 * trigger body is now stored as a snippet (so explain_code works) and that
 * SOQL/DML edges are emitted with `inLoop` so governor_risk_check covers
 * triggers.
 */
async function parse(body: string) {
  return new ApexTriggerParser().parse(
    { triggerName: "AccountTrigger", body, metaXml: "<ApexTrigger/>" },
    makeTestCtx(),
  );
}

describe("ApexTriggerParser — body snippet + SOQL/DML analysis", () => {
  it("stores the trigger body as a snippet under the trigger qname", async () => {
    const body = `trigger AccountTrigger on Account (before insert) {
      System.debug('hi');
    }`;
    const result = await parse(body);
    expect(result.snippets).toHaveLength(1);
    expect(String(result.snippets?.[0]?.qualifiedName)).toBe("ApexTrigger:AccountTrigger");
    expect(result.snippets?.[0]?.sourceText).toContain("trigger AccountTrigger on Account");
  });

  it("emits EXECUTES_SOQL + EXECUTES_DML, stamping inLoop inside a for-loop", async () => {
    const body = `trigger AccountTrigger on Account (after update) {
      List<Contact> cs = [SELECT Id FROM Contact WHERE AccountId = :Trigger.newMap.keySet()];
      for (Account a : Trigger.new) {
        Contact c = [SELECT Id FROM Contact WHERE AccountId = :a.Id];
        update c;
      }
    }`;
    const result = await parse(body);
    const soql = result.edges.filter((e) => e.relType === "EXECUTES_SOQL");
    const dml = result.edges.filter((e) => e.relType === "EXECUTES_DML");
    // Two SOQL: one outside the loop (bulkified), one inside.
    const outside = soql.find((e) => (e.attributes as { inLoop?: boolean }).inLoop !== true);
    const inside = soql.find((e) => (e.attributes as { inLoop?: boolean }).inLoop === true);
    expect(outside).toBeDefined();
    expect(inside).toBeDefined();
    // The DML (update c) is inside the loop → governor risk.
    expect(dml.some((e) => (e.attributes as { inLoop?: boolean }).inLoop === true)).toBe(true);
    // TRIGGERS_ON still emitted.
    expect(
      result.edges.some(
        (e) => e.relType === "TRIGGERS_ON" && String(e.dstQualifiedName) === "CustomObject:Account",
      ),
    ).toBe(true);
  });

  it("empty/managed body: bare node, no snippet, no body edges", async () => {
    const result = await parse("");
    expect(result.snippets ?? []).toHaveLength(0);
    expect(result.edges.filter((e) => e.relType === "EXECUTES_SOQL")).toHaveLength(0);
  });
});
