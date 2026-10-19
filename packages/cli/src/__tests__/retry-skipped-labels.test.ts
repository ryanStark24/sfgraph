import { describe, expect, it } from "vitest";
import { retrySkippedLabels } from "../commands/skip-labels.js";

describe("retrySkippedLabels", () => {
  it("an explicit --retry-skipped re-runs every skipped label, unreadable ones included", () => {
    // `unreadable` only means "not auto-retried within the run that saw it";
    // asking for --retry-skipped is the user's way to try those again.
    expect(
      retrySkippedLabels([
        { label: "generic:WorkflowFlowAutomation", category: "unreadable" },
        { label: "generic:QuickAction", category: "unreadable" },
        { label: "generic:QuickAction", category: "unknown" },
        { label: "object", category: "network" },
        { label: "generic:Foo" },
        { category: "network" },
      ]).sort(),
    ).toEqual(["generic:Foo", "generic:QuickAction", "generic:WorkflowFlowAutomation", "object"]);
  });
});
