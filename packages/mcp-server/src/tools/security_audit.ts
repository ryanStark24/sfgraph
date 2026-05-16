import { analyze } from "@ryanstark24/sfgraph-core";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";

const inputSchema = z.object({
  org: z.string().min(1),
  /** Narrow the audit to a single SObject. Accepts `Account` or `CustomObject:Account`. */
  object: z.string().min(1).optional(),
  /** Narrow the audit to a single field. Accepts a full qname like `CustomField:Account.Tier__c`. */
  field: z.string().min(1).optional(),
});

defineTool({
  name: "security_audit",
  description:
    "USE THIS for any 'FLS' / 'who has access to X' / 'security audit' / 'sharing rules' / 'permission audit' question about a Salesforce org. Returns full-access sharing rules, FLS gaps on PII-shaped fields, and the Profile/PermSet -> Object/Field access matrix. Optional `object` / `field` filters narrow the FLS-gap + access-matrix output to a single SObject or field.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const filter: { object?: string; field?: string } = {};
    if (input.object !== undefined) filter.object = input.object;
    if (input.field !== undefined) filter.field = input.field;
    const audit = analyze.securityAudit(ctx.graphStore, ctx.orgId, filter);
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
    const truncationNote = audit.truncated
      ? ` — results capped at ${analyze.SECURITY_PER_LABEL_CAP}/label; narrow with object/field`
      : "";
    return {
      summary: `${audit.flsGaps.length} FLS gaps, ${audit.sharingFullAccess.length} full-access rules${truncationNote}`,
      markdown: audit.truncated
        ? `${md}\n\n> _Note: at least one label hit the ${analyze.SECURITY_PER_LABEL_CAP}-row cap. Results are incomplete — pass \`object\` or \`field\` to narrow._`
        : md,
      data: { ...audit, cachedFindings, truncated: audit.truncated ?? false },
      follow_up_tools: ["analyze_field", "trace_upstream"],
    };
  },
});
