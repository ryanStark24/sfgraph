import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

/**
 * Audit sec-01: dead_code_audit compiles each `*` of a user glob to an
 * unbounded `.*`, so a short pathological pattern backtracks polynomially
 * and blocks the single-threaded stdio server. Correct behaviour: the call
 * finishes quickly (linear matcher) or the pattern is rejected.
 */
let fix: Fixture;

beforeEach(async () => {
  fix = await createFixture();
});

afterEach(async () => {
  await fix.cleanup();
});

describe("audit sec-01: dead_code_audit ReDoS", () => {
  it("finishes a pathological glob in < 500 ms or rejects it", async () => {
    // Unreferenced class (zero inbound) with a long all-'a' name: a candidate.
    fix.addNode({
      qualifiedName: `ApexClass:${"a".repeat(35)}`,
      label: "ApexClass",
    });
    const pattern = `${"*?".repeat(8)}!`;
    const t0 = Date.now();
    try {
      await callTool("dead_code_audit", { org: fix.orgId, pattern });
    } catch {
      // A clear rejection of the pattern is an acceptable fix.
    }
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("audit sec-01: glob semantics kept by the linear matcher", () => {
  it("matches prefixes, '*' and '?' case-insensitively on name or full qname", async () => {
    for (const n of ["Acme_Handler", "Acme_X1", "OtherHandler", "Zed"]) {
      fix.addNode({ qualifiedName: `ApexClass:${n}`, label: "ApexClass" });
    }
    const names = async (pattern: string) => {
      const r = await callTool("dead_code_audit", { org: fix.orgId, pattern });
      return ((r.data as { dead: Array<string | { qualifiedName: string }> }).dead ?? [])
        .map((d) => (typeof d === "string" ? d : d.qualifiedName))
        .sort();
    };
    expect(await names("acme_")).toEqual(["ApexClass:Acme_Handler", "ApexClass:Acme_X1"]);
    expect(await names("*handler")).toEqual(["ApexClass:Acme_Handler", "ApexClass:OtherHandler"]);
    expect(await names("Acme_??")).toEqual(["ApexClass:Acme_X1"]);
    expect(await names("apexclass:z*")).toEqual(["ApexClass:Zed"]);
  });

  it("rejects an over-long pattern", async () => {
    await expect(
      callTool("dead_code_audit", { org: fix.orgId, pattern: "a".repeat(300) }),
    ).rejects.toThrow();
  });
});
