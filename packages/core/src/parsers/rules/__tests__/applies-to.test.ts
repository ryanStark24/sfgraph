import { describe, expect, it } from "vitest";
import { appliesTo } from "../_engine.js";
import { RuleSchema } from "../_schema.js";

function rule(when: unknown) {
  return RuleSchema.parse({
    type: "T",
    category: "Profile",
    input: "object",
    applies_when: when,
  });
}

describe("appliesTo", () => {
  it("matches always:true regardless of caps", () => {
    expect(appliesTo(rule({ always: true }), {})).toBe(true);
    expect(appliesTo(rule({ always: true }), { vlocityCmt: false })).toBe(true);
  });

  it("respects capability flags", () => {
    expect(appliesTo(rule({ capability: "vlocityCmt" }), { vlocityCmt: true })).toBe(true);
    expect(appliesTo(rule({ capability: "vlocityCmt" }), {})).toBe(false);
  });

  it("supports not / any_of / all_of combinators", () => {
    expect(appliesTo(rule({ not: { capability: "x" } }), {})).toBe(true);
    expect(
      appliesTo(rule({ any_of: [{ capability: "a" }, { capability: "b" }] }), { b: true }),
    ).toBe(true);
    expect(
      appliesTo(rule({ all_of: [{ capability: "a" }, { capability: "b" }] }), { a: true }),
    ).toBe(false);
    expect(
      appliesTo(rule({ all_of: [{ capability: "a" }, { capability: "b" }] }), {
        a: true,
        b: true,
      }),
    ).toBe(true);
  });
});
