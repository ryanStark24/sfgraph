import { asQualifiedName } from "@ryanstark24/sfgraph-shared";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";

const inputSchema = z.object({
  org: z.string().min(1),
  /** The qualified_name of an existing graph node to use as the focal
   *  point. The tool returns the top-k other nodes whose embedding
   *  vectors are nearest in cosine distance. */
  qname: z.string().min(1),
  /** Top-k results to return (1–50). Default 10 — small enough to surface
   *  in an agent reply without flooding the context window. */
  k: z.number().int().min(1).max(50).default(10),
  /** Restrict matches to a single node label (e.g. 'ApexClass', 'LWC',
   *  'Flow'). When omitted, all labels are searched. */
  label: z.string().min(1).optional(),
});

defineTool({
  name: "find_similar",
  description:
    "USE THIS to find Salesforce metadata semantically similar to a given node. Powered by the in-process MiniLM-L6 embeddings produced during ingest. Returns top-k nearest neighbours by cosine distance. Good for 'show me other Apex methods like BillingSvc.run', 'what LWCs are similar to accountTile', or surfacing related code when exact-name search misses. Filter by label when you want results restricted to one node type.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const qname = asQualifiedName(input.qname);

    // No vec0 / no embeddings table — degrade gracefully with a clear
    // message so the agent can fall back to structural traversal.
    if (!ctx.vectorStore) {
      return {
        summary: "vector index unavailable for this org",
        markdown: [
          `> Vector search isn't available on this org's graph.`,
          ``,
          `Causes (most common first):`,
          `- The org was ingested before \`@ryanstark24/sfgraph-models\` was wired up; embeddings weren't generated. Re-run \`sfgraph ingest --org ${input.org} --rebuild\` to populate the vector index.`,
          `- The optional \`@ryanstark24/sfgraph-models\` install was skipped (e.g. on slow connections). The model is ~30 MB; install it with \`npm install -g @ryanstark24/sfgraph-models\` and re-ingest.`,
          `- The \`sqlite-vec\` extension failed to load on this Node ABI.`,
          ``,
          `_follow_up_tools: \`trace_downstream\`, \`trace_upstream\`, \`analyze_field\`_`,
        ].join("\n"),
        data: { hits: [], reason: "vector_index_unavailable" },
      };
    }

    const focal = ctx.vectorStore.getNodeVector(ctx.orgId, qname);
    if (!focal) {
      return {
        summary: `no embedding stored for ${input.qname}`,
        markdown: [
          `> No vector exists for \`${input.qname}\`.`,
          ``,
          `Likely causes:`,
          `- The qname is wrong (typo / wrong casing / wrong member type prefix). The graph keys are \`<Label>:<Name>\` (e.g. \`ApexClass:BillingSvc\`).`,
          `- The node exists but its label doesn't get embedded (only code-bearing nodes — Apex, LWC, Flow, OmniStudio — are vectorised by default).`,
          `- The org was last ingested before this label started producing embeddings; re-ingest with \`--rebuild\` to backfill.`,
          ``,
          `_follow_up_tools: \`analyze_field\`, \`trace_upstream\`_`,
        ].join("\n"),
        data: { hits: [], reason: "no_focal_vector" },
      };
    }

    // Fetch k+1 because the focal node will be in its own neighbourhood
    // (distance 0). We strip it below; trimming to k after the filter.
    const raw = ctx.vectorStore.searchNodes(
      ctx.orgId,
      focal,
      input.k + 1,
      input.label ? { label: input.label } : undefined,
    );
    const hits = raw.filter((h) => h.qname !== qname).slice(0, input.k);

    if (hits.length === 0) {
      return {
        summary: `no neighbours found for ${input.qname}`,
        markdown: `> Vector index has no nearby neighbours for \`${input.qname}\`${
          input.label ? ` within label \`${input.label}\`` : ""
        }. The org may be sparsely populated for this label, or the focal node may genuinely be isolated.`,
        data: { hits: [], reason: "no_neighbours" },
      };
    }

    // Cosine distance from sqlite-vec is in [0, 2]; lower = more similar.
    // Convert to a 0–1 similarity score for the agent's UX (higher = more
    // similar) — but keep the raw distance in `data` for programmatic use.
    const md: string[] = [
      `**Top ${hits.length} nearest neighbour${hits.length === 1 ? "" : "s"} to \`${input.qname}\`${
        input.label ? ` (label: \`${input.label}\`)` : ""
      }:**`,
      ``,
      `| # | qname | label | similarity | distance |`,
      `| - | ----- | ----- | ---------- | -------- |`,
    ];
    hits.forEach((h, i) => {
      const sim = (1 - h.distance / 2).toFixed(3);
      md.push(`| ${i + 1} | \`${h.qname}\` | \`${h.label}\` | ${sim} | ${h.distance.toFixed(4)} |`);
    });
    md.push(``, `_follow_up_tools: \`explain_code\`, \`trace_downstream\`, \`analyze_field\`_`);

    return {
      summary: `${hits.length} neighbour${hits.length === 1 ? "" : "s"} of ${input.qname}`,
      markdown: md.join("\n"),
      data: {
        focalQname: input.qname,
        label: input.label ?? null,
        k: input.k,
        hits: hits.map((h) => ({
          qname: h.qname,
          label: h.label,
          distance: h.distance,
          similarity: 1 - h.distance / 2,
        })),
      },
    };
  },
});
