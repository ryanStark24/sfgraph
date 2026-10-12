import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing as bulkTesting, skipEntriesFor } from "../bulk-retrieve.js";
import { IncompleteSourceError, PlatformRefusalError, TypeUnreadableError } from "../retry.js";

/**
 * Review M5: the recoverable entry of a mixed source was classified from the
 * COMBINED message (member names + first error only), so an
 * INSUFFICIENT_ACCESS first failure made a later `socket hang up` look like
 * a permission problem (not auto-retried), and member names containing
 * NOT_FOUND / FORBIDDEN skewed the category. Each failure is classified on
 * its own error. Review M6: the failSoft log prints unreadable and lost
 * counts separately.
 */

function sfFault(code: string, message: string): Error {
  const e = new Error(message) as Error & { errorCode: string };
  e.name = `sf:${code}`;
  e.errorCode = `sf:${code}`;
  return e;
}

const refused = () =>
  new PlatformRefusalError(sfFault("INVALID_CROSS_REFERENCE_KEY", "invalid cross reference id"));

afterEach(() => vi.restoreAllMocks());

describe("skipEntriesFor groups recoverable failures by their own category (M5)", () => {
  it("an INSUFFICIENT_ACCESS first failure does not hide a later network failure", () => {
    const err = new IncompleteSourceError("generic:Settings", [
      {
        name: "EventLogObject",
        error: sfFault("INSUFFICIENT_ACCESS", "INSUFFICIENT_ACCESS: no EventLogRead"),
      },
      { name: "Account", error: new Error("connect ETIMEDOUT 10.0.0.1:443") },
    ]);
    const entries = skipEntriesFor("generic:Settings", err);
    const byCat = Object.fromEntries(entries.map((e) => [e.category, e.reason]));
    expect(Object.keys(byCat).sort()).toEqual(["insufficient_access", "network"]);
    expect(byCat.network).toMatch(/Account/);
    expect(byCat.network).not.toMatch(/EventLogObject/);
    expect(byCat.insufficient_access).toMatch(/EventLogObject/);
  });

  it("a member name containing NOT_FOUND does not decide the category", () => {
    const err = new IncompleteSourceError("generic:Widget", [
      { name: "NOT_FOUND_Handler", error: new Error("socket hang up (ECONNRESET)") },
    ]);
    const entries = skipEntriesFor("generic:Widget", err);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.category).not.toBe("not_found");
  });

  it("unreadable + two recoverable categories → three entries for one label", () => {
    const err = new IncompleteSourceError("generic:Widget", [
      { name: "Refused", error: refused() },
      { name: "Locked", error: sfFault("INSUFFICIENT_ACCESS", "INSUFFICIENT_ACCESS: nope") },
      { name: "Flaky", error: new Error("connect ETIMEDOUT 10.0.0.1:443") },
    ]);
    const cats = skipEntriesFor("generic:Widget", err)
      .map((e) => e.category)
      .sort();
    expect(cats).toEqual(["insufficient_access", "network", "unreadable"]);
  });
});

describe("failSoft log line counts unreadable and lost members separately (M6)", () => {
  async function logFor(err: Error): Promise<string> {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => {
      lines.push(String(m));
    });
    const coordinator = bulkTesting.createWedgeCoordinator();
    // biome-ignore lint/correctness/useYield: throws before any yield on purpose
    async function* throws(): AsyncGenerator<never> {
      throw err;
    }
    for await (const _ of bulkTesting.failSoft("generic:Widget", throws, () => {}, coordinator)) {
      /* consume */
    }
    return lines.find((l) => l.includes("generic:Widget ✗")) ?? "";
  }

  it("mixed: `skipped`, with the lost and the unreadable counts apart", async () => {
    const line = await logFor(
      new IncompleteSourceError("generic:Widget", [
        { name: "A", error: refused() },
        { name: "B", error: refused() },
        { name: "C", error: new Error("socket hang up") },
      ]),
    );
    expect(line).toContain("✗ skipped (1 member(s) not fetched, 2 member(s) unreadable)");
  });

  it("all refused, early stop: `unreadable`, with the unread count", async () => {
    const line = await logFor(
      new IncompleteSourceError("generic:Widget", [
        ...Array.from({ length: 10 }, (_, i) => ({ name: `M${i}`, error: refused() })),
        { name: "453 unread member(s)", error: new TypeUnreadableError(refused(), 453) },
      ]),
    );
    expect(line).toContain("✗ unreadable (10 member(s) unreadable, 453 not read after early stop)");
  });

  it("listing refused: `unreadable (listing refused)`", async () => {
    const line = await logFor(
      new IncompleteSourceError("generic:Widget", [
        { name: "metadata.list Widget", error: refused() },
      ]),
    );
    expect(line).toContain("✗ unreadable (listing refused)");
  });
});
