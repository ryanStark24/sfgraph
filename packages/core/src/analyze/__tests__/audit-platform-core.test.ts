import { describe, expect, it } from "vitest";
import { APEX_PLATFORM_NAMESPACES, AUDIT_PLATFORM_CORE } from "../apex-platform.js";
import { isPlatformBuiltinRef } from "../audit-graph.js";

// Q1 re-review N1: the dangling-edge audit uses the narrow 76-entry platform
// set, not the parser's 202-entry superset, so a missing user class with a
// common name (Location, Request, Domain, Page) is reported as unexpected.
describe("audit uses the narrow platform core set", () => {
  it("has the original 76 entries, a subset of the shared list", () => {
    expect(AUDIT_PLATFORM_CORE.size).toBe(76);
    for (const c of AUDIT_PLATFORM_CORE) expect(APEX_PLATFORM_NAMESPACES.has(c), c).toBe(true);
  });

  it("a dangling ApexClass:Location counts as unexpected", () => {
    expect(isPlatformBuiltinRef("ApexClass:Location")).toBe(false);
    expect(isPlatformBuiltinRef("ApexMethod:Location.getLatitude(0)")).toBe(false);
    expect(isPlatformBuiltinRef("ApexClass:Request")).toBe(false);
  });

  it("core platform classes stay expected", () => {
    expect(isPlatformBuiltinRef("ApexMethod:System.debug(1)")).toBe(true);
    expect(isPlatformBuiltinRef("ApexClass:Database")).toBe(true);
  });
});
