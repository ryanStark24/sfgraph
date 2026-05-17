import { analyze, emitSarif, lintSarifReport } from "@ryanstark24/sfgraph-core";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";

const inputSchema = z.object({
  org: z.string().min(1),
  /** Which audits to include. Default = everything available. */
  audits: z
    .array(z.enum(["governor", "security", "dead-code", "dangling"]))
    .default(["governor", "security", "dead-code", "dangling"]),
});

defineTool({
  name: "export_sarif",
  description:
    "Export every sfgraph audit finding (governor risks, security gaps, dead code, dangling edges) as a single SARIF 2.1.0 report. The output validates against the OASIS schema and round-trips into GitHub Code Scanning and the VS Code SARIF Viewer. Use this when wiring sfgraph into CI alongside sfdx-scanner/PMD-Apex/CodeScan.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const audits = new Set(input.audits);

    const collectArgs: Parameters<typeof analyze.collectFindings>[0] = {};
    if (audits.has("governor")) {
      collectArgs.governor = analyze.findGovernorRisks(ctx.graphStore, ctx.orgId);
    }
    if (audits.has("security")) {
      collectArgs.security = analyze.securityAudit(ctx.graphStore, ctx.orgId);
    }
    if (audits.has("dead-code")) {
      collectArgs.deadCode = analyze.findDeadCode(ctx.graphStore, ctx.orgId);
    }
    if (audits.has("dangling")) {
      collectArgs.dangling = analyze.auditDanglingEdges(ctx.graphStore, ctx.orgId, {
        sampleSize: 1000,
      });
    }
    const findings = analyze.collectFindings(collectArgs);
    const report = emitSarif({ version: "1.1.8", findings });
    const lintErrors = lintSarifReport(report);

    const countsByRule = new Map<string, number>();
    for (const f of findings) {
      countsByRule.set(f.ruleId, (countsByRule.get(f.ruleId) ?? 0) + 1);
    }
    const ruleSummary = [...countsByRule.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([rule, n]) => `${rule}: ${n}`)
      .join(", ");

    return {
      summary:
        findings.length === 0
          ? "0 findings — emitted empty SARIF report"
          : `${findings.length} findings across ${countsByRule.size} rules (${ruleSummary})`,
      markdown: [
        `**SARIF 2.1.0** — ${findings.length} finding${findings.length === 1 ? "" : "s"}`,
        "",
        ...(lintErrors.length > 0
          ? ["⚠️ Schema lint warnings:", ...lintErrors.map((e) => `- \`${e}\``), ""]
          : []),
        "Save the `data.report` field as `sfgraph.sarif` and upload to GitHub Code Scanning via the `github/codeql-action/upload-sarif` action.",
      ].join("\n"),
      data: { report, findings, lintErrors },
      follow_up_tools: ["governor_risk_check", "security_audit", "dead_code_audit"],
    };
  },
});
