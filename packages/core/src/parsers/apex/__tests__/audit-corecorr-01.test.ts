import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { ApexClassParser } from "../index.js";

/**
 * Audit corecorr-01: the class-header regex cannot cross `<` in a generic
 * implements/extends clause, so the outer class takes its inner class's name
 * and loses its IMPLEMENTS edge.
 */
async function parse(className: string, body: string) {
  return new ApexClassParser().parse({ className, body, metaXml: "<ApexClass/>" }, makeTestCtx());
}

describe("audit corecorr-01: generic implements clause", () => {
  it("names the outer class (not its inner class) and emits IMPLEMENTS Database.Batchable", async () => {
    const result = await parse(
      "BatchJob",
      `
      global class BatchJob implements Database.Batchable<SObject> {
        class Wrap { String a; }
        global Database.QueryLocator start(Database.BatchableContext bc) { return null; }
        global void execute(Database.BatchableContext bc, List<SObject> scope) {}
        global void finish(Database.BatchableContext bc) {}
      }
    `,
    );
    const qnames = result.nodes.map((n) => String(n.qualifiedName));
    expect(qnames).toContain("ApexClass:BatchJob");
    expect(qnames).not.toContain("ApexClass:Wrap");
    expect(qnames.some((q) => q.startsWith("ApexMethod:BatchJob.start("))).toBe(true);
    const impl = result.edges.filter(
      (e) => e.relType === "IMPLEMENTS" && String(e.srcQualifiedName) === "ApexClass:BatchJob",
    );
    expect(impl.map((e) => String(e.dstQualifiedName)).join(",")).toMatch(/Batchable/);
  });

  it("review M-9: an interface extending several interfaces keeps every one", async () => {
    const result = await parse(
      "Both",
      "public interface Both extends Readable, Svc.Writable<Id> {}",
    );
    const ext = result.edges
      .filter((e) => e.relType === "EXTENDS")
      .map((e) => String(e.dstQualifiedName))
      .sort();
    expect(ext).toEqual(["ApexInterface:Readable", "ApexInterface:Svc.Writable"]);
  });
});
