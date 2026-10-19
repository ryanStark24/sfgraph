import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { analyze, emitSarif, lintSarifReport } from "@ryanstark24/sfgraph-core";
import { getExportsDir, validateOrgIdentifier } from "@ryanstark24/sfgraph-shared";
import { getToolContext } from "../context.js";
import { getServerVersion } from "../version.js";
import { collectDeadCode, collectGovernorRisks, describeSource } from "./_analysis-cache.js";
import { defineTool, z } from "./_define.js";
import { andList, countNoun, renderReport } from "./_report.js";

/** Each audit in plain words: "the check for ...", and the noun for one of its findings. */
const ORDER = ["governor", "security", "dead-code", "dangling"] as const;
const AUDIT_PLAIN: Record<
  (typeof ORDER)[number],
  { check: string; one: string; many: string; prefix: string }
> = {
  governor: {
    check: "code that may hit Salesforce limits",
    one: "limit risk",
    many: "limit risks",
    prefix: "governor.",
  },
  security: {
    check: "access gaps and over-wide sharing",
    one: "access issue",
    many: "access issues",
    prefix: "security.",
  },
  "dead-code": {
    check: "unused code",
    one: "unused piece",
    many: "unused pieces",
    prefix: "dead-code.",
  },
  dangling: {
    check: "broken links",
    one: "broken link",
    many: "broken links",
    prefix: "graph.dangling",
  },
};

/** The tool that lists one check's findings in full; dangling links have none. */
const AUDIT_TOOL: Record<(typeof ORDER)[number], string | null> = {
  governor: "governor_risk_check",
  security: "security_audit",
  "dead-code": "dead_code_audit",
  dangling: null,
};

/** "a", "a or b", "a, b or c". */
const orList = (xs: readonly string[]): string =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`;

/** A path with the home folder shown as `~`, so no user name lands in the text. */
export function tildePath(p: string): string {
  const home = homedir();
  if (p === home) return "~";
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

const within = (p: string, dir: string): boolean => {
  const rel = path.relative(dir, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** The real path of `p`'s deepest existing ancestor (or `p` itself). */
function realAncestor(p: string): string {
  let cur = p;
  for (;;) {
    try {
      return realpathSync(cur);
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return cur;
      cur = up;
    }
  }
}

type Saved = { ok: true; file: string } | { ok: false; reason: string };

/**
 * Write the SARIF report under the exports dir: `<org>.sarif` by default, or `out_path` resolved
 * under that dir. Refused: a path that leaves the dir (`..`, an absolute path elsewhere, a symlink
 * that points out), the dir itself, and a name not ending in `.sarif`. Written to a temp file,
 * then renamed into place, so a reader never sees half a file.
 */
export function saveSarif(org: string, outPath: string | undefined, report: unknown): Saved {
  const dir = path.resolve(getExportsDir());
  const shownDir = `\`${tildePath(dir)}\``;
  let target: string;
  if (outPath === undefined) {
    try {
      target = path.join(dir, `${validateOrgIdentifier(org)}.sarif`);
    } catch {
      return { ok: false, reason: "the org name cannot be used as a file name; pass `out_path`" };
    }
  } else {
    target = path.resolve(dir, outPath);
    const rel = path.relative(dir, target);
    if (
      outPath.includes("\0") ||
      outPath.split(/[\\/]/).includes("..") ||
      rel === "" ||
      rel.startsWith("..") ||
      path.isAbsolute(rel)
    ) {
      return {
        ok: false,
        reason: `\`out_path\` must name a file inside the exports folder ${shownDir}`,
      };
    }
  }
  if (path.extname(target).toLowerCase() !== ".sarif") {
    return { ok: false, reason: "`out_path` must end in `.sarif`" };
  }
  let tmp: string | null = null;
  try {
    mkdirSync(dir, { recursive: true });
    const realDir = realpathSync(dir);
    const parent = path.dirname(target);
    // Checked before any folder is made, so a symlink that points out creates nothing outside.
    if (!within(realAncestor(parent), realDir)) {
      return {
        ok: false,
        reason: `a link inside the exports folder ${shownDir} points outside it`,
      };
    }
    mkdirSync(parent, { recursive: true });
    const realParent = realpathSync(parent);
    if (!within(realParent, realDir)) {
      return {
        ok: false,
        reason: `a link inside the exports folder ${shownDir} points outside it`,
      };
    }
    const final = path.join(realParent, path.basename(target));
    try {
      if (lstatSync(final).isDirectory())
        return { ok: false, reason: "a folder already has that name" };
    } catch {
      // not there yet
    }
    tmp = path.join(
      realParent,
      `.${path.basename(target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
    );
    writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(tmp, final);
    tmp = null;
    return { ok: true, file: target };
  } catch (e) {
    return {
      ok: false,
      reason: `the file could not be written (\`${(e as Error).message.split(homedir()).join("~")}\`)`,
    };
  } finally {
    if (tmp) rmSync(tmp, { force: true });
  }
}

const inputSchema = z.object({
  org: z.string().min(1),
  /** Which audits to include. Default = everything available. */
  audits: z
    .array(z.enum(["governor", "security", "dead-code", "dangling"]))
    .default(["governor", "security", "dead-code", "dangling"]),
  /** Include governor risks in test code (same switch as governor_risk_check). */
  includeTests: z.boolean().default(false),
  /** File to write, inside the exports folder; default `<org>.sarif`. */
  out_path: z.string().min(1).max(512).optional(),
});

defineTool({
  name: "export_sarif",
  description:
    "Export governor, security, dead-code and dangling-link findings as one SARIF 2.1.0 file for CI: `<org>.sarif` in the sfgraph exports folder, or `out_path` inside it (overwritten).",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const audits = new Set(input.audits);

    const collectArgs: Parameters<typeof analyze.collectFindings>[0] = {};
    // Where each audit's results came from. Dead code reads the
    // `_sfgraph_dead_code_scores` cache when it is fresh (equivalent to the
    // live scan); a stale cache (computed before the last sync, or a sync in
    // progress) is ignored and reported here. Governor uses the same
    // live-plus-cache merge as governor_risk_check; security and dangling
    // have no equivalent cache and are always live.
    const sources: Record<string, string> = {};
    if (audits.has("governor")) {
      const g = collectGovernorRisks(ctx, { includeTests: input.includeTests });
      collectArgs.governor = g.risks;
      sources.governor = describeSource(g.source, g.cache);
    }
    if (audits.has("security")) {
      collectArgs.security = analyze.securityAudit(ctx.graphStore, ctx.orgId);
      sources.security = "live";
    }
    if (audits.has("dead-code")) {
      const dc = collectDeadCode(ctx);
      collectArgs.deadCode = dc.nodes;
      sources["dead-code"] = describeSource(dc.source, dc.cache);
    }
    if (audits.has("dangling")) {
      collectArgs.dangling = analyze.auditDanglingEdges(ctx.graphStore, ctx.orgId, {
        sampleSize: 1000,
      });
      sources.dangling = "live";
    }
    const findings = analyze.collectFindings(collectArgs);
    const report = emitSarif({ version: getServerVersion(), findings });
    const lintErrors = lintSarifReport(report);

    const countsByRule = new Map<string, number>();
    for (const f of findings) {
      countsByRule.set(f.ruleId, (countsByRule.get(f.ruleId) ?? 0) + 1);
    }
    const ruleSummary = [...countsByRule.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([rule, n]) => `${rule}: ${n}`)
      .join(", ");

    const saved = saveSarif(input.org, input.out_path, report);
    const shown = saved.ok ? tildePath(saved.file) : "";
    const oldMd = [
      `**SARIF 2.1.0** — ${findings.length} finding${findings.length === 1 ? "" : "s"}`,
      "",
      ...(lintErrors.length > 0
        ? ["⚠️ Schema lint warnings:", ...lintErrors.map((e) => `- \`${e}\``), ""]
        : []),
      `_sources: ${Object.entries(sources)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}_`,
      "",
      saved.ok
        ? `Saved to \`${shown}\`. Upload it to GitHub Code Scanning with the \`github/codeql-action/upload-sarif\` action.`
        : `Not saved: ${saved.reason}.`,
    ].join("\n");
    const ran = ORDER.filter((a) => audits.has(a));
    const level = (l: string) => findings.filter((f) => f.level === l).length;
    const severities = [
      ...(level("error") ? [`${level("error")} serious`] : []),
      ...(level("warning") ? [countNoun(level("warning"), "warning")] : []),
      ...(level("note") ? [countNoun(level("note"), "note")] : []),
    ];
    const perAudit = ran
      .map((a) => ({
        a,
        n: findings.filter((f) => f.ruleId.startsWith(AUDIT_PLAIN[a].prefix)).length,
      }))
      .filter((x) => x.n > 0)
      .map((x) => countNoun(x.n, AUDIT_PLAIN[x.a].one, AUDIT_PLAIN[x.a].many));
    const listTools = ran.flatMap((a) => (AUDIT_TOOL[a] ? [AUDIT_TOOL[a]] : []));
    const markdown = renderReport({
      title: "Audit findings exported for code scanning",
      inShort: [
        ran.length === 0
          ? "No checks selected: `audits` is empty, so the report has no findings; pass at least one check."
          : findings.length === 0
            ? `Exported 0 findings: the checks for ${andList(ran.map((a) => AUDIT_PLAIN[a].check))} found nothing.`
            : `Exported ${countNoun(findings.length, "finding")}: ${andList(severities)}.`,
        ...(findings.length > 0 ? [`By check: ${andList(perAudit)}.`] : []),
        saved.ok
          ? `Saved the report to \`${shown}\`; upload it to GitHub code scanning.`
          : `The report was not saved: ${saved.reason}.`,
        ...(lintErrors.length > 0
          ? [
              `The report has ${countNoun(lintErrors.length, "format problem")}, listed under Technical details.`,
            ]
          : []),
      ],
      details: oldMd,
      next: [
        // Name only the tools whose checks ran (dangling links have no tool of their own).
        ...(findings.length > 0 && listTools.length > 0
          ? [
              `Run ${orList(listTools.map((t) => `\`${t}\``))} for the full list of ${listTools.length === 1 ? "the" : "one"} check.`,
            ]
          : []),
        ...(input.includeTests || !audits.has("governor")
          ? []
          : ["Governor test code is excluded by default; pass `includeTests: true` to keep it."]),
      ],
    });
    return {
      summary:
        findings.length === 0
          ? `0 findings — emitted empty SARIF report${saved.ok ? ` — saved to ${shown}` : " — not saved"}`
          : `${findings.length} findings across ${countsByRule.size} rules (${ruleSummary})${saved.ok ? ` — saved to ${shown}` : " — not saved"}`,
      markdown,
      data: { report, findings, lintErrors, sources },
      follow_up_tools: ["governor_risk_check", "security_audit", "dead_code_audit"],
    };
  },
});
