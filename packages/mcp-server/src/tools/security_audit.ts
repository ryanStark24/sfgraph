import { analyze } from "@ryanstark24/sfgraph-core";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";

const inputSchema = z.object({ org: z.string().min(1) });

defineTool({
  name: "security_audit",
  description:
    "USE THIS for any 'FLS' / 'who has access to X' / 'security audit' / 'sharing rules' / 'permission audit' question about a Salesforce org. Returns full-access sharing rules, FLS gaps on PII-shaped fields, and the Profile/PermSet -> Object/Field access matrix.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const audit = analyze.securityAudit(ctx.graphStore, ctx.orgId);
    // Augment with cached findings table if present
    let cachedFindings: Array<{ qname: string; rule: string; message: string }> = [];
    if (ctx.db) {
      try {
        const d = ctx.db as {
          prepare: (s: string) => {
            all: (
              ...args: unknown[]
            ) => Array<{ qualified_name: string; rule_id: string; message: string }>;
          };
        };
        cachedFindings = d
          .prepare(
            "SELECT qualified_name, rule_id, message FROM _sfgraph_findings WHERE org_id = ? ORDER BY rule_id",
          )
          .all(ctx.orgId)
          .map((r) => ({ qname: r.qualified_name, rule: r.rule_id, message: r.message }));
      } catch {
        /* table may not exist */
      }
    }
    const md = [
      `**Full-access sharing rules:** ${audit.sharingFullAccess.length}`,
      ...audit.sharingFullAccess.slice(0, 20).map((q) => `- \`${q}\``),
      "",
      `**FLS gaps (fields with no permission-set grant):** ${audit.flsGaps.length}`,
      ...audit.flsGaps.slice(0, 20).map((q) => `- \`${q}\``),
    ].join("\n");
    return {
      summary: `${audit.flsGaps.length} FLS gaps, ${audit.sharingFullAccess.length} full-access rules`,
      markdown: md,
      data: { ...audit, cachedFindings },
    };
  },
});
