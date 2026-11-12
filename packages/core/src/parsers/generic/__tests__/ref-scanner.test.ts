import { describe, expect, it } from "vitest";
import {
  MAX_CANDIDATES,
  SCAN_MAX_CHARS,
  SCAN_MAX_LEAVES,
  scanGenericRefs,
} from "../ref-scanner.js";

const names = (r: ReturnType<typeof scanGenericRefs>, k?: string) =>
  r.candidates.filter((c) => !k || c.k === k).map((c) => c.n);

describe("generic reference scanner", () => {
  it("finds object, Apex, flow and field candidates in a JSON body with element paths", () => {
    const body = JSON.stringify({
      fullName: "Thing",
      config: {
        objectName: "Case",
        steps: [
          { apexClassName: "TierService", flowName: "Escalate_Case" },
          { target: "Order__c" },
        ],
        field: "Status",
        note: "see Acme__Widget__c and Account.Tier__c",
      },
    });
    const r = scanGenericRefs(body);
    expect(names(r, "object")).toEqual(
      expect.arrayContaining(["Case", "Order__c", "Acme__Widget__c"]),
    );
    expect(names(r, "apex")).toEqual(["TierService"]);
    expect(names(r, "flow")).toEqual(["Escalate_Case"]);
    expect(names(r, "name")).toContain("Order__c");
    // bare field name is attached to the object named in the same body
    expect(names(r, "field")).toEqual(expect.arrayContaining(["Case.Status", "Account.Tier__c"]));
    const apex = r.candidates.find((c) => c.k === "apex");
    expect(apex?.p).toBe("config/steps/apexClassName");
    expect(r.truncated).toBe(false);
  });

  it("finds candidates in XML element text and attributes", () => {
    const xml = `<?xml version="1.0"?><Thing xmlns="http://soap.sforce.com/2006/04/metadata">
      <targetObject>Invoice__c</targetObject>
      <action actionName="BillingHandler" other="x"/>
      <formula><![CDATA[{!Invoice__c.Amount__c} > 0]]></formula>
    </Thing>`;
    const r = scanGenericRefs(xml);
    expect(names(r, "object")).toContain("Invoice__c");
    expect(names(r, "name")).toContain("BillingHandler");
    expect(names(r, "field")).toContain("Invoice__c.Amount__c");
    expect(r.candidates.find((c) => c.n === "BillingHandler")?.p).toBe("Thing/action@actionName");
  });

  it("understands merge field forms", () => {
    const r = scanGenericRefs(
      JSON.stringify({
        sObject: "Opportunity",
        a: "{!$Record.StageName}",
        b: "{!Account.Name}",
        c: "{!$Input:Contact.Email}",
        d: "Hello {!$Record__Prior.Amount} {!$Label.Foo.Bar}",
      }),
    );
    expect(names(r, "field")).toEqual(
      expect.arrayContaining([
        "Opportunity.StageName",
        "Account.Name",
        "Contact.Email",
        "Opportunity.Amount",
      ]),
    );
    expect(names(r, "field")).not.toContain("$Label.Foo");
  });

  it("uses a generic __xxx suffix pattern, not a fixed list", () => {
    const r = scanGenericRefs(JSON.stringify({ x: "uses Foo__zzz and ns__Bar__mdt and Baz__xy" }));
    expect(names(r, "object")).toEqual(
      expect.arrayContaining(["Foo__zzz", "ns__Bar__mdt", "Baz__xy"]),
    );
  });

  it("dedupes and caps the candidate list", () => {
    const many = Array.from({ length: 600 }, (_, i) => ({ objectName: `Obj${i}__c` }));
    const r = scanGenericRefs(JSON.stringify({ items: many, dup: [{ objectName: "Obj1__c" }] }));
    expect(r.candidates.length).toBe(MAX_CANDIDATES);
    expect(r.truncated).toBe(true);
    expect(new Set(r.candidates.map((c) => c.n.toLowerCase())).size).toBe(r.candidates.length);
  });

  it("stops after the text budget", () => {
    const big = "x".repeat(64 * 1024);
    const items = Array.from({ length: 10 }, (_, i) => ({ note: big, objectName: `Late${i}__c` }));
    const r = scanGenericRefs(JSON.stringify(items));
    expect(r.truncated).toBe(true);
    // 256 KB of text is ~4 items of 64 KB: the later objects are never read
    expect(names(r, "object").length).toBeLessThan(10);
    expect(SCAN_MAX_CHARS).toBe(256 * 1024);
  });

  it("stops after the leaf budget", () => {
    const leaves = Array.from({ length: SCAN_MAX_LEAVES + 500 }, (_, i) => ({ v: `leaf ${i}` }));
    leaves.push({ v: "Never__c" });
    const r = scanGenericRefs(JSON.stringify(leaves));
    expect(r.truncated).toBe(true);
    expect(names(r)).not.toContain("Never__c");
  });

  it("is tolerant: bad JSON, bad XML, empty and plain text never throw", () => {
    expect(scanGenericRefs("").candidates).toEqual([]);
    expect(scanGenericRefs(null).candidates).toEqual([]);
    expect(() => scanGenericRefs("{not json")).not.toThrow();
    expect(() => scanGenericRefs("<a><b></a>")).not.toThrow();
    expect(names(scanGenericRefs("plain Thing__c text"), "object")).toEqual(["Thing__c"]);
  });

  it("ignores reserved words under key heuristics", () => {
    const r = scanGenericRefs(
      JSON.stringify({ objectName: "true", target: "null", flowName: "value" }),
    );
    expect(r.candidates).toEqual([]);
  });
});
