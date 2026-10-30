import { asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSalesforceFrame } from "../resolve_frame.js";
import { type Fixture, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

let fix: Fixture;

beforeEach(async () => {
  fix = await createFixture();
});

afterEach(async () => {
  // A native-module startup failure can prevent beforeEach from assigning the
  // fixture; keep its root cause visible instead of masking it with cleanup.
  if (fix) await fix.cleanup();
});

function source(f: Fixture, qname: string, text: string, startLine: number, endLine: number): void {
  f.ctx.graphStore.upsertSnippet({
    orgId: f.orgId,
    qualifiedName: asQualifiedName(qname),
    sourceFormat: "apex",
    sourceText: text,
    sourceHash: asSha256(`hash-${qname}`),
    startLine,
    endLine,
  });
}

describe("resolve_frame", () => {
  it("resolves a class stack frame through the persistent source index", async () => {
    source(
      fix,
      "ApexMethod:OrderBillingService.sendInvoice(1)",
      "public void sendInvoice(Id id) {\n  Account a = [SELECT Id FROM Account WHERE Id = :id];\n  throw new InvoiceException();\n}",
      140,
      143,
    );
    const r = await callTool("resolve_frame", {
      org: fix.orgId,
      frame: "System.Exception: boom\nClass.OrderBillingService.sendInvoice: line 142, column 1",
      context_lines: 1,
    });
    const data = r.data as {
      status: string;
      qname: string;
      sourceHash: string;
      sourceRange: { startLine: number; endLine: number };
      excerpt: { startLine: number; endLine: number; focusLine: number; sourceText: string };
    };
    expect(data.status).toBe("resolved");
    expect(data.qname).toBe("ApexMethod:OrderBillingService.sendInvoice(1)");
    expect(data.sourceHash).toBe("hash-ApexMethod:OrderBillingService.sendInvoice(1)");
    expect(data.sourceRange).toEqual({ startLine: 140, endLine: 143 });
    expect(data.excerpt).toMatchObject({ startLine: 141, endLine: 143, focusLine: 142 });
    expect(data.excerpt.sourceText).toContain("throw new InvoiceException");
    expect(r.markdown).toContain(">    142 |   throw new InvoiceException();");
  });

  it("uses source ranges to choose the right overload", async () => {
    source(fix, "ApexMethod:InvoiceService.send(0)", "void send() {}", 10, 10);
    source(fix, "ApexMethod:InvoiceService.send(1)", "void send(Id id) {}", 30, 30);
    const r = await callTool("resolve_frame", {
      org: fix.orgId,
      kind: "class",
      class_name: "invoiceservice",
      method: "send",
      line: 30,
    });
    expect((r.data as { qname: string }).qname).toBe("ApexMethod:InvoiceService.send(1)");
  });

  it("rejects a frame from a different Git ref instead of attributing current source to it", async () => {
    source(fix, "ApexMethod:InvoiceService.send(0)", "void send() {}", 30, 30);
    fix.ctx.graphStore.setSourceRevision(fix.orgId, {
      gitBranch: "feature/invoices",
      gitCommit: "a".repeat(40),
      capturedAt: "2026-10-31T00:00:00.000Z",
    });
    const stale = await callTool("resolve_frame", {
      org: fix.orgId,
      kind: "class",
      class_name: "InvoiceService",
      method: "send",
      line: 30,
      git_ref: "b".repeat(40),
    });
    expect((stale.data as { status: string }).status).toBe("git_ref_mismatch");
    expect(stale.markdown).toContain("Re-ingest");
    const found = await callTool("resolve_frame", {
      org: fix.orgId,
      kind: "class",
      class_name: "InvoiceService",
      method: "send",
      line: 30,
      git_ref: "a".repeat(40),
    });
    expect(
      (found.data as { status: string; sourceRevision: { gitCommit: string } }).sourceRevision
        .gitCommit,
    ).toBe("a".repeat(40));
  });

  it("resolves trigger frames and explains a stale or mismatched line without guessing", async () => {
    source(
      fix,
      "ApexTrigger:CaseTrigger",
      "trigger CaseTrigger on Case (before insert) {\n}\n",
      1,
      2,
    );
    const found = await callTool("resolve_frame", {
      org: fix.orgId,
      frame: "Trigger.CaseTrigger: line 1, column 1",
    });
    expect((found.data as { status: string; qname: string }).status).toBe("resolved");
    expect((found.data as { qname: string }).qname).toBe("ApexTrigger:CaseTrigger");

    const stale = await callTool("resolve_frame", {
      org: fix.orgId,
      frame: "Trigger.CaseTrigger: line 8",
    });
    expect((stale.data as { status: string }).status).toBe("line_outside_source");
    expect(stale.markdown).toContain("Re-ingest the org");
  });

  it("does not turn malformed stack text into a broad lookup", async () => {
    expect(parseSalesforceFrame("Class.Foo.bar: line 4")).toMatchObject({
      kind: "class",
      ownerName: "Foo",
      memberName: "bar",
      line: 4,
    });
    expect(parseSalesforceFrame("not a Salesforce frame")).toBeNull();
    await expect(
      callTool("resolve_frame", { org: fix.orgId, frame: "Class.Foo.bar at 4" }),
    ).rejects.toThrow(/frame must contain/);
  });
});
