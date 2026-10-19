import { describe, expect, it } from "vitest";
import { APEX_PLATFORM_NAMESPACES, AUDIT_PLATFORM_CORE } from "../apex-platform.js";

// Task 14 batch P, rule 12: `FeatureManagement.checkPermission(…)` is a
// platform class, never a user class; the audit's narrow core set is unchanged.
describe("FeatureManagement platform class", () => {
  it("is in the shared parser list but not in the audit core subset", () => {
    expect(APEX_PLATFORM_NAMESPACES.has("featuremanagement")).toBe(true);
    expect(AUDIT_PLATFORM_CORE.has("featuremanagement")).toBe(false);
    expect(AUDIT_PLATFORM_CORE.size).toBe(76);
  });
});
