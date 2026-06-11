import { asQualifiedName } from "@ryanstark24/sfgraph-shared";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";

const inputSchema = z
  .object({
    org: z.string().min(1),
    /** The qualified_name of an existing graph node to use as the focal
     *  point. Mutually exclusive with `text`. */
    qname: z.string().min(1).optional(),
    /** A free-text query (e.g. "code that handles order cancellation").
     *  Embedded on the fly through the same MiniLM pipeline used at
     *  ingest time. Mutually exclusive with `qname`. Use this when no
     *  existing node names the concept you're after — semantic match
     *  surfaces conceptually-related code without an exact qname. */
    text: z.string().min(1).max(4096).optional(),
    /** Top-k results to return (1–50). Default 10 — small enough to surface
     *  in an agent reply without flooding the context window. */
    k: z.number().int().min(1).max(50).default(10),
    /** Restrict matches to a single node label (e.g. 'ApexClass', 'LWC',
     *  'Flow'). When omitted, all labels are searched. */
    label: z.string().min(1).optional(),
    /** Minimum cosine similarity (0–1) a match must clear to be returned.
     *  KNN always returns *k* nearest by distance, including near-irrelevant
     *  tail matches; this floor turns "k nearest" into "the relevant ones, up
     *  to k". Default 0.3 (conservative for MiniLM-L6 on this corpus). Lower it
     *  to widen recall, raise it to tighten precision. */
    min_similarity: z.number().min(0).max(1).default(0.3),
  })
  .refine((v) => Boolean(v.qname) !== Boolean(v.text), {
    message: "Provide exactly one of `qname` or `text`",
  });

defineTool({
  name: "find_similar",
  description:
    "USE THIS to find Salesforce metadata semantically similar to a given node OR a free-text concept. Powered by the in-process MiniLM-L6 embeddings produced during ingest. Two modes: (1) pass `qname` for 'show me other Apex methods like BillingSvc.run' / 'what LWCs are similar to accountTile' — uses an existing node's stored vector; (2) pass `text` for 'find code that handles order cancellation' / 'where do we compute compliance fees' — embeds your text on the fly and runs KNN. Filter by label to restrict to one node type. Use this when exact-name search misses or no qname names the concept you're after.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });

    // No vec0 / no embeddings table — degrade gracefully with a clear
    // message so the agent can fall back to structural traversal.
    if (!ctx.vectorStore) {
      return {
        summary: "vector index unavailable for this org",
        markdown: [
          `> Vector search isn't available on this org's graph.`,
          "",
          "Causes (most common first):",
          `- The org was ingested before \`@ryanstark24/sfgraph-models\` was wired up; embeddings weren't generated. Re-run \`sfgraph ingest --org ${input.org} --rebuild\` to populate the vector index.`,
          "- The optional `@ryanstark24/sfgraph-models` install was skipped (e.g. on slow connections). The model is ~30 MB; install it with `npm install -g @ryanstark24/sfgraph-models` and re-ingest.",
          "- The `sqlite-vec` extension failed to load on this Node ABI.",
          "",
          "_follow_up_tools: `trace_downstream`, `trace_upstream`, `analyze_field`_",
        ].join("\n"),
        data: { hits: [], reason: "vector_index_unavailable" },
      };
    }

    // Resolve the focal vector — either looking it up by qname or
    // embedding the free-text query through the same MiniLM pipeline.
    let focal: Float32Array | null = null;
    let focalLabel: string;
    if (input.qname) {
      focalLabel = input.qname;
      focal = ctx.vectorStore.getNodeVector(ctx.orgId, asQualifiedName(input.qname));
      if (!focal) {
        return {
          summary: `no embedding stored for ${input.qname}`,
          markdown: [
            `> No vector exists for \`${input.qname}\`.`,
            "",
            "Likely causes:",
            "- The qname is wrong (typo / wrong casing / wrong member type prefix). The graph keys are `<Label>:<Name>` (e.g. `ApexClass:BillingSvc`).",
            `- The node exists but its label doesn't get embedded (only code-bearing nodes — Apex, LWC, Flow, OmniStudio — are vectorised by default).`,
            "- The org was last ingested before this label started producing embeddings; re-ingest with `--rebuild` to backfill.",
            "",
            `_Tip:_ if no node names the concept you're after, retry with \`text\` instead of \`qname\`.`,
            "",
            "_follow_up_tools: `analyze_field`, `trace_upstream`_",
          ].join("\n"),
          data: { hits: [], reason: "no_focal_vector" },
        };
      }
    } else {
      // Free-text mode. Lazy-import via the public re-export so we don't
      // require core consumers to ship the embedder runtime when they
      // don't use this path.
      focalLabel = `"${input.text}"`;
      const { embedSingle } = await import("@ryanstark24/sfgraph-core");
      focal = await embedSingle(input.text ?? "");
      if (!focal) {
        return {
          summary: "embedder unavailable",
          markdown: [
            `> Couldn't embed the query text \`"${input.text}"\`.`,
            "",
            `Either the \`@xenova/transformers\` runtime isn't installed on this machine, or the MiniLM model files (\`@ryanstark24/sfgraph-models\`) aren't reachable. Both are optionalDependencies of \`@ryanstark24/sfgraph-core\`; reinstall with \`npm install -g @ryanstark24/sfgraph\` to pull them.`,
            "",
            "_Fallback:_ retry with `qname` pointing at the closest existing node.",
          ].join("\n"),
          data: { hits: [], reason: "embedder_unavailable" },
        };
      }
    }

    // The vec0 tables use the DEFAULT L2 (Euclidean) distance — declared
    // `float[384]` with no distance_metric. The embedder normalizes every
    // vector (pipeline `normalize: true`), so for unit vectors
    // |a-b|² = 2(1 - cos) ⇒ cosine similarity = 1 - d²/2. Raw L2 stays in `data`.
    const l2ToCosine = (d: number): number => Math.max(0, Math.min(1, 1 - (d * d) / 2));

    // Over-fetch so the relevance floor + focal-strip have headroom (KNN returns
    // by distance; some of the k nearest may fall below the floor).
    const candidateK = Math.max(input.k * 4, input.k + 1);
    const raw = ctx.vectorStore.searchNodes(
      ctx.orgId,
      focal,
      candidateK,
      input.label ? { label: input.label } : undefined,
    );
    const candidates = raw
      .filter((h) => !input.qname || h.qname !== asQualifiedName(input.qname))
      .map((h) => ({ ...h, similarity: l2ToCosine(h.distance) }));
    const aboveFloor = candidates.filter((h) => h.similarity >= input.min_similarity);
    const hits = aboveFloor.slice(0, input.k);
    const cutByFloor = candidates.length - aboveFloor.length;

    if (hits.length === 0) {
      // Distinguish "nothing nearby" from "matches existed but all below the floor".
      const allBelow = candidates.length > 0;
      return {
        summary: allBelow
          ? `no neighbours of ${focalLabel} above the ${input.min_similarity} similarity floor`
          : `no neighbours found for ${focalLabel}`,
        markdown: allBelow
          ? `> ${candidates.length} match(es) for ${focalLabel} were all below the relevance floor (\`min_similarity\`=${input.min_similarity}). Lower \`min_similarity\` to see weaker matches; the closest was ${Math.max(...candidates.map((c) => c.similarity)).toFixed(3)}.`
          : `> Vector index has no nearby neighbours for ${focalLabel}${
              input.label ? ` within label \`${input.label}\`` : ""
            }. The org may be sparsely populated for this label, or the focal may genuinely be isolated.`,
        data: { hits: [], reason: allBelow ? "below_similarity_floor" : "no_neighbours" },
      };
    }

    const md: string[] = [
      `**Top ${hits.length} nearest neighbour${hits.length === 1 ? "" : "s"} to ${focalLabel}${
        input.label ? ` (label: \`${input.label}\`)` : ""
      }:**`,
      "",
      "| # | qname | label | similarity | distance |",
      "| - | ----- | ----- | ---------- | -------- |",
    ];
    hits.forEach((h, i) => {
      md.push(
        `| ${i + 1} | \`${h.qname}\` | \`${h.label}\` | ${h.similarity.toFixed(3)} | ${h.distance.toFixed(4)} |`,
      );
    });
    if (cutByFloor > 0) {
      md.push(
        "",
        `_${cutByFloor} weaker match(es) hidden below the ${input.min_similarity} similarity floor — lower \`min_similarity\` to include them._`,
      );
    }
    md.push("", "_follow_up_tools: `explain_code`, `trace_downstream`, `analyze_field`_");

    return {
      summary: `${hits.length} neighbour${hits.length === 1 ? "" : "s"} of ${focalLabel}`,
      markdown: md.join("\n"),
      data: {
        focalQname: input.qname ?? null,
        focalText: input.text ?? null,
        label: input.label ?? null,
        k: input.k,
        minSimilarity: input.min_similarity,
        cutByFloor,
        hits: hits.map((h) => ({
          qname: h.qname,
          label: h.label,
          distance: h.distance,
          similarity: h.similarity,
        })),
      },
    };
  },
});
