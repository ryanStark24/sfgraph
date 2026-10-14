import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { APEX_NODE_HASH_SALT, ApexClassParser } from "../class.js";
import { foldDynamicSoql } from "../dynamic-soql.js";
import { ApexTriggerParser } from "../trigger.js";

/**
 * Cycle 3 T7: two Apex links the flow map missed.
 *
 * 1. A dynamic query whose FROM is a variable, inside a block guarded by
 *    `if (v == 'Obj__c')`: the guard fixes the object, so the query's fields
 *    are read from that object.
 * 2. A describe of an object (`Schema.SObjectType.Obj__c…`, `Obj__c.SObjectType`):
 *    REFERENCES `CustomObject:Obj__c` with `via: "describe"`.
 */
type Edge = {
  relType: string;
  srcQualifiedName: unknown;
  dstQualifiedName: unknown;
  attributes: Record<string, unknown>;
};

async function parseClass(className: string, body: string): Promise<Edge[]> {
  const r = await new ApexClassParser().parse({ className, body }, makeTestCtx());
  expect(r.nodes.find((n) => n.label === "ParseError")).toBeUndefined();
  return r.edges as unknown as Edge[];
}

const dynamicReads = (edges: Edge[], src: string): string[] =>
  edges
    .filter(
      (e) =>
        e.relType === "READS_FIELD" &&
        String(e.srcQualifiedName) === src &&
        e.attributes.dynamic === true,
    )
    .map((e) => String(e.dstQualifiedName))
    .sort();

const describeRefs = (edges: Edge[], src: string): string[] =>
  edges
    .filter(
      (e) =>
        e.relType === "REFERENCES" &&
        String(e.srcQualifiedName) === src &&
        e.attributes.via === "describe",
    )
    .map((e) => String(e.dstQualifiedName))
    .sort();

describe("foldDynamicSoql: a FROM variable fixed by an enclosing guard", () => {
  it("binds `if (v == 'Obj__c') { … FROM ' + v … }` to the guard's object", () => {
    const src = `if (objectName == 'Acme_Region__c') {
      q = 'SELECT Id, Name FROM ' + objectName + ' WHERE Active__c = true';
    }`;
    expect(foldDynamicSoql(src)).toEqual([
      "SELECT Id, Name FROM Acme_Region__c WHERE Active__c = true",
    ]);
  });

  it("accepts the literal first, `.equals(…)`, `.equalsIgnoreCase(…)` and `&&` conjuncts", () => {
    for (const cond of [
      `'Acme_Region__c' == objectName`,
      `objectName.equals('Acme_Region__c')`,
      `objectName.equalsIgnoreCase('Acme_Region__c')`,
      `ready && objectName == 'Acme_Region__c'`,
    ]) {
      const src = `if (${cond}) { q = 'SELECT Id FROM ' + objectName; }`;
      expect(foldDynamicSoql(src), cond).toEqual(["SELECT Id FROM Acme_Region__c"]);
    }
  });

  it("leaves the FROM computed without a guard, with `||`, after a reassignment or outside the block", () => {
    for (const src of [
      `q = 'SELECT Id FROM ' + objectName;`,
      `if (objectName == 'Acme_Region__c' || other) { q = 'SELECT Id FROM ' + objectName; }`,
      `if (objectName == 'Acme_Region__c') { objectName = pick(); q = 'SELECT Id FROM ' + objectName; }`,
      `if (objectName == 'Acme_Region__c') { x = 1; } q = 'SELECT Id FROM ' + objectName;`,
      `if (otherName == 'Acme_Region__c') { q = 'SELECT Id FROM ' + objectName; }`,
    ]) {
      expect(foldDynamicSoql(src), src).toEqual(["SELECT Id FROM \u0001"]);
    }
  });

  it("does not split the guard on `(`, `||` or `&&` inside a string literal (T7 review M1)", () => {
    // A `(` in a literal must not hide the top-level `||`.
    const orSrc = `if (objectName == 'Acme_Region__c' && sep == '(' || force) { q = 'SELECT Id FROM ' + objectName; }`;
    expect(foldDynamicSoql(orSrc)).toEqual(["SELECT Id FROM \u0001"]);
    // `||` and `&&` inside a literal are not operators.
    const litSrc = `if (sep == '||' && objectName == 'Acme_Region__c' && mark == '&&') { q = 'SELECT Id FROM ' + objectName; }`;
    expect(foldDynamicSoql(litSrc)).toEqual(["SELECT Id FROM Acme_Region__c"]);
  });

  it("treats a compound assignment in the block as a reassignment", () => {
    const src = `if (objectName == 'Acme_Region') { objectName += '__c'; q = 'SELECT Id FROM ' + objectName; }`;
    expect(foldDynamicSoql(src)).toEqual(["SELECT Id FROM \u0001"]);
  });

  it("uses the innermost guard naming the variable", () => {
    const src = `if (objectName == 'Acme_Zone__c') { if (flag) { if (objectName == 'Acme_Region__c') {
      q = 'SELECT Id FROM ' + objectName; } } }`;
    expect(foldDynamicSoql(src)).toEqual(["SELECT Id FROM Acme_Region__c"]);
  });

  it("emits the guarded query's fields as dynamic reads, one object per branch", async () => {
    const edges = await parseClass(
      "AcmeLookupController",
      `public class AcmeLookupController {
        public static List<SObject> findRecords(String key, String objectName, String zone) {
          String query = '';
          if (objectName == 'Acme_Region__c') {
            query = 'SELECT Id, Name FROM ' + objectName + ' WHERE Active__c = true AND Zone__c = :zone';
          }
          if (objectName == 'Acme_Zone__c') {
            query = 'SELECT Id, Name FROM ' + objectName + ' WHERE Code__c = :key';
          }
          return Database.query(query);
        }
      }`,
    );
    expect(dynamicReads(edges, "ApexMethod:AcmeLookupController.findRecords(3)")).toEqual([
      "CustomField:Acme_Region__c.Active__c",
      "CustomField:Acme_Region__c.Id",
      "CustomField:Acme_Region__c.Name",
      "CustomField:Acme_Region__c.Zone__c",
      "CustomField:Acme_Zone__c.Code__c",
      "CustomField:Acme_Zone__c.Id",
      "CustomField:Acme_Zone__c.Name",
    ]);
  });

  it("bumps the Apex hash salt: the skipped-field count on the node changes", () => {
    expect(APEX_NODE_HASH_SALT).toBe("apex-attrs:v9");
  });

  it("still skips a guard naming something that is not an object", async () => {
    const edges = await parseClass(
      "AcmeLookupController",
      `public class AcmeLookupController {
        public static List<SObject> findRecords(String objectName) {
          String query = '';
          if (objectName == 'not an object') {
            query = 'SELECT Id FROM ' + objectName + ' WHERE Active__c = true';
          }
          return Database.query(query);
        }
      }`,
    );
    expect(dynamicReads(edges, "ApexMethod:AcmeLookupController.findRecords(1)")).toEqual([]);
  });
});

describe("ApexClassParser: object describe references", () => {
  it("links `Schema.SObjectType.X`, `SObjectType.X` and `X.SObjectType` to the object", async () => {
    const edges = await parseClass(
      "AcmeDescribeHelper",
      `public class AcmeDescribeHelper {
        public static Id billingType() {
          return Schema.SObjectType.Account.getRecordTypeInfosByName().get('Billing').getRecordTypeId();
        }
        public static Boolean canRead() {
          return SObjectType.Acme_Order__c.isAccessible() && Schema.sObjectType.Contact.fields.Email.isAccessible();
        }
        public static Schema.SObjectType token() {
          return Acme_Invoice__c.SObjectType;
        }
      }`,
    );
    expect(describeRefs(edges, "ApexMethod:AcmeDescribeHelper.billingType(0)")).toEqual([
      "CustomObject:Account",
    ]);
    expect(describeRefs(edges, "ApexMethod:AcmeDescribeHelper.canRead(0)")).toEqual([
      "CustomObject:Acme_Order__c",
      "CustomObject:Contact",
    ]);
    expect(describeRefs(edges, "ApexMethod:AcmeDescribeHelper.token(0)")).toEqual([
      "CustomObject:Acme_Invoice__c",
    ]);
  });

  it("drops the org's own namespace from a described object, and keeps another package's", async () => {
    const ctx = { ...makeTestCtx(), namespace: "acme" };
    const r = await new ApexClassParser().parse(
      {
        className: "AcmeDescribeHelper",
        body: `public class AcmeDescribeHelper {
          public static Boolean check() {
            return acme__Order__c.SObjectType != null && Schema.SObjectType.other__Thing__c.isAccessible();
          }
        }`,
      },
      ctx,
    );
    expect(
      describeRefs(r.edges as unknown as Edge[], "ApexMethod:AcmeDescribeHelper.check(0)"),
    ).toEqual(["CustomObject:Order__c", "CustomObject:other__Thing__c"]);
  });

  it("ignores describe text in strings and comments, and names that are not objects", async () => {
    const edges = await parseClass(
      "AcmeDescribeHelper",
      `public class AcmeDescribeHelper {
        public static void run(Schema.SObjectType sObjectType) {
          // Schema.SObjectType.Account.getDescribe();
          String s = 'Acme_Order__c.SObjectType';
          Schema.DescribeSObjectResult d = sObjectType.getDescribe();
          Object t = AcmeService.SObjectType;
        }
      }`,
    );
    expect(describeRefs(edges, "ApexMethod:AcmeDescribeHelper.run(1)")).toEqual([]);
  });

  it("links a describe outside methods to the class, and in a trigger to the trigger", async () => {
    const edges = await parseClass(
      "AcmeDescribeHelper",
      `public class AcmeDescribeHelper {
        static final Id RT = Schema.SObjectType.Case.getRecordTypeInfosByName().get('Support').getRecordTypeId();
      }`,
    );
    expect(describeRefs(edges, "ApexClass:AcmeDescribeHelper")).toEqual(["CustomObject:Case"]);
    const t = await new ApexTriggerParser().parse(
      {
        triggerName: "AcmeOrderTrigger",
        body: `trigger AcmeOrderTrigger on Acme_Order__c (before insert) {
          Id rt = Schema.SObjectType.Acme_Order__c.getRecordTypeInfosByName().get('Retail').getRecordTypeId();
        }`,
      },
      makeTestCtx(),
    );
    expect(describeRefs(t.edges as unknown as Edge[], "ApexTrigger:AcmeOrderTrigger")).toEqual([
      "CustomObject:Acme_Order__c",
    ]);
  });
});
