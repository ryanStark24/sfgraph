import { METADATA_CATEGORY, REL_TYPES, analyze } from "@ryanstark24/sfgraph-core";
import { getToolContext } from "../context.js";
import { defineTool, numeric, z } from "./_define.js";
import { type Piece, code, countNoun, nameOf, renderReport } from "./_report.js";

const inputSchema = z.object({
  org: z.string().min(1),
  /** Narrow the audit to a single SObject. Accepts `Account` or `CustomObject:Account`. */
  object: z.string().min(1).optional(),
  /** Narrow the audit to a single field. Accepts a full qname like `CustomField:Account.Tier__c`. */
  field: z.string().min(1).optional(),
  /** Include not-FLS-relevant fields (Custom Metadata Type fields + standard
   *  system/audit fields) in the gap list. Default false — they're noise. */
  include_non_fls_fields: z.boolean().default(false),
  /** Max rows returned per list (sharing rules, FLS gaps, access matrix, cached
   *  findings); the summary and the *Total fields always cover 100%. */
  limit: numeric(z.number().int().min(1).max(500).default(30)),
});

type Ctx = Awaited<ReturnType<typeof getToolContext>>;
const GRANTOR_LABELS = new Set(["PermissionSet", "Profile"]);

/**
 * Field-filtered audit: same result as `analyze.securityAudit` with
 * `{ field }`, but the field's grants come from one indexed `listEdgesTo`
 * instead of reading the GRANTS_FIELD_ACCESS edges of every Profile and
 * PermissionSet in the org (audit perf-06). The object filter still uses the
 * core scan: its matrix must include grants to fields that have no node
 * (e.g. standard fields), which only the grantor scan can find.
 */
function fieldSecurityAudit(
  ctx: Ctx,
  field: string,
  includeNonFlsFields: boolean,
): analyze.SecurityAudit {
  const cap = analyze.SECURITY_PER_LABEL_CAP;
  let truncated = false;
  const sharingFullAccess: string[] = [];
  const rules = ctx.graphStore.listNodesByLabel(ctx.orgId, "SharingRule", cap);
  if (rules.length >= cap) truncated = true;
  for (const n of rules) {
    const a = n.attributes as Record<string, unknown>;
    if (a.access === "Edit" || a.accessLevel === "Edit" || a.accessLevel === "All") {
      sharingFullAccess.push(n.qualifiedName);
    }
  }
  const grantedBy = [
    ...new Set(
      ctx.graphStore
        .listEdgesTo(ctx.orgId, field as never, REL_TYPES.GRANTS_FIELD_ACCESS as never)
        // An all-false entry (`<readable>false</readable>`) grants nothing.
        .filter(analyze.isEffectiveGrant)
        .map((e) => String(e.srcQualifiedName))
        .filter((q) => {
          const label = ctx.graphStore.getNode(ctx.orgId, q as never)?.label;
          return label !== undefined && GRANTOR_LABELS.has(label);
        }),
    ),
  ];
  const fieldAccessMatrix = grantedBy.length > 0 ? [{ field, grantedBy }] : [];
  const flsGaps: string[] = [];
  let flsGapsExcluded = 0;
  const node = ctx.graphStore.getNode(ctx.orgId, field as never);
  if (node && node.label === "CustomField" && grantedBy.length === 0) {
    if (!includeNonFlsFields && !analyze.isFlsRelevantField(field)) flsGapsExcluded += 1;
    else flsGaps.push(field);
  }
  return { sharingFullAccess, fieldAccessMatrix, flsGaps, flsGapsExcluded, truncated };
}

defineTool({
  name: "security_audit",
  description:
    "Use for FLS, access and sharing: full-access sharing rules, FLS gaps on PII-like fields, and the profile/permission set access matrix.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const filter: { object?: string; field?: string; includeNonFlsFields?: boolean } = {
      includeNonFlsFields: input.include_non_fls_fields,
    };
    if (input.object !== undefined) filter.object = input.object;
    if (input.field !== undefined) filter.field = input.field;
    const audit =
      input.field !== undefined
        ? fieldSecurityAudit(ctx, input.field, input.include_non_fls_fields)
        : analyze.securityAudit(ctx.graphStore, ctx.orgId, filter);
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
    const excludedNote =
      audit.flsGapsExcluded && audit.flsGapsExcluded > 0
        ? ` _(+${audit.flsGapsExcluded} CMDT/system fields hidden — pass \`include_non_fls_fields: true\`)_`
        : "";
    const md = [
      `**Full-access sharing rules:** ${audit.sharingFullAccess.length}`,
      ...audit.sharingFullAccess.slice(0, 20).map((q) => `- \`${q}\``),
      "",
      `**FLS gaps (custom/standard fields with no permission-set grant):** ${audit.flsGaps.length}${excludedNote}`,
      ...audit.flsGaps.slice(0, input.limit).map((q) => `- \`${q}\``),
      ...(audit.flsGaps.length > input.limit
        ? [
            `- _…${audit.flsGaps.length - input.limit} more (raise \`limit\` or filter by \`object\`)_`,
          ]
        : []),
    ].join("\n");
    const fieldName = input.field !== undefined ? nameOf(input.field) : undefined;
    const fieldNode =
      input.field !== undefined ? ctx.graphStore.getNode(ctx.orgId, input.field as never) : null;
    const fieldMissing = input.field !== undefined && !fieldNode;
    const notAField = !!fieldNode && fieldNode.label !== METADATA_CATEGORY.FIELD;
    const objectName = input.object !== undefined ? nameOf(input.object) : undefined;
    const gaps = audit.flsGaps.length;
    const rules = audit.sharingFullAccess.length;
    const grants = audit.fieldAccessMatrix[0]?.grantedBy.length ?? 0;
    // Fields in scope: granted ones, gaps and the system/settings ones left out. None means no
    // field access was checked at all.
    const inScope = audit.fieldAccessMatrix.length + gaps + (audit.flsGapsExcluded ?? 0);
    const noneChecked = fieldMissing || notAField || inScope === 0;
    const scope = noneChecked
      ? "every sharing rule"
      : `${
          fieldName !== undefined
            ? `the field ${code(fieldName)}`
            : objectName !== undefined
              ? `the fields on ${code(objectName)}`
              : "every field in the graph"
        } and every sharing rule`;
    const gapSentence = fieldMissing
      ? `The field ${code(fieldName!)} is not in the graph, so no field access was checked.`
      : notAField
        ? `${code(fieldName!)} is not a field, so no field access was checked.`
        : inScope === 0
          ? objectName !== undefined
            ? `No fields on ${code(objectName)} were found in the graph, so no field access was checked.`
            : fieldName !== undefined
              ? `The field ${code(fieldName)} was not found, so no field access was checked.`
              : "No fields were found in the graph, so no field access was checked."
          : gaps
            ? `${countNoun(gaps, "field")} ${gaps === 1 ? "has" : "have"} no access granted by any permission set or profile (a field access gap).`
            : fieldName !== undefined && grants > 0
              ? `No field access gaps: the field ${code(fieldName)} has access granted by ${countNoun(grants, "permission set or profile", "permission sets or profiles")}.`
              : "No field access gaps found.";
    const excluded = audit.flsGapsExcluded ?? 0;
    const pieces: Piece[] = [
      ...audit.sharingFullAccess.slice(0, 20).map((q) => ({
        name: q,
        kind: "SharingRule",
        role: "lets others edit the records (edit or full access).",
      })),
      ...audit.flsGaps.slice(0, input.limit).map((q) => {
        const n = nameOf(q);
        const on = n.includes(".") ? ` on ${code(n.split(".")[0]!)}` : "";
        return {
          name: q,
          kind: "CustomField",
          role: `Field${on}; no permission set or profile grants access to it.`,
        };
      }),
    ];
    const report = (details: string) =>
      renderReport({
        title: "Who can see and change data",
        inShort: [
          gapSentence,
          rules
            ? `${countNoun(rules, "sharing rule")} (who else can see records) ${rules === 1 ? "lets" : "let"} others edit the records (edit or full access).`
            : "No sharing rule lets others edit the records (edit or full access).",
          `Checked: ${scope}${excluded ? `; ${countNoun(excluded, "system or settings field")} ${excluded === 1 ? "was" : "were"} left out` : ""}.`,
          ...(audit.truncated
            ? [
                "The scan hit its row limit, so these counts may be low; narrow it with `object` or `field`.",
              ]
            : []),
        ],
        pieces,
        details,
        next: [
          ...(excluded
            ? ["Set `include_non_fls_fields: true` to include system and settings fields."]
            : []),
          "Run `analyze_field` on a field to see what reads and writes it.",
          ...(input.object === undefined && input.field === undefined
            ? ["Narrow with `object` or `field`."]
            : []),
        ],
      });
    const truncationNote = audit.truncated
      ? ` — results capped at ${analyze.SECURITY_PER_LABEL_CAP}/label; narrow with object/field`
      : "";
    return {
      summary: `${audit.flsGaps.length} FLS gaps, ${audit.sharingFullAccess.length} full-access rules${truncationNote}`,
      markdown: report(
        audit.truncated
          ? `${md}\n\n> _Note: at least one label hit the ${analyze.SECURITY_PER_LABEL_CAP}-row cap. Results are incomplete — pass \`object\` or \`field\` to narrow._`
          : md,
      ),
      data: {
        ...audit,
        // `limit` bounds every list in the payload, not just the markdown
        // (audit perf-06, review M6); the *Total fields keep the full counts.
        sharingFullAccess: audit.sharingFullAccess.slice(0, input.limit),
        sharingFullAccessTotal: audit.sharingFullAccess.length,
        flsGaps: audit.flsGaps.slice(0, input.limit),
        flsGapsTotal: audit.flsGaps.length,
        fieldAccessMatrix: audit.fieldAccessMatrix.slice(0, input.limit),
        fieldAccessMatrixTotal: audit.fieldAccessMatrix.length,
        cachedFindings: cachedFindings.slice(0, input.limit),
        cachedFindingsTotal: cachedFindings.length,
        limited:
          audit.sharingFullAccess.length > input.limit ||
          audit.flsGaps.length > input.limit ||
          audit.fieldAccessMatrix.length > input.limit ||
          cachedFindings.length > input.limit,
        truncated: audit.truncated ?? false,
      },
      follow_up_tools: ["analyze_field", "trace_upstream"],
    };
  },
});
