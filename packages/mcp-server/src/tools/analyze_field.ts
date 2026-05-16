import { render } from "@ryanstark24/sfgraph-core";
import { REL_TYPES } from "@ryanstark24/sfgraph-core";
import { asQualifiedName } from "@ryanstark24/sfgraph-shared";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";

// Salesforce SObject and Field API names are letters/digits/underscore only
// (custom suffix `__c` / `__r` / etc. is allowed). Reject anything else
// up-front rather than silently returning "field not found" — agents that
// pass `object: "Account.Tier__c"` should see the validation error.
const SF_API_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*(?:__[a-zA-Z])?$/;

const inputSchema = z.object({
  org: z.string().min(1),
  object: z
    .string()
    .min(1)
    .regex(SF_API_NAME_RE, "object must be a Salesforce SObject API name (no dots or spaces)"),
  field: z
    .string()
    .min(1)
    .regex(SF_API_NAME_RE, "field must be a Salesforce field API name (no dots or spaces)"),
});

defineTool({
  name: "analyze_field",
  description:
    "USE THIS for any 'where is X.Y field used' / 'who reads or writes Account.Status__c' / 'who has access to this field' question about a Salesforce CustomField. Returns every Apex method, Flow, LWC, validation rule, and formula that reads/writes the field, plus FLS grants (which Profile/PermSet can see or edit it). Prefer this over grep / file search for any field-impact question.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const qname = asQualifiedName(`CustomField:${input.object}.${input.field}`);
    const node = ctx.graphStore.getNode(ctx.orgId, qname);
    if (!node) {
      return {
        summary: "field not found",
        markdown: `> no node \`${qname}\``,
        data: { found: false },
        follow_up_tools: ["trace_upstream", "trace_downstream", "security_audit", "find_similar"],
      };
    }
    const readers = ctx.graphStore.listEdgesTo(ctx.orgId, qname, REL_TYPES.READS_FIELD);
    const writers = ctx.graphStore.listEdgesTo(ctx.orgId, qname, REL_TYPES.WRITES_FIELD);
    const grants = ctx.graphStore.listEdgesTo(ctx.orgId, qname, REL_TYPES.GRANTS_FIELD_ACCESS);
    const allEdges = [...readers, ...writers, ...grants];
    const nodeSet = new Map<string, { qualifiedName: string; label: string }>();
    nodeSet.set(qname, { qualifiedName: qname, label: "CustomField" });
    for (const e of allEdges) {
      const src = ctx.graphStore.getNode(ctx.orgId, e.srcQualifiedName);
      nodeSet.set(e.srcQualifiedName, {
        qualifiedName: e.srcQualifiedName,
        label: src?.label ?? "Unknown",
      });
    }
    const mermaid = render.renderDependencyGraph({
      nodes: Array.from(nodeSet.values()),
      edges: allEdges.map((e) => ({
        srcQualifiedName: e.srcQualifiedName,
        dstQualifiedName: e.dstQualifiedName,
        relType: e.relType,
      })),
      title: `field ${qname}`,
    });
    const md = [
      `**${qname}** — readers ${readers.length} · writers ${writers.length} · grants ${grants.length}`,
      "",
      "```mermaid",
      mermaid,
      "```",
    ].join("\n");
    return {
      summary: `${readers.length} readers / ${writers.length} writers`,
      markdown: md,
      data: {
        readers: readers.map((e) => e.srcQualifiedName),
        writers: writers.map((e) => e.srcQualifiedName),
        grants: grants.map((e) => e.srcQualifiedName),
      },
      follow_up_tools: ["trace_upstream", "trace_downstream", "security_audit", "find_similar"],
    };
  },
});
