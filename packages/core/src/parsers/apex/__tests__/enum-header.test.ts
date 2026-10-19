import { describe, expect, it } from "vitest";
import { isManagedItem } from "../../../analyze/cross-org.js";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { APEX_NODE_HASH_SALT, ApexClassParser } from "../class.js";

/**
 * Cycle 3 T6 fix 1 (I1): the header scan found only `class` and `interface`, so a top-level enum
 * got `modifiers: []`, the same shape as the empty-body stub of a managed class, and cross_org_diff
 * hid it as a managed-package item.
 */
describe("Apex enum header and the empty-body stub", () => {
  const parse = (className: string, body: string) =>
    new ApexClassParser().parse({ className, body }, makeTestCtx());

  it("a top-level enum gets its modifiers", async () => {
    const r = await parse("Color", "public enum Color { RED, GREEN }");
    const n = r.nodes.find((x) => x.label === "ApexClass");
    expect(n?.attributes.modifiers).toEqual(["public"]);
    expect(n?.attributes.bodyUnavailable).toBeUndefined();
    const g = await parse("Shade", "global with sharing enum Shade { DARK }");
    expect(g.nodes.find((x) => x.label === "ApexClass")?.attributes.modifiers).toEqual([
      "global",
      "with",
      "sharing",
    ]);
  });

  it("an enum inside a class does not replace the class header", async () => {
    const r = await parse("Holder", "public class Holder { public enum Kind { A } }");
    const n = r.nodes.find((x) => x.label === "ApexClass");
    expect(String(n?.qualifiedName)).toBe("ApexClass:Holder");
    expect(n?.attributes.modifiers).toEqual(["public"]);
  });

  it("the empty-body stub is marked bodyUnavailable", async () => {
    const r = await parse("PkgThing", "");
    expect(r.nodes.find((x) => x.label === "ApexClass")?.attributes.bodyUnavailable).toBe(true);
  });

  it("a parsed local enum is not managed; an empty-body stub still is", async () => {
    const e = (await parse("Color", "public enum Color { RED }")).nodes.find(
      (x) => x.label === "ApexClass",
    );
    const s = (await parse("PkgThing", "")).nodes.find((x) => x.label === "ApexClass");
    expect(e && isManagedItem(e)).toBe(false);
    expect(s && isManagedItem(s)).toBe(true);
  });

  it("the hash salt is bumped so a re-ingest stores the new attributes", () => {
    // v6 or later (cycle 3 T7 bumped it again, to v7).
    expect(APEX_NODE_HASH_SALT).not.toMatch(/:v[1-5]$/);
  });
});
