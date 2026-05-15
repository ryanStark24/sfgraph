import { asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

let fix: Fixture;

beforeEach(async () => {
  fix = await createFixture();
});

afterEach(async () => {
  await fix.cleanup();
});

function seedSnippet(
  f: Fixture,
  qname: string,
  body: string,
  hash: string,
  explanation?: string,
): void {
  f.ctx.graphStore.upsertSnippet({
    orgId: f.orgId,
    qualifiedName: asQualifiedName(qname),
    sourceFormat: "apex",
    sourceText: body,
    sourceHash: asSha256(hash),
    startLine: 1,
    endLine: body.split("\n").length,
  });
  if (explanation) {
    f.ctx.graphStore.updateSnippetExplanation(
      f.orgId,
      asQualifiedName(qname),
      explanation,
      Date.now(),
    );
  }
}

describe("explain_code", () => {
  it("returns sourceText for an existing snippet", async () => {
    seedSnippet(fix, "ApexMethod:Foo.bar(0)", "return 1;", "h1");
    const r = await callTool("explain_code", {
      org: fix.orgId,
      qname: "ApexMethod:Foo.bar(0)",
    });
    const d = r.data as { sourceText: string | null; cachedExplanation: string | null };
    expect(d.sourceText).toBe("return 1;");
    expect(d.cachedExplanation).toBeNull();
    expect(r.markdown).toContain("```apex");
  });

  it("returns the cached explanation when one is stored", async () => {
    seedSnippet(fix, "ApexMethod:Foo.bar(0)", "return 1;", "h1", "returns one");
    const r = await callTool("explain_code", {
      org: fix.orgId,
      qname: "ApexMethod:Foo.bar(0)",
    });
    const d = r.data as { cachedExplanation: string | null };
    expect(d.cachedExplanation).toBe("returns one");
  });

  it("persists annotation and returns stored=true", async () => {
    seedSnippet(fix, "ApexMethod:Foo.bar(0)", "return 1;", "h1");
    const r = await callTool("explain_code", {
      org: fix.orgId,
      qname: "ApexMethod:Foo.bar(0)",
      annotation: "explains the bar method",
    });
    const d = r.data as { stored: boolean; cachedExplanation: string | null };
    expect(d.stored).toBe(true);
    expect(d.cachedExplanation).toBe("explains the bar method");
    // Verify persistence
    const got = fix.ctx.graphStore.getSnippet(fix.orgId, asQualifiedName("ApexMethod:Foo.bar(0)"));
    expect(got?.llmExplanation).toBe("explains the bar method");
  });

  it("returns a clear summary when qname has no snippet", async () => {
    const r = await callTool("explain_code", {
      org: fix.orgId,
      qname: "CustomField:Account.Name",
    });
    const d = r.data as { stored: boolean; sourceText: string | null };
    expect(d.stored).toBe(false);
    expect(d.sourceText).toBeNull();
    expect(r.summary).toContain("no snippet stored");
  });

  it("overwrites a prior annotation when a new one is supplied", async () => {
    seedSnippet(fix, "ApexMethod:Foo.baz(0)", "return 2;", "h2", "first explanation");
    const r = await callTool("explain_code", {
      org: fix.orgId,
      qname: "ApexMethod:Foo.baz(0)",
      annotation: "replacement explanation",
    });
    const d = r.data as { cachedExplanation: string | null };
    expect(d.cachedExplanation).toBe("replacement explanation");
  });

  it("rejects empty qname", async () => {
    await expect(callTool("explain_code", { org: fix.orgId, qname: "" })).rejects.toThrow();
  });

  it("rejects missing qname", async () => {
    await expect(callTool("explain_code", { org: fix.orgId })).rejects.toThrow();
  });
});
