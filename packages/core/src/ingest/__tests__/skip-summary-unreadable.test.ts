import { afterEach, describe, expect, it, vi } from "vitest";
import { printSkipSummary } from "../live-ingest.js";

describe("printSkipSummary — unreadable (org refused) group", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists unreadable entries in their own group with the first error, apart from skips", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.join(" "));
    });
    printSkipSummary(
      {
        skips: [
          {
            label: "generic:QuickAction",
            reason:
              "generic:QuickAction: 2 member(s) unreadable (org refused): Quote.SendEmail, SendEmail; first error: targetObject is invalid",
            category: "unreadable",
          },
          { label: "object", reason: "object: socket hang up", category: "network" },
        ],
      },
      "acme-dev",
    );
    const out = lines.join("\n");
    expect(out).toMatch(/⚠ 1 metadata type was skipped/);
    expect(out).toMatch(/1 metadata type \(or some of its members\) could not be read/);
    expect(out).toMatch(
      /Unreadable \(org refused; re-run with --retry-skipped to try again\) \(1\):/,
    );
    expect(out).not.toMatch(/platform/i);
    expect(out).toMatch(/sfgraph ingest --org acme-dev --retry-skipped/);
    expect(out).toMatch(/generic:QuickAction: .*first error: targetObject is invalid/);
    const unreadableBlock = out.slice(out.indexOf("Unreadable (org refused"));
    expect(unreadableBlock).not.toMatch(/• object/);
  });

  it("with only unreadable entries, prints no 'skipped' header", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.join(" "));
    });
    printSkipSummary(
      {
        skips: [
          {
            label: "generic:ManagedTopic",
            reason: "generic:ManagedTopic: listing unreadable (org refused metadata.list)",
            category: "unreadable",
          },
          {
            label: "generic:NetworkBranding",
            reason: "generic:NetworkBranding: 10 member(s) unreadable (org refused)",
            category: "unreadable",
          },
        ],
      },
      "acme-dev",
    );
    const out = lines.join("\n");
    expect(out).not.toMatch(/skipped during this ingest/);
    expect(out).toMatch(/2 metadata types \(or some of their members\) could not be read/);
    expect(out).toMatch(/\(2\):/);
  });
});
