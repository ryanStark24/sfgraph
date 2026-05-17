import { describe, expect, it } from "vitest";
import { ApexClassParser } from "../index.js";
import { makeTestCtx } from "../../__tests__/_harness.js";

async function callsFromBody(body: string) {
  const result = await new ApexClassParser().parse(
    { className: "Caller", body, metaXml: "<ApexClass/>" },
    makeTestCtx(),
  );
  return result.edges
    .filter((e) => e.relType === "CALLS")
    .map((e) => ({
      dst: String(e.dstQualifiedName),
      arity: e.attributes.arity,
      resolvedBy: e.attributes.resolvedBy,
      unresolvedArity: e.attributes.unresolvedArity,
    }));
}

describe("W1-04: regex-mode arg counting in Apex CALLS emission", () => {
  it("counts a simple two-arg call", async () => {
    const body = `
      public class Caller {
        public void run() {
          Util.doWork(account, 42);
        }
      }
    `;
    const calls = await callsFromBody(body);
    const c = calls.find((e) => e.dst === "ApexMethod:Util.doWork(2)");
    expect(c).toBeDefined();
    expect(c?.arity).toBe(2);
    expect(c?.resolvedBy).toBe("regex-arg-count");
  });

  it("counts zero args correctly (no commas, no content)", async () => {
    const body = `
      public class Caller {
        public void run() {
          Util.init();
        }
      }
    `;
    const calls = await callsFromBody(body);
    const c = calls.find((e) => e.dst === "ApexMethod:Util.init(0)");
    expect(c).toBeDefined();
    expect(c?.arity).toBe(0);
  });

  // NOTE: String literals are stripped (replaced with a single space) by
  // stripCommentsAndStrings *before* the regex pass runs, so the arity
  // counter never sees commas-inside-strings. A call whose only arg is
  // a string literal becomes `Util.log( )` after stripping and counts
  // as arity 0 — a known regex-mode precision limit. Set
  // SFGRAPH_APEX_PARSER=ast for precise arity on those calls.

  it("does not double-count commas inside nested calls", async () => {
    const body = `
      public class Caller {
        public void run() {
          Util.combine(Inner.make(a, b), Inner.make(c, d));
        }
      }
    `;
    const calls = await callsFromBody(body);
    const c = calls.find((e) => e.dst === "ApexMethod:Util.combine(2)");
    expect(c).toBeDefined();
    expect(c?.arity).toBe(2);
  });

  it("does not double-count commas inside block comments", async () => {
    const body = `
      public class Caller {
        public void run() {
          Util.run(a /* note, with, commas */, b);
        }
      }
    `;
    const calls = await callsFromBody(body);
    const c = calls.find((e) => e.dst === "ApexMethod:Util.run(2)");
    expect(c).toBeDefined();
    expect(c?.arity).toBe(2);
  });

  // NOTE: truncated/unbalanced source never reaches the regex pass —
  // apex-parser's ThrowingErrorListener emits a ParseError node first and
  // returns empty edges (class.ts:292-303). countCallArgs returning null
  // is the defensive guard for *valid* sources that happen to confuse
  // the lexer-light counter (e.g. unusual operator overloads in the
  // future); we can't exercise the fallback path from this test surface.
});
