import { describe, expect, it } from "vitest";
import { evaluatePredicate, evaluateRaw, evaluateString } from "../_selectors.js";

const ctx = (overrides: Partial<Parameters<typeof evaluateString>[1]> = {}) => ({
  record: {},
  item: null,
  ns: null,
  caps: {},
  ...overrides,
});

describe("rule selectors", () => {
  it("interpolates a simple field", () => {
    expect(evaluateString("${record.x}", ctx({ record: { x: "hi" } }))).toBe("hi");
  });

  it("walks nested paths", () => {
    expect(evaluateString("${record.a.b.c}", ctx({ record: { a: { b: { c: 42 } } } }))).toBe(42);
  });

  it("supports || fallback in predicates", () => {
    expect(evaluatePredicate("${item.x || item.y}", ctx({ item: { y: true } }))).toBe(true);
    expect(evaluatePredicate("${item.x || item.y}", ctx({ item: {} }))).toBe(false);
  });

  it("compares string literals with ==", () => {
    expect(evaluatePredicate("${item.x == 'foo'}", ctx({ item: { x: "foo" } }))).toBe(true);
    expect(evaluatePredicate("${item.x == 'foo'}", ctx({ item: { x: "bar" } }))).toBe(false);
  });

  it("negates with !", () => {
    expect(evaluatePredicate("${!item.x}", ctx({ item: { x: false } }))).toBe(true);
    expect(evaluatePredicate("${!item.x}", ctx({ item: { x: "y" } }))).toBe(false);
  });

  it("is undefined-safe", () => {
    expect(evaluateString("${record.missing.deep}", ctx())).toBe(undefined);
    expect(evaluatePredicate("${record.missing}", ctx())).toBe(false);
  });

  it("flattens .* nested array iteration via evaluateRaw", () => {
    const data = {
      sections: [
        { cols: [{ items: [{ field: "A" }, { field: "B" }] }] },
        { cols: [{ items: [{ field: "C" }] }] },
      ],
    };
    const out = evaluateRaw("${record.sections.*.cols.*.items}", ctx({ record: data }));
    expect(Array.isArray(out)).toBe(true);
    expect((out as unknown[]).length).toBe(3);
  });

  it("supports stripNs() helper", () => {
    expect(
      evaluateString("${stripNs(record.x)}", ctx({ record: { x: "ns__Foo" }, ns: "ns" })),
    ).toBe("Foo");
  });

  it("supports split() helper with index", () => {
    expect(evaluateString("${split(record.x,'-')[0]}", ctx({ record: { x: "a-b-c" } }))).toBe("a");
  });
});
