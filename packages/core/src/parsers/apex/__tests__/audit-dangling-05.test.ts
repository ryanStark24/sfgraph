import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { ApexClassParser } from "../index.js";

/**
 * Audit dangling-05: STATIC_CALL_RE treats a capitalized field/variable
 * receiver (`CODE_XY.toLowerCase()`) as a class, emitting a CALLS edge to a
 * nonexistent ApexMethod.
 */
describe("audit dangling-05: capitalized field receivers are not classes", () => {
  it("emits no CALLS edge for a method call on a declared static final field", async () => {
    const result = await new ApexClassParser().parse(
      {
        className: "Helper",
        metaXml: "<ApexClass/>",
        body: `
        public class Helper {
          static final String CODE_XY = 'DL';
          public static String run(String Prefix) {
            String a = CODE_XY.toLowerCase();
            return Prefix.trim() + a;
          }
        }
      `,
      },
      makeTestCtx(),
    );
    const calls = result.edges
      .filter((e) => e.relType === "CALLS")
      .map((e) => String(e.dstQualifiedName));
    expect(calls.filter((c) => c.startsWith("ApexMethod:CODE_XY."))).toEqual([]);
    expect(calls.filter((c) => c.startsWith("ApexMethod:Prefix."))).toEqual([]);
  });
});
