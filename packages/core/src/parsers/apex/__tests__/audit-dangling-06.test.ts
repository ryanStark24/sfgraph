import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { countCallArgs } from "../class-refs.js";
import { ApexClassParser } from "../index.js";

/**
 * Audit dangling-06: commas inside generic type arguments inflate arity,
 * both for declarations (parseParams naive split) and call sites
 * (countCallArgs counts commas at paren depth 1 inside `<...>`).
 */
async function parse(className: string, body: string) {
  return new ApexClassParser().parse({ className, body, metaXml: "<ApexClass/>" }, makeTestCtx());
}

describe("audit dangling-06: generic commas do not inflate arity", () => {
  it("declares a 4-param method with Map<Id,X> params as arity 4", async () => {
    const result = await parse(
      "SyncHelper",
      `
      public class SyncHelper {
        public static void buildRequests(List<Contact> cs, Map<Id, Contact> oldMap, Map<Id, Account> accts, String opType) {}
      }
    `,
    );
    const methods = result.nodes
      .map((n) => String(n.qualifiedName))
      .filter((q) => q.startsWith("ApexMethod:SyncHelper.buildRequests("));
    expect(methods).toEqual(["ApexMethod:SyncHelper.buildRequests(4)"]);
  });

  it("counts a call with a generic constructor argument as arity 2", async () => {
    const result = await parse(
      "Caller",
      `
      public class Caller {
        public void go(List<Contact> cs) {
          SyncHelper.buildPair(new Map<Id, Contact>(), cs);
        }
      }
    `,
    );
    const calls = result.edges
      .filter((e) => e.relType === "CALLS")
      .map((e) => String(e.dstQualifiedName))
      .filter((d) => d.startsWith("ApexMethod:SyncHelper.buildPair("));
    expect(calls).toEqual(["ApexMethod:SyncHelper.buildPair(2)"]);
  });

  it("review M-5: unspaced relational pairs are not read as type arguments", () => {
    const n = (call: string) => countCallArgs(call, call.indexOf("("));
    expect(n("f(i<n, j>m)")).toBe(2);
    expect(n("f(i<n, j>(m))")).toBe(2);
    // Real type-argument lists inside call args still keep their commas.
    expect(n("f(new Map<Id, Contact>(), cs)")).toBe(2);
    expect(n("f((Map<Id, Contact>) o, x)")).toBe(2);
    expect(n("f(JSON.deserialize(s, Map<Id, Contact>.class), x)")).toBe(2);
    expect(n("f(new List<Map<Id, X>>{ a, b }, x)")).toBe(2);
  });
});
