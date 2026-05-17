import { describe, expect, it } from "vitest";
import { REL_TYPES } from "../../domain/rel-types.js";
import type { ParseContext } from "../contract.js";
import { makeEdge } from "../common.js";

const REL_TYPE = REL_TYPES;

function ctx(overrides: Partial<ParseContext> = {}): ParseContext {
  return {
    orgId: "00Dxx0000000001" as ParseContext["orgId"],
    parseTimestamp: "2026-01-01T00:00:00.000Z",
    sourceUri: "sfdx://ApexClass/AccountController.cls",
    namespace: null,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...overrides,
  };
}

describe("W1-02: edge provenance via makeEdge", () => {
  it("populates attributes.sourceUri from ParseContext", () => {
    const e = makeEdge(ctx(), "ApexClass:AccountController", REL_TYPE.CALLS, "ApexClass:Util");
    expect(e.attributes.sourceUri).toBe("sfdx://ApexClass/AccountController.cls");
  });

  it("threads optional line/column when caller provides AST location", () => {
    const e = makeEdge(
      ctx(),
      "ApexClass:AccountController",
      REL_TYPE.CALLS,
      "ApexClass:Util",
      {},
      { line: 42, column: 17 },
    );
    expect(e.attributes.line).toBe(42);
    expect(e.attributes.column).toBe(17);
    expect(e.attributes.sourceUri).toBe("sfdx://ApexClass/AccountController.cls");
  });

  it("omits line/column when caller doesn't pass them (no nulls polluting attributes)", () => {
    const e = makeEdge(ctx(), "A:B", REL_TYPE.CALLS, "A:C");
    expect("line" in e.attributes).toBe(false);
    expect("column" in e.attributes).toBe(false);
  });

  it("caller-supplied attributes win over provenance on key collision", () => {
    // Post-merge resolver passes set sourceUri='post-merge://resolver' on
    // their attribute payload to mark synthesised edges. Make sure the
    // explicit caller value isn't silently overwritten by ctx.sourceUri.
    const e = makeEdge(
      ctx(),
      "A:B",
      REL_TYPE.CANONICAL_OF,
      "A:C",
      { sourceUri: "post-merge://resolver", signaturesMatch: true },
    );
    expect(e.attributes.sourceUri).toBe("post-merge://resolver");
    expect(e.attributes.signaturesMatch).toBe(true);
  });

  it("does not set sourceUri when ParseContext has none", () => {
    const e = makeEdge(ctx({ sourceUri: "" }), "A:B", REL_TYPE.CALLS, "A:C");
    expect("sourceUri" in e.attributes).toBe(false);
  });
});
