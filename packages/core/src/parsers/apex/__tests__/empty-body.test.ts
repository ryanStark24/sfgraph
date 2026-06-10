import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { ApexClassParser } from "../class.js";
import { ApexTriggerParser } from "../trigger.js";

/**
 * Managed-package Apex (NamespacePrefix set) has its Body stubbed to "" by the
 * live extractor (see extractors/live-org/extractors/apex.ts). An empty body is
 * NOT a parse failure — the member exists, we just can't see its source. The
 * parser must emit a bare node (so referencing edges resolve to a real target)
 * instead of a misleading ParseError node.
 */
describe("Apex parsers: empty/stub body emits a bare node, not a ParseError", () => {
  it("ApexClassParser: empty body -> bare ApexClass node, no ParseError", async () => {
    const result = await new ApexClassParser().parse(
      { className: "ManagedThing", body: "" },
      makeTestCtx(),
    );
    const parseErr = result.nodes.find((n) => n.label === "ParseError");
    expect(parseErr).toBeUndefined();
    const cls = result.nodes.find((n) => n.label === "ApexClass");
    expect(cls).toBeDefined();
    expect(String(cls?.qualifiedName)).toBe("ApexClass:ManagedThing");
  });

  it("ApexClassParser: whitespace-only body -> bare node, no ParseError", async () => {
    const result = await new ApexClassParser().parse(
      { className: "ManagedThing", body: "   \n\t  " },
      makeTestCtx(),
    );
    expect(result.nodes.find((n) => n.label === "ParseError")).toBeUndefined();
    expect(result.nodes.find((n) => n.label === "ApexClass")).toBeDefined();
  });

  it("ApexTriggerParser: empty body -> bare ApexTrigger node, no ParseError", async () => {
    const result = await new ApexTriggerParser().parse(
      { triggerName: "ManagedTrigger", body: "" },
      makeTestCtx(),
    );
    const parseErr = result.nodes.find((n) => n.label === "ParseError");
    expect(parseErr).toBeUndefined();
    const trg = result.nodes.find((n) => n.label === "ApexTrigger");
    expect(trg).toBeDefined();
    expect(String(trg?.qualifiedName)).toBe("ApexTrigger:ManagedTrigger");
  });

  it("ApexClassParser: real body still parses into ApexClass + ApexMethod", async () => {
    const result = await new ApexClassParser().parse(
      { className: "Foo", body: "public class Foo { public void bar(){} }" },
      makeTestCtx(),
    );
    expect(result.nodes.find((n) => n.label === "ParseError")).toBeUndefined();
    expect(result.nodes.find((n) => n.label === "ApexClass")).toBeDefined();
  });
});
