import { afterEach, describe, expect, it, vi } from "vitest";
import { printSkipSummary, requiredUserPermission } from "../live-ingest.js";

/**
 * An INSUFFICIENT_ACCESS error that names the user permission it wants
 * (EventLogObject settings: EventLogRead) used to get the generic "assign
 * Modify Metadata / View All Data" advice, which an admin already has.
 */

function capture(fn: () => void): string {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    lines.push(a.join(" "));
  });
  fn();
  return lines.join("\n");
}

const eventLog = {
  label: "generic:Settings",
  reason:
    "generic:Settings: 1 member(s) not fetched after retries: EventLogObject; first error: INSUFFICIENT_ACCESS: User does not have the User permission EventLogRead.",
  category: "insufficient_access" as const,
};
const genericAccess = {
  label: "generic:CustomObject",
  reason: "generic:CustomObject: INSUFFICIENT_ACCESS: insufficient access rights on object id",
  category: "insufficient_access" as const,
};

describe("printSkipSummary — insufficient access remediation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("extracts the named user permission", () => {
    expect(requiredUserPermission(eventLog.reason)).toBe("EventLogRead");
    expect(requiredUserPermission(genericAccess.reason)).toBeUndefined();
  });

  it("names the permission the org asked for and drops the generic admin advice", () => {
    const out = capture(() => printSkipSummary({ skips: [eventLog] }, "acme-dev"));
    expect(out).toMatch(/- 'EventLogRead'/);
    expect(out).toMatch(/add-on license/);
    expect(out).not.toMatch(/Modify Metadata Through Metadata API Functions/);
    expect(out).not.toMatch(/deny-list the entity/);
    expect(out).toMatch(/sfgraph ingest --org acme-dev --rebuild/);
  });

  it("keeps the generic advice for errors that name no permission", () => {
    const out = capture(() => printSkipSummary({ skips: [genericAccess] }, "acme-dev"));
    expect(out).toMatch(/1\. Have an admin assign your user a permission set/);
    expect(out).toMatch(/Modify Metadata Through Metadata API Functions/);
    expect(out).toMatch(/deny-list the entity/);
  });

  it("prints both when the group mixes the two", () => {
    const out = capture(() => printSkipSummary({ skips: [eventLog, genericAccess] }, "acme-dev"));
    expect(out).toMatch(/- 'EventLogRead'/);
    expect(out).toMatch(/For the others, assign your user a permission set/);
  });
});
