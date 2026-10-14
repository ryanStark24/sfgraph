import { REL_TYPES } from "@ryanstark24/sfgraph-core";
import { asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

// Batch Q2 (task 14): explain_code lists the target's direct references as
// structured data (component level, pseudo endpoints excluded).
let fix: Fixture;
beforeEach(async () => {
  fix = await createFixture();
});
afterEach(async () => {
  await fix.cleanup();
});

type Ref = { qname: string; label: string; relType: string };

function n(q: string): void {
  fix.addNode({ qualifiedName: q, label: q.slice(0, q.indexOf(":")) });
}
function e(src: string, dst: string, rel: string): void {
  fix.addEdge({ srcQualifiedName: src, dstQualifiedName: dst, relType: rel });
}
function snippet(q: string, body: string): void {
  fix.ctx.graphStore.upsertSnippet({
    orgId: fix.orgId,
    qualifiedName: asQualifiedName(q),
    sourceFormat: "apex",
    sourceText: body,
    sourceHash: asSha256(`h-${q}`),
    startLine: 1,
    endLine: 1,
  });
}
async function explain(
  qname: string,
): Promise<{ markdown: string; data: Record<string, unknown> }> {
  const r = await callTool("explain_code", { org: fix.orgId, qname });
  return { markdown: r.markdown, data: r.data as Record<string, unknown> };
}

beforeEach(() => {
  for (const q of [
    "ApexTrigger:T",
    "ApexClass:Svc",
    "ApexMethod:Svc.run(0)",
    "ApexMethod:Svc.other(0)",
    "ApexClass:Own",
    "ApexMethod:Own.a(0)",
    "ApexMethod:Own.b(0)",
    "ApexClass:Far",
    "CustomObject:Account",
    "CustomField:Account.X__c",
    "Flow:F",
    "FlowVersion:F.v1",
  ]) {
    n(q);
  }
  e("ApexClass:Svc", "ApexMethod:Svc.run(0)", REL_TYPES.CONTAINS_METHOD);
  e("ApexClass:Svc", "ApexMethod:Svc.other(0)", REL_TYPES.CONTAINS_METHOD);
  e("ApexClass:Own", "ApexMethod:Own.a(0)", REL_TYPES.CONTAINS_METHOD);
  e("ApexClass:Own", "ApexMethod:Own.b(0)", REL_TYPES.CONTAINS_METHOD);
  e("Flow:F", "FlowVersion:F.v1", REL_TYPES.CONTAINS);
  e("ApexTrigger:T", "ApexMethod:Svc.run(0)", REL_TYPES.CALLS);
  e("ApexTrigger:T", "CustomField:Account.X__c", REL_TYPES.READS_FIELD);
  e("ApexTrigger:T", "CustomObject:Account", REL_TYPES.QUERIES);
  e("ApexTrigger:T", "FlowVersion:F.v1", REL_TYPES.CALLS);
  // Platform call: a pseudo endpoint, not a reference.
  e("ApexTrigger:T", "ApexMethod:System.debug(1)", REL_TYPES.CALLS);
  // Two hops away: not direct.
  e("ApexMethod:Svc.run(0)", "ApexClass:Far", REL_TYPES.CALLS);
  // A method target: its own class is not a reference, a sibling's
  // references are not the target's.
  e("ApexMethod:Own.a(0)", "ApexMethod:Own.b(0)", REL_TYPES.CALLS);
  e("ApexMethod:Own.a(0)", "ApexMethod:Svc.other(0)", REL_TYPES.CALLS);
  e("ApexMethod:Own.b(0)", "ApexClass:Far", REL_TYPES.CALLS);
  snippet("ApexTrigger:T", "trigger T on Account (before insert) {}");
  snippet("ApexMethod:Own.a(0)", "void a() { b(); }");
});

describe("explain_code: data.references", () => {
  it("lists direct out-references at component level, sorted, pseudo excluded", async () => {
    const { data } = await explain("ApexTrigger:T");
    expect(data.references as Ref[]).toEqual([
      { qname: "ApexClass:Svc", label: "ApexClass", relType: "CALLS" },
      { qname: "CustomField:Account.X__c", label: "CustomField", relType: "READS_FIELD" },
      { qname: "CustomObject:Account", label: "CustomObject", relType: "QUERIES" },
      { qname: "Flow:F", label: "Flow", relType: "CALLS" },
    ]);
  });

  it("a method target excludes its own class and its siblings' references", async () => {
    const { data } = await explain("ApexMethod:Own.a(0)");
    expect((data.references as Ref[]).map((r) => r.qname)).toEqual(["ApexClass:Svc"]);
  });

  // Cycle 2 T5 fix round 1: an MCP client sees only the markdown (server.ts runTool), so the
  // references are listed in it too (they were data-only before).
  it("lists the references in the text after the source", async () => {
    const { markdown } = await explain("ApexTrigger:T");
    expect(markdown).toContain(
      [
        "**Direct references** (4, component level; trace_downstream depth 1):",
        "- ApexClass:Svc — CALLS",
        "- CustomField:Account.X__c — READS_FIELD",
        "- CustomObject:Account — QUERIES",
        "- Flow:F — CALLS",
      ].join("\n"),
    );
    expect(markdown.indexOf("**Direct references**")).toBeGreaterThan(markdown.indexOf("```\n"));
  });

  it("a method target lists only its own references in the text", async () => {
    const { markdown } = await explain("ApexMethod:Own.a(0)");
    expect(markdown).toContain(
      "**Direct references** (1, component level; trace_downstream depth 1):\n- ApexClass:Svc — CALLS",
    );
  });

  it("an unknown or snippet-less target lists its edges, or none", async () => {
    expect((await explain("ApexClass:Svc")).data.references as Ref[]).toEqual([
      { qname: "ApexClass:Far", label: "ApexClass", relType: "CALLS" },
    ]);
    expect((await explain("ApexClass:Nope")).data.references).toEqual([]);
  });
});

describe("explain_code: standard fields carry a role (Batch S fix, controller ruling)", () => {
  it("marks a referenced standard field role standard-field and keeps it listed", async () => {
    n("CustomField:Account.Name");
    n("CustomField:Account.Id");
    e("ApexTrigger:T", "CustomField:Account.Name", REL_TYPES.READS_FIELD);
    e("ApexTrigger:T", "CustomField:Account.Id", REL_TYPES.READS_FIELD);
    const refs = (await explain("ApexTrigger:T")).data.references as Array<Ref & { role?: string }>;
    expect(refs.filter((r) => r.label === "CustomField")).toEqual([
      {
        qname: "CustomField:Account.Id",
        label: "CustomField",
        relType: "READS_FIELD",
        role: "standard-field",
      },
      {
        qname: "CustomField:Account.Name",
        label: "CustomField",
        relType: "READS_FIELD",
        role: "standard-field",
      },
      { qname: "CustomField:Account.X__c", label: "CustomField", relType: "READS_FIELD" },
    ]);
    expect((await explain("ApexTrigger:T")).markdown).toContain(
      "- CustomField:Account.Id — READS_FIELD (standard field)\n- CustomField:Account.Name — READS_FIELD (standard field)\n- CustomField:Account.X__c — READS_FIELD\n",
    );
    // Standard objects are components, not marked.
    expect(refs.find((r) => r.qname === "CustomObject:Account")?.role).toBeUndefined();
  });
});

describe("explain_code: prose pinned to its ce9bcf4 output (fix round 1, M9) plus the references list (cycle 2 T5)", () => {
  it("snippet path", async () => {
    expect((await explain("ApexTrigger:T")).markdown).toMatchInlineSnapshot(`
      "## What T does

      **In short**
      \`T\` is an Apex trigger (code that runs when records change), at line 1 of its source; its source is under Technical details. It runs before \`Account\` records are created. Its code uses 4 pieces directly: 1 Apex class (server code), 1 field, 1 object (a table of records) and 1 flow (point-and-click automation). No explanation is saved yet.

      **Picture**

      \`\`\`mermaid
      flowchart LR
        n0["Apex trigger: T"]
        n1["Apex class: Svc"]
        n2["Field: Account.X__c"]
        n3["Object: Account"]
        n4["Flow: F"]
        n0 -->|calls| n1
        n0 -->|reads the field| n2
        n0 -->|looks up records of| n3
        n0 -->|calls| n4
      \`\`\`

      **What each piece does**
      - \`Svc\`: Apex class (server code), called by \`T\`.
      - \`Account.X__c\`: Field on \`Account\`, read by \`T\`.
      - \`Account\`: Object (a table of records), looked up by \`T\`.
      - \`F\`: Flow (point-and-click automation), called by \`T\`.

      **Technical details**

      **ApexTrigger:T** — \`apex\` (lines 1–1)

      \`\`\`apex
      trigger T on Account (before insert) {}
      \`\`\`

      **Direct references** (4, component level; trace_downstream depth 1):
      - ApexClass:Svc — CALLS
      - CustomField:Account.X__c — READS_FIELD
      - CustomObject:Account — QUERIES
      - Flow:F — CALLS

      > No explanation cached yet — generate one and call \`explain_code\` again with \`annotation\` to persist it.

      _follow_up_tools: \`analyze_field\`, \`trace_upstream\`, \`trace_downstream\`_

      **What to check next**
      - Save an explanation with \`annotation\` so the next reader sees it.
      - Run \`trace_upstream\` to see what relies on \`T\`.
      - Run \`analyze_field\` on a field it reads or writes.
      - Direct references leave out its own class and pseudo endpoints (platform Apex, DML and the like)."
    `);
  });
  it("no-snippet path", async () => {
    expect((await explain("ApexClass:Svc")).markdown).toMatchInlineSnapshot(
      `
      "## What Svc does

      **In short**
      \`Svc\` is an Apex class (server code). Source is stored per method; ask for one of its methods (see below). It links directly to 1 piece: 1 Apex class.

      **What each piece does**
      - \`Far\`: Apex class (server code), called by \`Svc\`.

      **Technical details**

      > No snippet stored for \`ApexClass:Svc\`. Snippets are stored for Apex methods, Apex triggers and Flows; for a class, explain one of its methods. For other metadata, use \`analyze_field\` or \`trace_upstream\` instead.

      **What to check next**
      - Run \`analyze_field\` for a field, or \`trace_upstream\` and \`trace_downstream\` for other kinds.
      - Look up the methods of a class with \`find_nodes\` (for example the pattern \`ApexMethod:ClassName.*\`).
      - Direct references leave out its own class and pseudo endpoints (platform Apex, DML and the like)."
    `,
    );
  });
});
