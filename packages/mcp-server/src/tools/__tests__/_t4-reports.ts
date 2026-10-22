import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getExportsDir, getSfgraphPaths } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setToolContextFactory } from "../../context.js";
import { HEADINGS } from "../_report.js";
import { tildePath } from "../export_sarif.js";
import { __setListOrgsDeps } from "../list_orgs.js";
import { type Fixture, REL_TYPES, createFixture } from "./_fixture.js";
import { lint, section, stripCode } from "./_jargon.js";
import { callTool } from "./_runner.js";

/**
 * Cycle 3 T4: the audit, search, diff and export tools write a human report (In short, What each
 * piece does, Technical details, What to check next) around today's lossless text; the utility
 * tools get one plain In short line on top of their unchanged text.
 *
 * expected/t4-reports.json holds each case's `data` and markdown as the tools returned them before
 * the report change (captured with T4_CAPTURE=1 on the pre-change code). `data` must stay
 * deep-equal; the old text must still be there (whole, for the utility tools; every qualified
 * name, for the report tools).
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXPECTED = path.join(HERE, "expected", "t4-reports.json");
const CAPTURE = process.env.T4_CAPTURE === "1";

let fix: Fixture;
let fixB: Fixture;
let listDir: string;
/** export_sarif writes here (SFGRAPH_EXPORTS_DIR), one fresh dir per test. */
let exportsDir = "";
let prevExports: string | undefined;

const OLD = 1_000_000_000_000; // 2001: older than a year, so dead code scores high confidence

function seed(f: Fixture): void {
  const n = (q: string, label: string, attributes?: Record<string, unknown>) =>
    f.addNode({
      qualifiedName: q,
      label,
      lastModifiedAt: OLD,
      ...(attributes ? { attributes } : {}),
    });
  const e = (src: string, dst: string, rel: string, attributes?: Record<string, unknown>) =>
    f.addEdge({
      srcQualifiedName: src,
      dstQualifiedName: dst,
      relType: rel,
      ...(attributes ? { attributes } : {}),
    });
  n("ApexClass:CaseService", "ApexClass");
  n("ApexMethod:CaseService.run(0)", "ApexMethod");
  n("ApexMethod:CaseService.save(1)", "ApexMethod");
  n("ApexClass:OrderService", "ApexClass");
  n("ApexMethod:OrderService.load(0)", "ApexMethod");
  n("ApexClass:OldHelper", "ApexClass");
  n("Flow:Old_Flow", "Flow");
  n("LWC:caseCard", "LWC");
  n("CustomObject:Case", "CustomObject");
  n("CustomField:Case.Priority__c", "CustomField");
  n("CustomField:Account.SSN__c", "CustomField");
  n("PermissionSet:Support", "PermissionSet");
  n("SharingRule:Case.OpenAll", "SharingRule", { accessLevel: "All" });
  e("ApexClass:CaseService", "ApexMethod:CaseService.run(0)", REL_TYPES.CONTAINS_METHOD);
  e("ApexClass:CaseService", "ApexMethod:CaseService.save(1)", REL_TYPES.CONTAINS_METHOD);
  e("ApexClass:OrderService", "ApexMethod:OrderService.load(0)", REL_TYPES.CONTAINS_METHOD);
  e("LWC:caseCard", "ApexMethod:CaseService.run(0)", REL_TYPES.CALLS_APEX_FROM_LWC);
  e("ApexMethod:CaseService.run(0)", "CustomObject:Case", "EXECUTES_SOQL", {
    inLoop: true,
    query: "[SELECT Id FROM Case]",
  });
  e("ApexMethod:CaseService.save(1)", "DML:update", "EXECUTES_DML", {
    inLoop: true,
    target: "cases",
  });
  e("ApexMethod:OrderService.load(0)", "CustomObject:Order", "EXECUTES_SOQL", {
    inLoop: true,
    query: "[SELECT Id FROM Order]",
  });
  e("PermissionSet:Support", "CustomField:Case.Priority__c", REL_TYPES.GRANTS_FIELD_ACCESS);
}

/** Org B for the two-org tools: one class changed, one only in B, OldHelper only in A. */
function seedB(f: Fixture): void {
  f.addNode({ qualifiedName: "ApexClass:CaseService", label: "ApexClass", sourceHash: "v2" });
  f.addNode({ qualifiedName: "ApexClass:OrderService", label: "ApexClass" });
  f.addNode({ qualifiedName: "ApexClass:NewThing", label: "ApexClass" });
}

interface Case {
  tool: string;
  args: Record<string, unknown>;
  /** Extra setup after the shared graph is seeded; returns extra args. */
  setup?: (f: Fixture) => Record<string, unknown> | undefined;
  /** A utility tool: a plain In short line on top of the old text, no other sections. */
  utility?: boolean;
  /** Start from an empty graph instead of the shared seed. */
  empty?: boolean;
}

const snapshotThenChange = (f: Fixture) => {
  const snap = f.ctx.snapshotStore.createSnapshot(f.orgId, "before", true);
  f.addNode({ qualifiedName: "ApexClass:CaseService", label: "ApexClass", sourceHash: "v2" });
  f.addNode({ qualifiedName: "ApexClass:Brand_New", label: "ApexClass" });
  return { from: snap.id };
};

/** A stub vector index: `CaseService` has a vector; its neighbours are fixed. */
const withVectors = (f: Fixture) => {
  const v = new Float32Array([1, 0]);
  (f.ctx as { vectorStore?: unknown }).vectorStore = {
    getNodeVector: (_o: unknown, q: string) => (q === "ApexClass:CaseService" ? v : null),
    countNodeVectors: () => 4,
    searchNodes: () => [
      { qname: "ApexClass:OrderService", label: "ApexClass", distance: 0.5 },
      { qname: "ApexClass:OldHelper", label: "ApexClass", distance: 1.1 },
      { qname: "LWC:caseCard", label: "LWC", distance: 1.3 },
    ],
  };
  return undefined;
};

const CASES: Record<string, Case> = {
  "governor_risk_check.risks": { tool: "governor_risk_check", args: {} },
  "governor_risk_check.limited": { tool: "governor_risk_check", args: { limit: 1 } },
  "governor_risk_check.none": { tool: "governor_risk_check", args: {}, empty: true },
  "dead_code_audit.all": { tool: "dead_code_audit", args: {} },
  "dead_code_audit.flow": { tool: "dead_code_audit", args: { label: "Flow" } },
  "dead_code_audit.none": { tool: "dead_code_audit", args: { pattern: "Nothing*" } },
  "dead_code_audit.unscored": { tool: "dead_code_audit", args: { label: "CustomObject" } },
  "dead_code_audit.unknown": { tool: "dead_code_audit", args: { label: "Nope" } },
  "security_audit.all": { tool: "security_audit", args: {} },
  "security_audit.none": { tool: "security_audit", args: {}, empty: true },
  "security_audit.field": {
    tool: "security_audit",
    args: { field: "CustomField:Case.Priority__c" },
  },
  "security_audit.ghostfield": {
    tool: "security_audit",
    args: { field: "CustomField:Case.Ghost__c" },
  },
  "find_similar.qname": {
    tool: "find_similar",
    args: { qname: "ApexClass:CaseService" },
    setup: withVectors,
  },
  "find_similar.ghost": { tool: "find_similar", args: { qname: "ApexClass:Ghost" } },
  "find_similar.nothing": { tool: "find_similar", args: { qname: "Flow:Old_Flow" } },
  "find_nodes.service": { tool: "find_nodes", args: { pattern: "ApexClass:*Service" } },
  "find_nodes.limited": { tool: "find_nodes", args: { pattern: "*:*", limit: 2 } },
  "find_nodes.none": { tool: "find_nodes", args: { pattern: "Flow:Nothing*" } },
  "cross_org_diff.ab": { tool: "cross_org_diff", args: { org_a: "org1", org_b: "orgB" } },
  "cross_org_diff.same": { tool: "cross_org_diff", args: { org_a: "org1", org_b: "org1" } },
  "point_in_time_diff.changed": {
    tool: "point_in_time_diff",
    args: {},
    setup: snapshotThenChange,
  },
  "point_in_time_diff.nochange": {
    tool: "point_in_time_diff",
    args: {},
    setup: (f) => ({ from: f.ctx.snapshotStore.createSnapshot(f.orgId, "s", true).id }),
  },
  "export_sarif.all": { tool: "export_sarif", args: {} },
  "export_sarif.none": { tool: "export_sarif", args: {}, empty: true },
  "deployment_manifest_gen.ab": {
    tool: "deployment_manifest_gen",
    args: { from_org: "org1", to_org: "orgB" },
  },
  "ping.ok": { tool: "ping", args: {}, utility: true },
  "list_orgs.none": { tool: "list_orgs", args: {}, utility: true },
  "snapshot_create.named": {
    tool: "snapshot_create",
    args: { name: "before-release" },
    utility: true,
  },
  "snapshot_list.one": {
    tool: "snapshot_list",
    args: {},
    utility: true,
    setup: (f) => {
      f.ctx.snapshotStore.createSnapshot(f.orgId, "nightly", true);
      return undefined;
    },
  },
  "snapshot_list.none": { tool: "snapshot_list", args: {}, utility: true },
  "get_ingest_job.unknown": { tool: "get_ingest_job", args: { job_id: "job-1" }, utility: true },
  "staleness_check.never": { tool: "staleness_check", args: {}, utility: true },
  "freshness_report.all": { tool: "freshness_report", args: {}, utility: true },
  "start_ingest_job.live": {
    tool: "start_ingest_job",
    args: { source: { type: "live-org", alias: "dev" } },
    utility: true,
  },
};

/** Tools that take no `org` argument. */
const NO_ORG = new Set([
  "ping",
  "list_orgs",
  "get_ingest_job",
  "start_ingest_job",
  "cross_org_diff",
  "deployment_manifest_gen",
]);

let prevFallback: string | undefined;

async function fresh(c: Case): Promise<void> {
  await fix?.cleanup();
  await fixB?.cleanup();
  fixB = await createFixture("orgB");
  seedB(fixB);
  fix = await createFixture("org1");
  if (!c.empty) seed(fix);
  const a = fix.ctx;
  const b = fixB.ctx;
  setToolContextFactory(async ({ orgId }) => (orgId === "orgB" ? b : a));
}

/** Registers the hooks and tests: the report matrix for cases [from, to), plus the other blocks when `rest`. Split over several files so no one file keeps a Windows CI worker busy past vitest's 60 s RPC timeout. */
export function registerT4Reports(part: { from: number; to?: number; rest: boolean }): void {
  beforeEach(() => {
    listDir = mkdtempSync(path.join(tmpdir(), "sfg-t4-orgs-"));
    exportsDir = mkdtempSync(path.join(tmpdir(), "sfg-t4-exports-"));
    prevExports = process.env.SFGRAPH_EXPORTS_DIR;
    process.env.SFGRAPH_EXPORTS_DIR = exportsDir;
    __setListOrgsDeps({ dataDir: listDir, openDb: () => null });
    prevFallback = process.env.SFGRAPH_ALIAS_SF_FALLBACK;
    // biome-ignore lint/performance/noDelete: assigning undefined to process.env coerces to the string "undefined"
    delete process.env.SFGRAPH_ALIAS_SF_FALLBACK;
  });

  afterEach(async () => {
    __setListOrgsDeps(null);
    rmSync(listDir, { recursive: true, force: true });
    rmSync(exportsDir, { recursive: true, force: true });
    if (prevExports === undefined) {
      // biome-ignore lint/performance/noDelete: assigning undefined to process.env coerces to the string "undefined"
      delete process.env.SFGRAPH_EXPORTS_DIR;
    } else process.env.SFGRAPH_EXPORTS_DIR = prevExports;
    await fix?.cleanup();
    await fixB?.cleanup();
    if (prevFallback !== undefined) process.env.SFGRAPH_ALIAS_SF_FALLBACK = prevFallback;
  });

  /** Builds the case's graph, runs its setup once, then returns a caller (extra args on top). */
  async function prepare(c: Case) {
    await fresh(c);
    const more = c.setup?.(fix) ?? {};
    return (extra: Record<string, unknown> = {}) =>
      callTool(c.tool, {
        ...(NO_ORG.has(c.tool) ? {} : { org: fix.orgId }),
        ...c.args,
        ...more,
        ...extra,
      });
  }
  const run = async (c: Case) => (await prepare(c))();

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

  /** Run-time values (timestamps, snapshot ids, temp paths) made equal between runs. */
  const stableText = (t: string): string =>
    (exportsDir ? t.split(exportsDir).join("<exports>") : t)
      // The saved path uses the native separator (`\` on Windows).
      .replace(/<exports>\\+/g, "<exports>/")
      .replace(/snap_[0-9a-f-]{36}/g, "snap_X")
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "T")
      .replace(/\b(manual|scheduled)-T\b/g, "$1-T")
      // SARIF names the sfgraph release; a version bump is not a report change.
      .replace(/("name":"sfgraph","version":)"[^"]+"/g, '$1"<version>"');
  const stable = (d: unknown): unknown =>
    JSON.parse(stableText(JSON.stringify(d ?? null)), (k, v) =>
      (/At$/.test(k) || k === "ts") && typeof v === "number" ? 0 : v,
    );

  const sentences = (t: string): number =>
    (stripCode(t).match(/[.!?](?=\s|$)/g) ?? []).length || (t.trim() ? 1 : 0);

  const HEADING_LINES = new Set<string>(Object.values(HEADINGS));

  if (CAPTURE) {
    if (part.from !== 0) return;
    it("captures the pre-change outputs", async () => {
      const out: Record<string, { data: unknown; markdown: string }> = {};
      for (const [name, c] of Object.entries(CASES)) {
        const r = await run(c);
        out[name] = { data: stable(r.data), markdown: stableText(r.markdown) };
      }
      mkdirSync(path.dirname(EXPECTED), { recursive: true });
      writeFileSync(EXPECTED, `${JSON.stringify(out, null, 2)}\n`, "utf8");
    });
  } else {
    const expected = JSON.parse(readFileSync(EXPECTED, "utf8")) as Record<
      string,
      { data: unknown; markdown: string }
    >;
    describe.each(Object.keys(CASES).slice(part.from, part.to))("%s report", (name) => {
      const c = CASES[name]!;
      const old = expected[name]!;

      it("keeps `data` deep-equal to the pre-change output", async () => {
        const r = await run(c);
        expect(stable(r.data)).toEqual(old.data);
      });

      it("In short is 1-4 plain sentences and passes the jargon lint", async () => {
        const md = (await run(c)).markdown;
        // A utility tool's In short is its one line; the old text follows it.
        const inShort = c.utility ? (md.split("\n")[1] ?? "") : (section(md, "In short") ?? "");
        expect(inShort.length).toBeGreaterThan(0);
        expect(sentences(inShort)).toBeGreaterThanOrEqual(1);
        expect(sentences(inShort)).toBeLessThanOrEqual(4);
        expect(lint(inShort)).toEqual([]);
        const pieces = section(md, "What each piece does");
        if (pieces !== null) expect(lint(pieces)).toEqual([]);
      });

      if (c.utility) {
        it("is one In short line on top of the unchanged old text, with no other sections", async () => {
          const md = (await run(c)).markdown;
          const lines = md.split("\n");
          expect(lines[0]).toBe(HEADINGS.inShort);
          expect(lines[1]!.trim().length).toBeGreaterThan(0);
          expect(lines[2]).toBe("");
          expect(lines.slice(1).filter((l) => HEADING_LINES.has(l))).toEqual([]);
          expect(md.startsWith("## ")).toBe(false);
          expect(stableText(lines.slice(3).join("\n"))).toBe(old.markdown);
        });
      } else {
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

        it("Technical details still holds the old text and every name in it", async () => {
          const details = stableText(detailsOf((await run(c)).markdown));
          const missing = qnamesIn(old.markdown).filter((q) => !details.includes(q));
          expect(missing).toEqual([]);
          expect(details).toContain(old.markdown);
        });
      }
    });
    if (part.rest) {
      // Statements a reader sees must be true: counts name what was counted; nothing found says what
      // was checked.
      describe("true statements", () => {
        const md = async (name: string, extra: Record<string, unknown> = {}) =>
          (await (await prepare(CASES[name]!))(extra)).markdown;
        const inShortOf = async (name: string) => section(await md(name), "In short") ?? "";
        const inShortOf2 = async (name: string, extra: Record<string, unknown>) =>
          section(await md(name, extra), "In short") ?? "";
        const pieceLine = (text: string, name: string) =>
          (section(text, "What each piece does") ?? "")
            .split("\n")
            .find((l) => l.startsWith(`- \`${name}\`:`)) ?? "";

        it("export_sarif gives the findings by severity in plain words and the saved file's path", async () => {
          const r = await (await prepare(CASES["export_sarif.all"]!))();
          const findings = (r.data as { findings: { level: string }[] }).findings;
          const n = (l: string) => findings.filter((f) => f.level === l).length;
          expect(n("error")).toBe(3);
          const inShort = section(r.markdown, "In short") ?? "";
          expect(inShort).toContain(`Exported ${findings.length} findings`);
          expect(inShort).toContain(`${n("error")} serious`);
          expect(inShort).toContain(`${n("warning")} warning`);
          expect(inShort).toContain(`${n("note")} notes`);
          const file = path.join(exportsDir, "org1.sarif");
          expect(inShort).toContain(`Saved the report to \`${file}\``);
          expect(detailsOf(r.markdown)).toContain(file);
          expect(r.summary).toContain(file);
        });

        it("export_sarif writes <org>.sarif in the exports dir, equal to the report in data, same bytes each run", async () => {
          const call = await prepare(CASES["export_sarif.all"]!);
          const r = await call();
          const file = path.join(exportsDir, "org1.sarif");
          const first = readFileSync(file, "utf8");
          expect(JSON.parse(first)).toEqual((r.data as { report: unknown }).report);
          await call();
          expect(readFileSync(file, "utf8")).toBe(first);
          // Only the file: no temp file is left behind.
          expect(readdirSync(exportsDir)).toEqual(["org1.sarif"]);
        });

        it("export_sarif resolves a relative out_path, and an absolute one inside the exports dir, under the exports dir", async () => {
          const call = await prepare(CASES["export_sarif.all"]!);
          const r = await call({ out_path: "ci/run1.sarif" });
          const file = path.join(exportsDir, "ci", "run1.sarif");
          expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(
            (r.data as { report: unknown }).report,
          );
          expect(section(r.markdown, "In short")).toContain(file);
          const abs = path.join(exportsDir, "abs.sarif");
          await call({ out_path: abs });
          expect(existsSync(abs)).toBe(true);
        });

        it("export_sarif refuses paths that escape the exports dir or are not .sarif, and writes nothing", async () => {
          const call = await prepare(CASES["export_sarif.all"]!);
          const outside = mkdtempSync(path.join(tmpdir(), "sfg-t4-outside-"));
          try {
            symlinkSync(outside, path.join(exportsDir, "link"));
            const before = await call();
            const data = stable(before.data);
            rmSync(path.join(exportsDir, "org1.sarif"));
            for (const out_path of [
              "../x.sarif",
              "a/../../x.sarif",
              path.join(outside, "x.sarif"),
              "link/x.sarif",
              "report.json",
              exportsDir,
            ]) {
              const r = await call({ out_path });
              const inShort = section(r.markdown, "In short") ?? "";
              expect(inShort, out_path).toContain("The report was not saved");
              expect(inShort, out_path).toContain("Exported 11 findings");
              expect(stable(r.data), out_path).toEqual(data);
            }
            expect(readdirSync(outside)).toEqual([]);
            expect(readdirSync(exportsDir)).toEqual(["link"]);
          } finally {
            rmSync(outside, { recursive: true, force: true });
          }
        });

        it("the exports dir is SFGRAPH_EXPORTS_DIR, else <data dir>/exports; paths under home show as ~", () => {
          expect(getExportsDir()).toBe(exportsDir);
          // biome-ignore lint/performance/noDelete: assigning undefined to process.env coerces to the string "undefined"
          delete process.env.SFGRAPH_EXPORTS_DIR;
          expect(getExportsDir()).toBe(path.join(getSfgraphPaths().data, "exports"));
          process.env.SFGRAPH_EXPORTS_DIR = exportsDir;
          expect(tildePath(path.join(homedir(), "a", "b.sarif"))).toBe(
            `~${path.sep}${path.join("a", "b.sarif")}`,
          );
          expect(tildePath("/elsewhere/b.sarif")).toBe("/elsewhere/b.sarif");
          expect(tildePath(`${homedir()}x/b.sarif`)).toBe(`${homedir()}x/b.sarif`);
        });

        it("export_sarif with nothing found says what was checked", async () => {
          const inShort = await inShortOf("export_sarif.none");
          expect(inShort).toContain("Exported 0 findings");
          expect(inShort).toMatch(/limit|access|unused|broken links/);
        });

        it("governor groups its findings: 3 high-risk spots in 2 Apex classes", async () => {
          const t = await md("governor_risk_check.risks");
          const inShort = section(t, "In short") ?? "";
          expect(inShort).toContain("3 high-risk spots in 2 Apex classes");
          expect(inShort).toContain("2 database queries inside a loop");
          expect(inShort).toContain("1 record save inside a loop");
          expect(pieceLine(t, "CaseService")).toContain("2 high-risk spots");
          expect(pieceLine(t, "OrderService")).toContain("1 high-risk spot");
        });

        it("governor counts the true total when the list is limited", async () => {
          const inShort = await inShortOf("governor_risk_check.limited");
          expect(inShort).toContain("3 high-risk spots in 2 Apex classes");
          expect(inShort).toContain("the first 1 is listed");
        });

        it("governor with nothing found says what was checked", async () => {
          const inShort = await inShortOf("governor_risk_check.none");
          expect(inShort).toContain("No spots found");
          expect(inShort).toMatch(/Checked: Apex methods and triggers/);
        });

        it("dead_code_audit counts by kind and confidence, and says nothing matched with a filter", async () => {
          const all = await inShortOf("dead_code_audit.all");
          expect(all).toMatch(/\d+ pieces? (looks?|seem) unused/);
          expect(all).toContain("high confidence");
          const none = await inShortOf("dead_code_audit.none");
          expect(none).toContain("No unused code found");
          expect(none).toContain("`Nothing*`");
        });

        it("dead_code_audit on a kind with no pieces says nothing was checked", async () => {
          const inShort = await inShortOf("dead_code_audit.unknown");
          expect(inShort).toContain("nothing was checked");
        });

        it("security_audit counts gaps and full-access rules; a missing field is not checked", async () => {
          const all = await inShortOf("security_audit.all");
          expect(all).toContain("1 field");
          expect(all).toContain("1 sharing rule");
          const field = await inShortOf("security_audit.field");
          expect(field).toContain("No field access gaps");
          expect(field).toMatch(/Checked: the field/);
          const ghost = await inShortOf("security_audit.ghostfield");
          expect(ghost).toContain("is not in the graph, so no field access was checked");
          expect(ghost).not.toMatch(/Checked: the field/);
          expect(ghost).toContain("Checked: every sharing rule.");
        });

        it("security_audit with no field in scope says no field access was checked", async () => {
          const nope = await inShortOf2("security_audit.all", { object: "Nope" });
          expect(nope).toContain(
            "No fields on `Nope` were found in the graph, so no field access was checked.",
          );
          expect(nope).not.toContain("No field access gaps");
          expect(nope).toContain("Checked: every sharing rule.");
          const notField = await inShortOf2("security_audit.all", {
            field: "ApexClass:CaseService",
          });
          expect(notField).toContain("is not a field, so no field access was checked");
          const empty = await inShortOf("security_audit.none");
          expect(empty).toContain(
            "No fields were found in the graph, so no field access was checked.",
          );
        });

        it("security_audit names edit-or-full access plainly", async () => {
          const t = await md("security_audit.all");
          expect(section(t, "In short")).toContain("others edit the records (edit or full access)");
          expect(pieceLine(t, "Case.OpenAll")).toContain(
            "lets others edit the records (edit or full access)",
          );
        });

        it("list_orgs with no orgs says the command-line logins were not read", async () => {
          const t = await md("list_orgs.none");
          expect(t.split("\n")[1]).toContain(
            "No orgs found: no loaded graphs, and the install-time login list is empty.",
          );
          expect(t.split("\n")[1]).toContain(
            "Logins saved by the Salesforce command line were not read.",
          );
        });

        it("list_orgs says when the command-line logins could not be read", async () => {
          process.env.SFGRAPH_ALIAS_SF_FALLBACK = "1";
          __setListOrgsDeps({
            dataDir: listDir,
            openDb: () => null,
            loadSfCore: async () => {
              throw new Error("no sf here");
            },
            resolveDefaultOrgAlias: async () => null,
          });
          const r = await callTool("list_orgs", {});
          expect((r.markdown as string).split("\n")[1]).toContain(
            "the Salesforce command line logins could not be read here",
          );
        });

        it("freshness_report scans Lightning web components and counts the kinds it scanned", async () => {
          const t = await md("freshness_report.all");
          const line = t.split("\n")[1] ?? "";
          expect(line).toContain("Checked when each of 6 pieces was last changed:");
          expect(line).toContain("1 Lightning web component");
          expect(line).toContain("3 Apex classes");
          expect(line).toContain("6 dead (over a year ago)");
        });

        it("dead_code_audit says 'only the first is listed' for one, and shows no score in the pieces", async () => {
          const t = await md("dead_code_audit.all", { limit: 1 });
          const inShort = section(t, "In short") ?? "";
          expect(inShort).not.toContain("the first 1 are");
          expect(inShort).toContain("only the first is listed");
          expect(section(t, "What each piece does") ?? "").not.toContain("score");
        });

        it("find_nodes counts by kind and says when the list is cut", async () => {
          expect(await inShortOf("find_nodes.service")).toContain("2 Apex classes");
          expect(await inShortOf("find_nodes.limited")).toContain("the first 2 are listed");
          expect(await inShortOf("find_nodes.none")).toContain("No piece");
        });

        it("find_similar counts the matches and the hidden weaker ones", async () => {
          const t = await md("find_similar.qname");
          const inShort = section(t, "In short") ?? "";
          // Cycle 3 T6: the default min_similarity is 0.4, so OldHelper (0.395) is hidden with caseCard.
          expect(inShort).toContain("1 piece similar to the Apex class `CaseService`");
          expect(inShort).toContain(
            "2 weaker matches were hidden below the similarity floor of 0.4",
          );
          expect(pieceLine(t, "OrderService")).toContain("similarity 0.875");
        });

        it("find_similar on an unknown name says nothing was compared", async () => {
          expect(await inShortOf("find_similar.ghost")).toContain("nothing was compared");
        });

        it("cross_org_diff counts each side; the same org twice says no differences", async () => {
          const ab = await inShortOf("cross_org_diff.ab");
          expect(ab).toContain("only in `org1`");
          expect(ab).toContain("only in `orgB`");
          expect(ab).toContain("1 is in both with different source");
          expect(await inShortOf("cross_org_diff.same")).toContain("No differences");
        });

        it("point_in_time_diff counts components; no change says nothing changed", async () => {
          const ch = await inShortOf("point_in_time_diff.changed");
          expect(ch).toContain("2 components are different: 1 added and 1 changed");
          expect(ch).not.toContain("0 removed");
          expect(await inShortOf("point_in_time_diff.nochange")).toContain("Nothing changed");
        });

        it("deployment_manifest_gen counts what each file lists", async () => {
          const inShort = await inShortOf("deployment_manifest_gen.ab");
          expect(inShort).toContain("lists 8 components to deploy");
          // The fixture's standard Case object exists in org1 only: left out, and said so.
          expect(inShort).toContain("1 standard Salesforce item found in only one org");
          expect(inShort).toContain("lists 1 component to remove");
        });
      });
    }
  }
}
