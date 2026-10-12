import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HEADINGS } from "../_report.js";
import { type Fixture, REL_TYPES, createFixture } from "./_fixture.js";
import { lint, section, stripCode } from "./_jargon.js";
import { callTool } from "./_runner.js";

/**
 * Cycle 3 T3: the trace, impact and flow tools write a human report (In short, Picture, What each
 * piece does, Technical details, What to check next) around today's lossless text.
 *
 * expected/t3-reports.json holds each case's `data` and markdown as the tools returned them before
 * the report change (captured with T3_CAPTURE=1 on the pre-change code). `data` must stay
 * deep-equal; every qualified name the old text held must still be in Technical details.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXPECTED = path.join(HERE, "expected", "t3-reports.json");
const CAPTURE = process.env.T3_CAPTURE === "1";

let fix: Fixture;
let projectRoot: string;

function seed(f: Fixture): void {
  const n = (q: string, label: string, sourceHash?: string) =>
    f.addNode({ qualifiedName: q, label, ...(sourceHash ? { sourceHash } : {}) });
  const e = (src: string, dst: string, rel: string) =>
    f.addEdge({ srcQualifiedName: src, dstQualifiedName: dst, relType: rel });
  n("ApexTrigger:CaseTrigger", "ApexTrigger");
  n("ApexClass:CaseService", "ApexClass");
  n("ApexMethod:CaseService.run(0)", "ApexMethod");
  n("ApexClass:CaseHelper", "ApexClass");
  n("ApexMethod:CaseHelper.apply(1)", "ApexMethod");
  n("ApexClass:CaseServiceTest", "ApexClass");
  n("Flow:Case_Flow", "Flow");
  n("LWC:caseCard", "LWC");
  n("CustomObject:Case", "CustomObject");
  n("CustomObject:Account", "CustomObject");
  n("CustomField:Case.Priority__c", "CustomField");
  n("CustomField:Account.Tier__c", "CustomField");
  n("CustomField:Account.Name", "CustomField");
  e("ApexClass:CaseService", "ApexMethod:CaseService.run(0)", REL_TYPES.CONTAINS_METHOD);
  e("ApexClass:CaseHelper", "ApexMethod:CaseHelper.apply(1)", REL_TYPES.CONTAINS_METHOD);
  e("ApexTrigger:CaseTrigger", "ApexMethod:CaseService.run(0)", REL_TYPES.CALLS);
  e("ApexTrigger:CaseTrigger", "CustomObject:Case", REL_TYPES.TRIGGERS_ON);
  e("ApexMethod:CaseService.run(0)", "ApexMethod:CaseHelper.apply(1)", REL_TYPES.CALLS);
  e("ApexMethod:CaseService.run(0)", "CustomField:Case.Priority__c", REL_TYPES.READS_FIELD);
  e("ApexMethod:CaseHelper.apply(1)", "CustomField:Account.Tier__c", REL_TYPES.WRITES_FIELD);
  e("ApexMethod:CaseHelper.apply(1)", "CustomField:Account.Name", REL_TYPES.READS_FIELD);
  e("ApexMethod:CaseHelper.apply(1)", "ApexMethod:System.debug(1)", REL_TYPES.CALLS);
  e("Flow:Case_Flow", "ApexClass:CaseService", REL_TYPES.FLOW_INVOKES_APEX);
  e("LWC:caseCard", "ApexMethod:CaseService.run(0)", REL_TYPES.CALLS_APEX_FROM_LWC);
  e("ApexClass:CaseServiceTest", "ApexClass:CaseService", REL_TYPES.IS_TEST_FOR);
  e("CustomObject:Case", "CustomField:Case.Priority__c", REL_TYPES.DEFINES_FIELD);
  e("CustomObject:Account", "CustomField:Account.Tier__c", REL_TYPES.DEFINES_FIELD);
  e("CustomObject:Account", "CustomField:Account.Name", REL_TYPES.DEFINES_FIELD);
  f.ctx.graphStore.upsertSnippet({
    orgId: f.orgId,
    qualifiedName: asQualifiedName("ApexMethod:CaseService.run(0)"),
    sourceFormat: "apex",
    sourceText: "public void run() { new CaseHelper().apply(c); }",
    sourceHash: asSha256("snip-run"),
    startLine: 3,
    endLine: 3,
  });
}

function writeLocal(rel: string, content: string): void {
  const abs = path.join(projectRoot, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

const diffOf = (...files: string[]) =>
  files
    .map((f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-old\n+new\n`)
    .join("");
const HELPER_DIFF = diffOf("force-app/main/default/classes/CaseHelper.cls");
const GHOST_DIFF = diffOf("force-app/main/default/classes/Ghost.cls", "README.md");

interface Case {
  tool: string;
  args: Record<string, unknown>;
  /** Extra setup after the shared graph is seeded. */
  setup?: (f: Fixture) => Record<string, unknown> | undefined;
  /** The picture rule holds for this result (more than 2 components or more than one layer). */
  picture?: boolean;
}

const snapshotThenChange = (f: Fixture) => {
  const snap = f.ctx.snapshotStore.createSnapshot(f.orgId, "pre-sync", true);
  f.addNode({ qualifiedName: "ApexClass:CaseHelper", label: "ApexClass", sourceHash: "v2" });
  return { since: snap.id };
};

const CASES: Record<string, Case> = {
  "trace_downstream.trigger": {
    tool: "trace_downstream",
    args: { qname: "ApexTrigger:CaseTrigger" },
    picture: true,
  },
  "trace_downstream.class": {
    tool: "trace_downstream",
    args: { qname: "ApexClass:CaseService", depth: 1 },
    picture: true,
  },
  "trace_downstream.structure": {
    tool: "trace_downstream",
    args: { qname: "CustomObject:Account", include_structure: true },
    picture: true,
  },
  "trace_downstream.notfound": { tool: "trace_downstream", args: { qname: "ApexClass:Ghost" } },
  "trace_upstream.class": {
    tool: "trace_upstream",
    args: { qname: "ApexClass:CaseHelper" },
    picture: true,
  },
  "trace_upstream.field": {
    tool: "trace_upstream",
    args: { qname: "CustomField:Account.Tier__c", depth: 1 },
  },
  "trace_upstream.notfound": { tool: "trace_upstream", args: { qname: "Flow:Nope" } },
  "impact_from_git_diff.helper": {
    tool: "impact_from_git_diff",
    args: { diff: HELPER_DIFF },
    picture: true,
  },
  "impact_from_git_diff.ghost": { tool: "impact_from_git_diff", args: { diff: GHOST_DIFF } },
  "what_broke.changed": {
    tool: "what_broke",
    args: { depth: 2 },
    setup: snapshotThenChange,
    picture: true,
  },
  "what_broke.nobaseline": { tool: "what_broke", args: {} },
  "what_broke.nochange": {
    tool: "what_broke",
    args: {},
    setup: (f) => ({ since: f.ctx.snapshotStore.createSnapshot(f.orgId, "pre-sync", true).id }),
  },
  "wip_diff.local": { tool: "wip_diff", args: { local: true } },
  "wip_impact.local": { tool: "wip_impact", args: { local: true }, picture: true },
  "wip_test_gap.local": { tool: "wip_test_gap", args: { local: true } },
  "test_gap_intelligence_from_git_diff.helper": {
    tool: "test_gap_intelligence_from_git_diff",
    args: { diff: HELPER_DIFF, depth: 2 },
  },
  "test_gap_intelligence_from_git_diff.ghost": {
    tool: "test_gap_intelligence_from_git_diff",
    args: { diff: GHOST_DIFF },
  },
  "cross_layer_flow_map.lwc": {
    tool: "cross_layer_flow_map",
    args: { entry: "LWC:caseCard" },
    picture: true,
  },
  "cross_layer_flow_map.bare": { tool: "cross_layer_flow_map", args: { entry: "caseCard" } },
  "cross_layer_flow_map.ghost": { tool: "cross_layer_flow_map", args: { entry: "LWC:ghost" } },
  "explain_code.method": {
    tool: "explain_code",
    args: { qname: "ApexMethod:CaseService.run(0)" },
    picture: true,
  },
  "explain_code.nosnippet": {
    tool: "explain_code",
    args: { qname: "CustomField:Case.Priority__c" },
  },
  "analyze_field.tier": {
    tool: "analyze_field",
    args: { object: "Account", field: "Tier__c" },
    picture: true,
  },
  "analyze_field.priority": {
    tool: "analyze_field",
    args: { object: "Case", field: "Priority__c" },
    picture: true,
  },
  "analyze_field.ghost": { tool: "analyze_field", args: { object: "Case", field: "Ghost__c" } },
};

beforeEach(async () => {
  fix = await createFixture();
  seed(fix);
  projectRoot = mkdtempSync(path.join(tmpdir(), "sfg-t3-wip-"));
  writeFileSync(
    path.join(projectRoot, "sfdx-project.json"),
    JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }] }),
    "utf8",
  );
  writeLocal(
    "force-app/main/default/classes/CaseHelper.cls",
    "public class CaseHelper { public void apply(Case c) { c.Priority__c = 'High'; } }",
  );
  writeLocal("force-app/main/default/classes/CaseRouter.cls", "public class CaseRouter {}");
});

afterEach(async () => {
  await fix.cleanup();
  rmSync(projectRoot, { recursive: true, force: true });
});

/** Runs the case's setup once, then returns a caller for the case (extra args on top). */
function prepare(c: Case) {
  const more = c.setup?.(fix) ?? {};
  const { local, ...args } = c.args;
  return (extra: Record<string, unknown> = {}) =>
    callTool(c.tool, {
      org: fix.orgId,
      ...(local ? { project_root: projectRoot } : {}),
      ...args,
      ...more,
      ...extra,
    });
}
const run = (c: Case) => prepare(c)();

/** Qualified names (`Label:Name`) in a text, trailing sentence punctuation and stray brackets cut. */
function qnamesIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b[A-Z][A-Za-z]*:[A-Za-z_][A-Za-z0-9_.()$]*/g)) {
    let q = m[0];
    for (;;) {
      const open = (q.match(/\(/g) ?? []).length;
      const close = (q.match(/\)/g) ?? []).length;
      if (q.endsWith(".")) q = q.slice(0, -1);
      else if (q.endsWith(")") && close > open) q = q.slice(0, -1);
      else break;
    }
    out.add(q);
  }
  return [...out].sort();
}

const detailsOf = (md: string): string => {
  const at = md.indexOf(`\n${HEADINGS.details}\n`);
  const end = md.indexOf(`\n${HEADINGS.next}\n`);
  return at < 0 ? "" : md.slice(at, end > at ? end : undefined);
};

/** `data` with run-time values (timestamps) zeroed, so two runs compare equal. */
const stable = (d: unknown): unknown =>
  JSON.parse(JSON.stringify(d), (k, v) => (/At$/.test(k) && typeof v === "number" ? 0 : v));

const sentences = (t: string): number =>
  (stripCode(t).match(/[.!?](?=\s|$)/g) ?? []).length || (t.trim() ? 1 : 0);

if (CAPTURE) {
  it("captures the pre-change outputs", async () => {
    const out: Record<string, { data: unknown; markdown: string }> = {};
    for (const [name, c] of Object.entries(CASES)) {
      await fix.cleanup();
      fix = await createFixture();
      seed(fix);
      const r = await run(c);
      out[name] = { data: JSON.parse(JSON.stringify(r.data)), markdown: r.markdown };
    }
    mkdirSync(path.dirname(EXPECTED), { recursive: true });
    writeFileSync(EXPECTED, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  });
} else {
  const expected = JSON.parse(readFileSync(EXPECTED, "utf8")) as Record<
    string,
    { data: unknown; markdown: string }
  >;
  describe.each(Object.keys(CASES))("%s report", (name) => {
    const c = CASES[name]!;
    const old = expected[name]!;

    it("keeps `data` deep-equal to the pre-change output", async () => {
      const r = await run(c);
      expect(stable(r.data)).toEqual(stable(old.data));
    });

    it("writes the report sections in order", async () => {
      const md = (await run(c)).markdown;
      expect(md.startsWith("## ")).toBe(true);
      const at = [
        HEADINGS.inShort,
        HEADINGS.picture,
        HEADINGS.pieces,
        HEADINGS.details,
        HEADINGS.next,
      ]
        .map((h) => md.split("\n").indexOf(h))
        .filter((i) => i >= 0);
      expect(at).toEqual([...at].sort((a, b) => a - b));
      expect(md.split("\n")).toContain(HEADINGS.inShort);
      expect(md.split("\n")).toContain(HEADINGS.details);
    });

    it("In short is 1-4 plain sentences and passes the jargon lint", async () => {
      const md = (await run(c)).markdown;
      const inShort = section(md, "In short") ?? "";
      expect(inShort.length).toBeGreaterThan(0);
      expect(sentences(inShort)).toBeGreaterThanOrEqual(1);
      expect(sentences(inShort)).toBeLessThanOrEqual(4);
      expect(lint(inShort)).toEqual([]);
      const pieces = section(md, "What each piece does");
      if (pieces !== null) expect(lint(pieces)).toEqual([]);
    });

    it("Technical details still holds every name the old text held", async () => {
      const details = detailsOf((await run(c)).markdown);
      const missing = qnamesIn(old.markdown).filter((q) => !details.includes(q));
      expect(missing).toEqual([]);
    });

    it(`shows the picture ${c.picture ? "by default" : "only when the rule holds"}; mermaid: false removes it`, async () => {
      const call = prepare(c);
      const md = (await call()).markdown;
      if (c.picture) {
        expect(md.split("\n")).toContain(HEADINGS.picture);
        expect(md).toContain("```mermaid\nflowchart LR");
      }
      const off = await call({ mermaid: false });
      expect(off.markdown.split("\n")).not.toContain(HEADINGS.picture);
      expect(off.markdown).not.toContain("```mermaid");
      expect(stable(off.data)).toEqual(stable(old.data));
    });
  });

  // Cycle 3 T3 fix round 1: statements a reader sees must be true, and plain.
  describe("fix round 1 (task 3 review)", () => {
    const md = async (name: string, extra: Record<string, unknown> = {}) =>
      (await prepare(CASES[name]!)(extra)).markdown;
    const pieceLine = (text: string, name: string) =>
      (section(text, "What each piece does") ?? "")
        .split("\n")
        .find((l) => l.startsWith(`- \`${name}\`:`)) ?? "";

    it("I1: wip_impact counts only non-test Apex classes and triggers as having no test", async () => {
      const t = await md("wip_impact.local");
      const inShort = section(t, "In short") ?? "";
      expect(inShort).not.toContain("4 of them");
      expect(inShort).toContain("1 Apex trigger");
      expect(inShort).toContain("has no test");
      expect(inShort).toContain("1 is a test class");
      expect(inShort).toContain(
        "1 flow and 1 Lightning web component cannot carry Apex test coverage",
      );
      expect(pieceLine(t, "CaseServiceTest")).toContain("A test class.");
      expect(pieceLine(t, "CaseServiceTest")).not.toContain("No test covers it");
      expect(pieceLine(t, "Case_Flow")).toContain("Apex tests do not apply.");
      expect(pieceLine(t, "caseCard")).toContain("Apex tests do not apply.");
      expect(pieceLine(t, "CaseTrigger")).toContain("No test covers it.");
    });

    it("I2: a gap report that checked nothing says so", async () => {
      const inShort =
        section(await md("test_gap_intelligence_from_git_diff.ghost"), "In short") ?? "";
      expect(inShort).not.toContain("Every Apex class");
      expect(inShort).toContain(
        "No Apex classes or triggers were found in or affected by the change, so there was nothing to check for tests.",
      );
      expect(inShort).toContain("1 changed file is new or not loaded yet");
    });

    it("M2: what_broke does not count a flow or a screen part as having no tests", async () => {
      const t = await md("what_broke.changed");
      const inShort = section(t, "In short") ?? "";
      expect(inShort).not.toContain("3 have no tests");
      expect(inShort).toContain("1 Apex trigger");
      // Fix round 2: a kind first named in In short keeps its gloss there.
      expect(inShort).toContain(
        "1 flow (point-and-click automation) and 1 Lightning web component (a screen part) cannot carry Apex test coverage",
      );
      expect(pieceLine(t, "Case_Flow")).toContain("Apex tests do not apply.");
      // The pieces are glossed on their own first use, apart from In short.
      expect(pieceLine(t, "CaseHelper")).toContain("Apex class (server code)");
    });

    it("M1, M3: the flow map names the path, with the right article; containment is dotted", async () => {
      const t = await md("cross_layer_flow_map.lwc");
      const inShort = section(t, "In short") ?? "";
      expect(inShort).toContain("a Lightning web component");
      expect(inShort).toContain("`caseCard` calls `CaseService`, which calls `CaseHelper`");
      expect(section(t, "Picture")).toMatch(/-\.->\|(contains|has the field)\|/);
      expect(pieceLine(t, "Case.Priority__c")).toContain("Field on `Case`, read by `CaseService`");
      expect(pieceLine(t, "Case.Priority__c")).not.toContain("used by");
      expect(pieceLine(t, "Account.Tier__c")).toContain("written by `CaseHelper`");
    });

    it("a trigger's object says the trigger runs when its records change", async () => {
      const t = await md("trace_downstream.trigger");
      expect(pieceLine(t, "Case")).toContain(
        "the trigger `CaseTrigger` runs when `Case` records change",
      );
      expect(pieceLine(t, "Case")).not.toContain("used by");
    });

    it("M4: a kind is glossed once, and a plural takes a plural gloss", async () => {
      const t = await md("wip_diff.local");
      const top = t.slice(0, t.indexOf(HEADINGS.details));
      // Once in In short, once in the pieces (each section glosses on its own first use).
      expect((section(t, "In short") ?? "").match(/\(server code\)/g)).toHaveLength(1);
      expect((section(t, "What each piece does") ?? "").match(/\(server code\)/g)).toHaveLength(1);
      expect(top.length).toBeGreaterThan(0);
      expect(section(await md("cross_layer_flow_map.lwc"), "In short")).toContain(
        "2 objects (tables of records)",
      );
    });

    it("M5: explain_code on an Apex class with no stored source points to its methods", async () => {
      const r = await callTool("explain_code", { org: fix.orgId, qname: "ApexClass:CaseService" });
      const inShort = section(r.markdown, "In short") ?? "";
      expect(inShort).toContain("Source is stored per method");
      expect(inShort).not.toContain("Its code uses");
      expect(inShort).toContain("It links directly to");
    });
  });
}
