import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { ApexClassParser } from "../class.js";

/**
 * S-1.8.1-010: a same-class helper `setField(SObject rec, String f, Object v)
 * { rec.put(f, v); }` writes the literal field of each call site, on the
 * record type of the argument at that call site. Nothing is guessed.
 */
type Edge = {
  relType: string;
  srcQualifiedName: unknown;
  dstQualifiedName: unknown;
  attributes: Record<string, unknown>;
};

async function parse(body: string) {
  const r = await new ApexClassParser().parse({ className: "OrderService", body }, makeTestCtx());
  return r.edges as unknown as Edge[];
}
const writes = (edges: Edge[], src: string) =>
  edges
    .filter((e) => e.relType === "WRITES_FIELD" && String(e.srcQualifiedName) === src)
    .map((e) => String(e.dstQualifiedName))
    .sort();

const HELPER = "static void setField(SObject rec, String f, Object v) { rec.put(f, v); }";

describe("put helper one-hop propagation", () => {
  it("writes the literal field on the typed argument's sObject", async () => {
    const edges = await parse(`public class OrderService {
      ${HELPER}
      public void run(Acme_Order__c order, Object x) {
        setField(order, 'Status__c', x);
        OrderService.setField(order, 'Region__c', x);
      }
    }`);
    expect(writes(edges, "ApexMethod:OrderService.run(2)")).toEqual([
      "CustomField:Acme_Order__c.Region__c",
      "CustomField:Acme_Order__c.Status__c",
    ]);
    const e = edges.find(
      (x) => String(x.dstQualifiedName) === "CustomField:Acme_Order__c.Status__c",
    );
    expect(e?.attributes.via).toBe("sobject-put-helper");
    // The helper itself writes nothing (its field name is a parameter).
    expect(writes(edges, "ApexMethod:OrderService.setField(3)")).toEqual([]);
  });

  it("writes a typed local (new Acme_Order__c()) too", async () => {
    const edges = await parse(`public class OrderService {
      ${HELPER}
      public void run(Object x) {
        Acme_Order__c o = new Acme_Order__c();
        setField(o, 'Status__c', x);
      }
    }`);
    expect(writes(edges, "ApexMethod:OrderService.run(1)")).toEqual([
      "CustomField:Acme_Order__c.Status__c",
    ]);
  });

  it("emits nothing for a variable field name or an untyped SObject argument", async () => {
    const edges = await parse(`public class OrderService {
      ${HELPER}
      public void run(Acme_Order__c order, SObject any, String name, Object x) {
        setField(order, name, x);
        setField(any, 'Status__c', x);
        setField(unknownVar, 'Status__c', x);
      }
    }`);
    expect(writes(edges, "ApexMethod:OrderService.run(4)")).toEqual([]);
  });

  it("drops ambiguous overloads of the same name and arity", async () => {
    const edges = await parse(`public class OrderService {
      ${HELPER}
      static void setField(SObject rec, String f, Integer v) { }
      public void run(Acme_Order__c order, Object x) {
        setField(order, 'Status__c', x);
      }
    }`);
    expect(writes(edges, "ApexMethod:OrderService.run(2)")).toEqual([]);
  });

  it("ignores a Map receiver (cache helper)", async () => {
    const edges = await parse(`public class OrderService {
      static void cache(Map<String, Account> records, String key, Account value) { records.put(key, value); }
      public void run(Map<String, Account> records, Account acc) {
        cache(records, 'Status__c', acc);
      }
    }`);
    expect(writes(edges, "ApexMethod:OrderService.run(2)")).toEqual([]);
  });

  it("an earlier non-writing overload of the same name and arity makes the helper ambiguous", async () => {
    const edges = await parse(`public class OrderService {
      static void setField(SObject rec, String f, Integer v) { }
      ${HELPER}
      public void run(Acme_Order__c order, Object x) {
        setField(order, 'Status__c', x);
      }
    }`);
    expect(writes(edges, "ApexMethod:OrderService.run(2)")).toEqual([]);
  });

  it("does not treat a call on another receiver as a bare call", async () => {
    const edges = await parse(`public class OrderService {
      ${HELPER}
      static OrderService getOther() { return null; }
      public void run(Acme_Order__c order, Object x) {
        getOther().setField(order, 'Status__c', x);
        this.setField(order, 'Region__c', x);
      }
    }`);
    expect(writes(edges, "ApexMethod:OrderService.run(2)")).toEqual([
      "CustomField:Acme_Order__c.Region__c",
    ]);
  });
});
