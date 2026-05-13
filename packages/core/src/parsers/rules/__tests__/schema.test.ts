import { describe, expect, it } from "vitest";
import { RuleSchema } from "../_schema.js";

describe("rule schema", () => {
  it("parses a minimal valid rule", () => {
    const out = RuleSchema.parse({
      type: "Foo",
      category: "Profile",
      input: "object",
      applies_when: { always: true },
    });
    expect(out.nodes).toEqual([]);
    expect(out.edges).toEqual([]);
  });

  it("defaults nodes + edges to empty arrays", () => {
    const out = RuleSchema.parse({
      type: "Foo",
      category: "Profile",
      input: "object",
      applies_when: { always: true },
    });
    expect(out.nodes).toEqual([]);
    expect(out.edges).toEqual([]);
  });

  it("rejects unknown applies_when shape", () => {
    expect(() =>
      RuleSchema.parse({
        type: "Foo",
        category: "Profile",
        input: "object",
        applies_when: { bogus: true },
      }),
    ).toThrow();
  });
});
