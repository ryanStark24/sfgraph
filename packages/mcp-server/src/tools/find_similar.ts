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
    /** Minimum cosine similarity (0–1) a VECTOR-leg match must clear to be
     *  returned. KNN always returns *k* nearest by distance, including
     *  near-irrelevant tail matches; this floor turns "k nearest" into "the
     *  relevant ones, up to k". Default 0.3 (conservative for MiniLM-L6 on this
     *  corpus). Keyword (exact-name) matches bypass the floor. Lower it to widen
     *  recall, raise it to tighten precision. */
    min_similarity: z.number().min(0).max(1).default(0.3),
  })
  .refine((v) => Boolean(v.qname) !== Boolean(v.text), {
    message: "Provide exactly one of `qname` or `text`",
  });

interface VecHit {
  qname: string;
  label: string;
  similarity: number;
  distance: number;
}
interface FusedHit {
  qname: string;
  label: string;
  similarity: number | null; // vector cosine, or null for keyword-only hits
  distance: number | null;
  via: "vector" | "keyword" | "both";
  rrf: number;
}

/**
 * Reciprocal Rank Fusion of the vector and keyword legs. Scale-free: needs only
 * each leg's ordering and one constant K (60, the literature default), so it
 * avoids summing incommensurate cosine and BM25 scores. A hit found by both legs
 * accumulates both terms and rises.
 */
function rrfFuse(
  vec: VecHit[],
  kw: Array<{ qname: string; label: string }>,
  k: number,
): FusedHit[] {
  const K = 60;
  const byQ = new Map<string, FusedHit>();
  vec.forEach((h, i) => {
    byQ.set(h.qname, {
      qname: h.qname,
      label: h.label,
      similarity: h.similarity,
      distance: h.distance,
      via: "vector",
      rrf: 1 / (K + i + 1),
    });
  });
  kw.forEach((h, i) => {
    const existing = byQ.get(h.qname);
    if (existing) {
      existing.rrf += 1 / (K + i + 1);
      existing.via = "both";
    } else {
      byQ.set(h.qname, {
        qname: h.qname,
        label: h.label,
        similarity: null,
        distance: null,
        via: "keyword",
        rrf: 1 / (K + i + 1),
      });
    }
  });
  return [...byQ.values()].sort((a, b) => b.rrf - a.rrf).slice(0, k);
}

defineTool({
  name: "find_similar",
  description:
    "USE THIS to find Salesforce metadata similar to a given node OR a free-text concept. Hybrid search: fuses MiniLM-L6 vector similarity (semantic) with an FTS5 keyword leg (exact-name recall) via reciprocal rank fusion. Two modes: (1) pass `qname` for 'show me other Apex methods like BillingSvc.run'; (2) pass `text` for 'find code that handles order cancellation'. Filter by label to restrict to one node type. The keyword leg also answers when the embedder is unavailable.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });

    // For unit vectors (the embedder normalizes), L2 distance d satisfies
    // |a-b|² = 2(1 - cos) ⇒ cosine similarity = 1 - d²/2.
    const l2ToCosine = (d: number): number => Math.max(0, Math.min(1, 1 - (d * d) / 2));
    // Over-fetch so the relevance floor, focal-strip, and fusion have headroom.
    const candidateK = Math.max(input.k * 4, input.k + 1);
    const focalLabel = input.qname ? input.qname : `"${input.text}"`;

    // --- keyword leg (always available; [] if FTS empty/unavailable). The query
    // is the focal node's name (qname mode) or the free text; searchNodesFts
    // camelCase-splits it to match the indexed word-split body. ---
    const namePart =
      input.qname && input.qname.includes(":")
        ? input.qname.slice(input.qname.indexOf(":") + 1)
        : (input.qname ?? input.text ?? "");
    const kwQuery = input.text ?? namePart;
    let kw = ctx.graphStore
      .searchNodesFts(ctx.orgId, kwQuery, candidateK)
      .filter((h) => !input.qname || h.qname !== String(asQualifiedName(input.qname)));
    if (input.label) kw = kw.filter((h) => h.label === input.label);

    // --- vector leg ---
    let vec: VecHit[] = [];
    let cutByFloor = 0;
    let vectorCandidates = 0;
    let vectorTopSim = 0;
    let vectorReason:
      | "vector_index_unavailable"
      | "no_focal_vector"
      | "embedder_unavailable"
      | null = null;
    if (!ctx.vectorStore) {
      vectorReason = "vector_index_unavailable";
    } else {
      let focal: Float32Array | null = null;
      if (input.qname) {
        focal = ctx.vectorStore.getNodeVector(ctx.orgId, asQualifiedName(input.qname));
        if (!focal) vectorReason = "no_focal_vector";
      } else {
        // Lazy-import via the public re-export so core consumers needn't ship the
        // embedder runtime when they don't use this path.
        const { embedSingle } = await import("@ryanstark24/sfgraph-core");
        focal = await embedSingle(input.text ?? "");
        if (!focal) vectorReason = "embedder_unavailable";
      }
      if (focal) {
        const raw = ctx.vectorStore.searchNodes(
          ctx.orgId,
          focal,
          candidateK,
          input.label ? { label: input.label } : undefined,
        );
        const candidates = raw
          .filter((h) => !input.qname || h.qname !== asQualifiedName(input.qname))
          .map((h) => ({
            qname: String(h.qname),
            label: h.label,
            similarity: l2ToCosine(h.distance),
            distance: h.distance,
          }));
        vectorCandidates = candidates.length;
        vectorTopSim = candidates.reduce((m, c) => Math.max(m, c.similarity), 0);
        const above = candidates.filter((h) => h.similarity >= input.min_similarity);
        cutByFloor = candidates.length - above.length;
        vec = above;
      }
    }

    const fused = rrfFuse(vec, kw, input.k);

    // Nothing to return — explain why, preferring the most specific cause. Note
    // these only fire when BOTH legs are empty; a populated keyword leg means the
    // tool still answers even when the vector leg was unavailable.
    if (fused.length === 0) {
      if (vectorReason === "vector_index_unavailable") {
        return {
          summary: "vector index unavailable for this org",
          markdown: [
            `> Neither vector search nor keyword search returned anything for this org.`,
            "",
            "Vector search isn't available (no embeddings), and the keyword index had no match. Causes (most common first):",
            `- The org was ingested before embeddings/FTS were wired up. Re-run \`sfgraph ingest --org ${input.org} --rebuild\`.`,
            "- The optional `@ryanstark24/sfgraph-models` install was skipped (~30 MB); install it and re-ingest.",
            "- The `sqlite-vec` extension failed to load on this Node ABI.",
            "",
            "_follow_up_tools: `trace_downstream`, `trace_upstream`, `analyze_field`_",
          ].join("\n"),
          data: { hits: [], reason: "vector_index_unavailable" },
        };
      }
      if (vectorReason === "no_focal_vector") {
        return {
          summary: `no embedding stored for ${input.qname}`,
          markdown: [
            `> No vector exists for \`${input.qname}\` and the keyword leg found nothing.`,
            "",
            "Likely causes:",
            "- The qname is wrong (typo / wrong member-type prefix). Graph keys are `<Label>:<Name>` (e.g. `ApexClass:BillingSvc`). (Case no longer matters — lookups are case-insensitive.)",
            "- The node exists but its label isn't embedded (only code-bearing nodes are vectorised by default).",
            "- The org was last ingested before this label produced embeddings; re-ingest with `--rebuild`.",
            "",
            "_Tip:_ retry with `text` to search by concept instead of an exact node.",
            "",
            "_follow_up_tools: `analyze_field`, `trace_upstream`_",
          ].join("\n"),
          data: { hits: [], reason: "no_focal_vector" },
        };
      }
      if (vectorReason === "embedder_unavailable") {
        return {
          summary: "embedder unavailable",
          markdown: [
            `> Couldn't embed the query text \`"${input.text}"\`, and the keyword leg found no match.`,
            "",
            "The `@xenova/transformers` runtime or the MiniLM model files (`@ryanstark24/sfgraph-models`) aren't reachable. Both are optionalDependencies of `@ryanstark24/sfgraph-core`; reinstall to pull them.",
            "",
            "_Fallback:_ retry with `qname` pointing at the closest existing node.",
          ].join("\n"),
          data: { hits: [], reason: "embedder_unavailable" },
        };
      }
      // Vector leg ran. Distinguish "all below the floor" from "nothing nearby".
      const allBelow = vectorCandidates > 0;
      return {
        summary: allBelow
          ? `no matches for ${focalLabel} above the ${input.min_similarity} similarity floor`
          : `no neighbours found for ${focalLabel}`,
        markdown: allBelow
          ? `> ${vectorCandidates} vector match(es) for ${focalLabel} were all below the relevance floor (\`min_similarity\`=${input.min_similarity}; closest ${vectorTopSim.toFixed(3)}), and the keyword leg found nothing. Lower \`min_similarity\` to see weaker matches.`
          : `> No vector neighbours or keyword matches for ${focalLabel}${
              input.label ? ` within label \`${input.label}\`` : ""
            }. The org may be sparsely populated, or the focal may genuinely be isolated.`,
        data: { hits: [], reason: allBelow ? "below_similarity_floor" : "no_neighbours" },
      };
    }

    const keywordOnly = fused.filter((h) => h.via === "keyword").length;
    const md: string[] = [
      `**Top ${fused.length} nearest neighbour${fused.length === 1 ? "" : "s"} to ${focalLabel}${
        input.label ? ` (label: \`${input.label}\`)` : ""
      }:**`,
      "",
      "| # | qname | label | similarity | via |",
      "| - | ----- | ----- | ---------- | --- |",
    ];
    fused.forEach((h, i) => {
      const sim = h.similarity == null ? "—" : h.similarity.toFixed(3);
      md.push(`| ${i + 1} | \`${h.qname}\` | \`${h.label}\` | ${sim} | ${h.via} |`);
    });
    if (cutByFloor > 0) {
      md.push(
        "",
        `_${cutByFloor} weaker vector match(es) hidden below the ${input.min_similarity} similarity floor — lower \`min_similarity\` to include them._`,
      );
    }
    if (keywordOnly > 0) {
      md.push(`_${keywordOnly} match(es) surfaced by the keyword leg (exact-name) only._`);
    }
    md.push("", "_follow_up_tools: `explain_code`, `trace_downstream`, `analyze_field`_");

    return {
      summary: `${fused.length} neighbour${fused.length === 1 ? "" : "s"} of ${focalLabel}`,
      markdown: md.join("\n"),
      data: {
        focalQname: input.qname ?? null,
        focalText: input.text ?? null,
        label: input.label ?? null,
        k: input.k,
        minSimilarity: input.min_similarity,
        cutByFloor,
        hits: fused.map((h) => ({
          qname: h.qname,
          label: h.label,
          distance: h.distance,
          similarity: h.similarity,
          via: h.via,
        })),
      },
    };
  },
});
