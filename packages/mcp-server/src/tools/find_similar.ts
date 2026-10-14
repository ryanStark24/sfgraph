import { REL_TYPES, analyze } from "@ryanstark24/sfgraph-core";
import type { GraphStore } from "@ryanstark24/sfgraph-core";
import { type OrgId, asQualifiedName } from "@ryanstark24/sfgraph-shared";
import { getToolContext } from "../context.js";
import { defineTool, numeric, z } from "./_define.js";
import { nearCopies } from "./_near_copies.js";
import { labelOfQname } from "./_reach_list.js";
import {
  type Piece,
  andList,
  code,
  countNoun,
  kindCounts,
  kindInText,
  renderReport,
  shown,
  theKind,
} from "./_report.js";

/** One line, at most 80 characters (code points), "…" when cut. */
const TEXT_SHOWN_MAX = 80;
function shortText(t: string): string {
  const cps = [...t.replace(/\s+/g, " ").trim()];
  return cps.length > TEXT_SHOWN_MAX
    ? `${cps.slice(0, TEXT_SHOWN_MAX - 1).join("")}…`
    : cps.join("");
}

const TITLE = "Similar pieces";
const NEXT_EMPTY = [
  "Use `find_nodes` with a pattern to check a name.",
  "Retry with `text` to search by idea instead of by a piece.",
];
/** How a hit was found, in plain words. */
const VIA_PLAIN = { vector: "by meaning", keyword: "by name only", both: "by meaning and by name" };

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
    k: numeric(z.number().int().min(1).max(50).default(10)),
    /** Restrict matches to a single node label (e.g. 'ApexClass', 'LWC',
     *  'Flow'). When omitted, all labels are searched. */
    label: z.string().min(1).optional(),
    /** Minimum cosine similarity (0–1) a VECTOR-leg match must clear to be
     *  returned. KNN always returns *k* nearest by distance, including
     *  near-irrelevant tail matches; this floor turns "k nearest" into "the
     *  relevant ones, up to k". Keyword (exact-name) matches bypass the floor.
     *  Default 0.4 (cycle 3 T6, was 0.3): on the benchmark's dev and dev2 cases (the held-out split
     *  was not looked at) the weakest expected match scored just above 0.4, and the matches between
     *  0.3 and 0.4 were all unrelated, so 0.4 hides them without losing an expected one. */
    min_similarity: numeric(z.number().min(0).max(1).default(0.4)),
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
export interface FusedHit {
  qname: string;
  label: string;
  similarity: number | null; // vector cosine, or null for keyword-only hits
  distance: number | null;
  via: "vector" | "keyword" | "both";
  rrf: number;
  /** Ranked after every other hit (test code, record-level labels). */
  demoted?: boolean;
  /** A field kept in place because these top hits read or write it. */
  sharedBy?: string[];
}

/** Record-level labels: rows inside a component (a CMDT record, a field),
 *  not the code or automation a free-text concept query asks for. */
const RECORD_LEVEL_LABELS: ReadonlySet<string> = new Set(["CustomMetadataRecord", "CustomField"]);

/**
 * Cycle 3 C4 cutoffs, applied to a `text` search's top k when `min_similarity` > 0 (0 turns every floor off):
 *  - DATA_LABEL_FLOOR: a field, object or settings record with a similarity score must reach 0.45. Data rows
 *    share words with almost any query about their process, so they need a higher bar than code.
 *  - RELATIVE_CUTOFF: a match found by meaning only (not also by name) must reach 0.85 of the closest match.
 * Chosen by an offline sweep on the dev cases (floors 0.43-0.55, ratios 0.6-0.85) and confirmed on dev2.
 * Matches found by name only carry no score and are never cut.
 */
export const DATA_LABEL_FLOOR = 0.45;
export const RELATIVE_CUTOFF = 0.85;
const DATA_LABELS: ReadonlySet<string> = new Set([
  "CustomObject",
  "CustomField",
  "CustomMetadataRecord",
]);

/** The fused hits that pass the C4 cutoffs, and how many were cut. */
export function applyCutoffs(fused: FusedHit[]): { kept: FusedHit[]; cut: number } {
  const top = fused.reduce((m, h) => Math.max(m, h.similarity ?? 0), 0);
  const kept = fused.filter((h, i) => {
    // The best-ranked hit always stays, so a cutoff never empties the answer.
    if (i === 0 || h.similarity == null) return true;
    if (DATA_LABELS.has(h.label) && h.similarity < DATA_LABEL_FLOOR) return false;
    if (h.via === "vector" && h.similarity < RELATIVE_CUTOFF * top) return false;
    return true;
  });
  return { kept, cut: fused.length - kept.length };
}

/** The text a hit is fingerprinted by: its source, or for a class its methods' source. Capped at 64 kB. */
function copyText(store: GraphStore, orgId: OrgId, h: FusedHit): string {
  const MAX = 65_536;
  const own = store.getSnippet(orgId, asQualifiedName(h.qname))?.sourceText;
  if (own) return own.slice(0, MAX);
  if (h.label !== "ApexClass" && h.label !== "ApexTrigger") return "";
  let out = "";
  for (const e of store.listEdgesFrom(orgId, asQualifiedName(h.qname), REL_TYPES.CONTAINS_METHOD)) {
    out += `${store.getSnippet(orgId, e.dstQualifiedName)?.sourceText ?? ""}\n`;
    if (out.length >= MAX) break;
  }
  return out.slice(0, MAX);
}

/** Rels by which a component reads or writes a field (as analyze_field counts them). */
const FIELD_USE_RELS: ReadonlySet<string> = new Set(
  (Object.values(REL_TYPES) as string[]).filter(
    (r) =>
      r.endsWith("READS_FIELD") ||
      r.endsWith("WRITES_FIELD") ||
      r === REL_TYPES.LWC_BINDS_FIELD ||
      r === REL_TYPES.WORKFLOW_UPDATES_FIELD,
  ),
);

/**
 * Reciprocal Rank Fusion of the vector and keyword legs. Scale-free: needs only
 * each leg's ordering and one constant K (60, the literature default), so it
 * avoids summing incommensurate cosine and BM25 scores. A hit found by both legs
 * accumulates both terms and rises.
 */
function rrfFuse(vec: VecHit[], kw: Array<{ qname: string; label: string }>): FusedHit[] {
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
  // Ties broken by qname (code point) so the cut at k is deterministic.
  return [...byQ.values()].sort(
    (a, b) => b.rrf - a.rrf || analyze.codePointCompare(a.qname, b.qname),
  );
}

/** Shared fields moved up into the top `k`: a quarter of it, at least 1. */
export const sharedFieldsMax = (k: number): number => Math.max(1, Math.ceil(k / 4));

/**
 * Result shaping after fusion (all fused candidates in, top `k` out):
 *  - `collapse`: a member folds into its component (`ApexMethod:C.m` into
 *    `ApexClass:C`, `FlowVersion:F.vN` into `Flow:F`; containment.ts
 *    `componentOf`), keeping the best rank, the higher similarity and the
 *    merged `via`. A component equal to the focal is dropped.
 *  - `demote`: test code (decided on the owning class), and with
 *    `tests+records` record-level labels too, move after every other hit,
 *    order kept within each group. A field among the candidates that two or
 *    more of the top `k` kept hits read or write is the data those hits
 *    share, so it is part of the same process: it is not demoted, and it is
 *    listed right after the later of those hits (`sharedBy` names them).
 *    At most {@link sharedFieldsMax} fields are moved up (the best-ranked
 *    first); the rest stay demoted, so shared fields cannot crowd the code
 *    and automation hits out of the top `k`.
 */
function shapeHits(
  store: GraphStore,
  orgId: OrgId,
  fused: FusedHit[],
  k: number,
  opts: {
    collapse: boolean;
    demote: "none" | "tests" | "tests+records";
    focalUnit: string | undefined;
  },
): FusedHit[] {
  // The focal's own component (its class, for a method focal) is never
  // "similar" to it.
  const focalKey = opts.focalUnit?.toLowerCase();
  let rows = fused.filter((h) => h.qname.toLowerCase() !== focalKey);
  if (opts.collapse) {
    const byUnit = new Map<string, FusedHit>();
    for (const h of rows) {
      const unit = String(analyze.componentOf(store, orgId, asQualifiedName(h.qname)));
      if (unit.toLowerCase() === focalKey) continue;
      const cur = byUnit.get(unit.toLowerCase());
      if (!cur) {
        const label =
          unit === h.qname
            ? h.label
            : (store.getNode(orgId, asQualifiedName(unit))?.label ??
              unit.slice(0, unit.indexOf(":")));
        byUnit.set(unit.toLowerCase(), { ...h, qname: unit, label });
        continue;
      }
      // Rank order: `cur` already holds the best rrf.
      if (h.similarity != null && (cur.similarity == null || h.similarity > cur.similarity)) {
        cur.similarity = h.similarity;
        cur.distance = h.distance;
      }
      if (cur.via !== h.via) cur.via = "both";
    }
    rows = [...byUnit.values()];
  }
  if (opts.demote !== "none") {
    const classify = analyze.makeCoverageClassifier(store, orgId);
    const records = opts.demote === "tests+records";
    const keep: FusedHit[] = [];
    const late: FusedHit[] = [];
    for (const h of rows) {
      if ((records && RECORD_LEVEL_LABELS.has(h.label)) || classify(h.qname).isTest) {
        late.push({ ...h, demoted: true });
      } else keep.push(h);
    }
    if (records) {
      const top = keep.slice(0, k);
      const pos = new Map(top.map((h, i) => [h.qname.toLowerCase(), i]));
      const after = new Map<number, FusedHit[]>();
      const stay: FusedHit[] = [];
      let promoted = 0;
      for (const h of late) {
        if (h.label !== "CustomField" || classify(h.qname).isTest) {
          stay.push(h);
          continue;
        }
        const users = new Set<string>();
        for (const e of store.listEdgesTo(orgId, asQualifiedName(h.qname))) {
          if (!FIELD_USE_RELS.has(e.relType)) continue;
          const unit = String(analyze.componentOf(store, orgId, e.srcQualifiedName));
          if (pos.has(unit.toLowerCase())) users.add(unit);
        }
        if (users.size < 2 || promoted >= sharedFieldsMax(k)) {
          stay.push(h);
          continue;
        }
        promoted += 1;
        const sharedBy = [...users].sort(
          (a, b) => pos.get(a.toLowerCase())! - pos.get(b.toLowerCase())!,
        );
        const at = pos.get(sharedBy[sharedBy.length - 1]!.toLowerCase())!;
        const { demoted: _d, ...rest } = h;
        after.set(at, [...(after.get(at) ?? []), { ...rest, sharedBy }]);
      }
      if (after.size) {
        const merged: FusedHit[] = [];
        keep.forEach((h, i) => merged.push(h, ...(after.get(i) ?? [])));
        keep.length = 0;
        keep.push(...merged);
        late.length = 0;
        late.push(...stay);
      }
    }
    rows = [...keep, ...late];
  }
  return rows.slice(0, k);
}

defineTool({
  name: "find_similar",
  description:
    "Use to find metadata similar to a node (`qname`) or a concept (`text`), ranked by similarity.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });

    // For unit vectors (the embedder normalizes), L2 distance d satisfies
    // |a-b|² = 2(1 - cos) ⇒ cosine similarity = 1 - d²/2.
    const l2ToCosine = (d: number): number => Math.max(0, Math.min(1, 1 - (d * d) / 2));
    // Over-fetch so the relevance floor, focal-strip, and fusion have headroom.
    // Without `label`, collapsing members and down-ranking test/record rows
    // consume candidates, so keep a floor on the pool the shaping draws from.
    const SHAPING_POOL_FLOOR = 40;
    const candidateK = Math.max(
      input.k * 4,
      input.k + 1,
      input.label === undefined ? SHAPING_POOL_FLOOR : 0,
    );

    // Resolve the focal to its stored (canonical-case) qname. A focal that is
    // neither a graph node nor has a vector is a typo: say so instead of
    // returning keyword hits for a node that does not exist (audit tools-13).
    let focalQname: string | undefined;
    if (input.qname) {
      const q = asQualifiedName(input.qname);
      const node = ctx.graphStore.getNode(ctx.orgId, q);
      focalQname = node ? String(node.qualifiedName) : input.qname;
      if (!node && !ctx.vectorStore?.getNodeVector(ctx.orgId, q)) {
        return {
          summary: `focal ${input.qname} not found`,
          markdown: renderReport({
            title: TITLE,
            inShort: [
              `There is no ${theKind(labelOfQname(input.qname), input.qname).replace(/^the /, "")} in the graph, so nothing was compared.`,
            ],
            details: `> No node \`${input.qname}\` in the graph. Graph keys are \`<Label>:<Name>\` (e.g. \`ApexClass:BillingSvc\`); check the name with find_nodes, or retry with \`text\` to search by concept.`,
            next: NEXT_EMPTY,
          }),
          data: { hits: [], reason: "focal_not_found", focalQname: input.qname },
          follow_up_tools: ["find_nodes"],
        };
      }
    }
    const isFocal = (q: string) =>
      focalQname !== undefined && q.toLowerCase() === focalQname.toLowerCase();
    // Labels are matched case-insensitively; use the stored spelling.
    const wantLabel = input.label?.toLowerCase();
    const label =
      input.label === undefined
        ? undefined
        : (ctx.graphStore.listAllLabels().find((l) => l.toLowerCase() === wantLabel) ??
          input.label);
    // Caller text (up to 4,096 chars, any line breaks) shown as one short line, so it cannot split
    // the report (final review M4); `data.focalText` keeps it whole.
    const textShown = shortText(input.text ?? "");
    const focalLabel = focalQname ? focalQname : `"${textShown}"`;
    // The focal in plain words: "the Apex class `CaseService`" or "the text `order cancel`".
    const focalPlain = focalQname
      ? theKind(labelOfQname(focalQname), focalQname)
      : `the text ${code(textShown)}`;
    const among = label ? ` among ${kindInText(label, { plural: true })}` : "";
    const empty = (why: string, details: string) =>
      renderReport({ title: TITLE, inShort: [why], details, next: NEXT_EMPTY });

    // --- keyword leg (always available; [] if FTS empty/unavailable). The query
    // is the focal node's name (qname mode) or the free text; searchNodesFts
    // camelCase-splits it to match the indexed word-split body. ---
    const namePart = focalQname?.includes(":")
      ? focalQname.slice(focalQname.indexOf(":") + 1)
      : (focalQname ?? input.text ?? "");
    const kwQuery = input.text ?? namePart;
    // T15 I-7: the label filters inside the query, before its LIMIT, so rows
    // of other labels cannot fill the pool and starve the keyword leg.
    let kw = ctx.graphStore
      .searchNodesFts(ctx.orgId, kwQuery, candidateK, label ? { label } : undefined)
      .filter((h) => !isFocal(String(h.qname)));
    if (wantLabel) kw = kw.filter((h) => h.label.toLowerCase() === wantLabel);

    // --- vector leg ---
    let vec: VecHit[] = [];
    let cutByFloor = 0;
    let vectorCandidates = 0;
    let vectorTopSim = 0;
    let vectorReason:
      | "vector_index_unavailable"
      | "no_focal_vector"
      | "embedder_unavailable"
      | "vector_index_warming"
      | null = null;
    // Task 11a: an ingest writes vectors after "graph ready". Until they are
    // all in, the vector leg would rank only the embedded subset, so answer
    // from the keyword leg alone and say so.
    const embStatus = ctx.vectorStore ? ctx.graphStore.getEmbeddingStatus?.(ctx.orgId) : null;
    const warming =
      ctx.vectorStore && embStatus?.pending
        ? { embedded: ctx.vectorStore.countNodeVectors(ctx.orgId), total: embStatus.total }
        : null;
    const warmingLine = warming
      ? `vector index warming: ${warming.embedded}/${warming.total} embedded; using text search`
      : null;
    if (!ctx.vectorStore) {
      vectorReason = "vector_index_unavailable";
    } else if (warming) {
      vectorReason = "vector_index_warming";
    } else {
      let focal: Float32Array | null = null;
      if (focalQname) {
        focal = ctx.vectorStore.getNodeVector(ctx.orgId, asQualifiedName(focalQname));
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
          label ? { label } : undefined,
        );
        const candidates = raw
          .filter((h) => !isFocal(String(h.qname)))
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

    // Shaping needs every candidate: collapsing and down-ranking free slots
    // that the next candidates fill. Explicit `label` keeps rows as they are,
    // and so does a member focal (a method is compared with methods, so its
    // siblings stay rows; collapsing them would return its own class).
    const focalUnit =
      focalQname === undefined
        ? undefined
        : String(analyze.componentOf(ctx.graphStore, ctx.orgId, asQualifiedName(focalQname)));
    const memberFocal =
      focalUnit !== undefined && focalUnit.toLowerCase() !== focalQname?.toLowerCase();
    // Demotion without `label`: free text demotes test code and record-level
    // rows; a focal qname demotes test code unless the focal is a test itself
    // (T15 I-7), and keeps record-level rows (a field is compared with fields).
    const focalIsTest =
      focalQname !== undefined &&
      analyze.makeCoverageClassifier(ctx.graphStore, ctx.orgId)(focalQname).isTest;
    const shaped = shapeHits(ctx.graphStore, ctx.orgId, rrfFuse(vec, kw), input.k, {
      collapse: label === undefined && !memberFocal,
      demote:
        label !== undefined
          ? "none"
          : input.text !== undefined
            ? "tests+records"
            : focalIsTest
              ? "none"
              : "tests",
      focalUnit,
    });
    // C4 cutoffs on the shaped top k (not backfilled: a cut row is a weak match, not a free slot).
    // Text search only: they were chosen on text cases, and a focal piece's neighbours score much higher.
    const { kept: fused, cut: cutByCutoff } =
      input.text !== undefined && input.min_similarity > 0
        ? applyCutoffs(shaped)
        : { kept: shaped, cut: 0 };

    // Nothing to return — explain why, preferring the most specific cause. Note
    // these only fire when BOTH legs are empty; a populated keyword leg means the
    // tool still answers even when the vector leg was unavailable.
    if (fused.length === 0) {
      if (warming) {
        return {
          summary: "no text matches (vector index warming)",
          markdown: empty(
            `Nothing similar to ${focalPlain} was found${among}: the search by meaning is still being built (${warming.embedded} of ${warming.total} pieces done), and the search by name found no match.`,
            [
              `> ${warmingLine}.`,
              "",
              `The keyword index found no match for ${focalLabel}. Semantic matches become available once the running ingest finishes embedding (or the next ingest fills the pending vectors).`,
            ].join("\n"),
          ),
          data: { hits: [], reason: "vector_index_warming", vectorIndexWarming: warming },
        };
      }
      if (vectorReason === "vector_index_unavailable") {
        return {
          summary: "vector index unavailable for this org",
          markdown: empty(
            `Nothing similar to ${focalPlain} was found${among}: the search by meaning is not set up for this org, and the search by name found no match.`,
            [
              "> Neither vector search nor keyword search returned anything for this org.",
              "",
              "Vector search isn't available (no embeddings), and the keyword index had no match. Causes (most common first):",
              `- The org was ingested before embeddings/FTS were wired up. Re-run \`sfgraph ingest --org ${input.org} --rebuild\`.`,
              "- The optional `@ryanstark24/sfgraph-models` install was skipped (~30 MB); install it and re-ingest.",
              "- The `sqlite-vec` extension failed to load on this Node ABI.",
              "",
              "_follow_up_tools: `trace_downstream`, `trace_upstream`, `analyze_field`_",
            ].join("\n"),
          ),
          data: { hits: [], reason: "vector_index_unavailable" },
        };
      }
      if (vectorReason === "no_focal_vector") {
        return {
          summary: `no embedding stored for ${focalQname}`,
          markdown: empty(
            `Nothing similar to ${focalPlain} was found${among}: it has no stored meaning to compare, and the search by name found no match.`,
            [
              `> No vector exists for \`${focalQname}\` and the keyword leg found nothing.`,
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
          ),
          data: { hits: [], reason: "no_focal_vector" },
        };
      }
      if (vectorReason === "embedder_unavailable") {
        return {
          summary: "embedder unavailable",
          markdown: empty(
            `Nothing similar to ${focalPlain} was found${among}: the text could not be read for meaning (the model files are missing), and the search by name found no match.`,
            [
              `> Couldn't embed the query text ${code(`"${textShown}"`)}, and the keyword leg found no match.`,
              "",
              "The `@xenova/transformers` runtime or the MiniLM model files (`@ryanstark24/sfgraph-models`) aren't reachable. Both are optionalDependencies of `@ryanstark24/sfgraph-core`; reinstall to pull them.",
              "",
              "_Fallback:_ retry with `qname` pointing at the closest existing node.",
            ].join("\n"),
          ),
          data: { hits: [], reason: "embedder_unavailable" },
        };
      }
      // Vector leg ran. Distinguish "all below the floor" from "nothing nearby".
      const allBelow = vectorCandidates > 0;
      return {
        summary: allBelow
          ? `no matches for ${focalLabel} above the ${input.min_similarity} similarity floor`
          : `no neighbours found for ${focalLabel}`,
        markdown: empty(
          allBelow
            ? `Nothing similar enough to ${focalPlain} was found${among}: ${countNoun(vectorCandidates, "piece")} found by meaning ${vectorCandidates === 1 ? "was" : "were"} all below the similarity floor of ${input.min_similarity} (the closest scored ${vectorTopSim.toFixed(3)}), and the search by name found no match.`
            : `Nothing similar to ${focalPlain} was found${among}: neither the search by meaning nor the search by name returned anything.`,
          allBelow
            ? `> ${vectorCandidates} vector match(es) for ${focalLabel} were all below the relevance floor (\`min_similarity\`=${input.min_similarity}; closest ${vectorTopSim.toFixed(3)}), and the keyword leg found nothing. Lower \`min_similarity\` to see weaker matches.`
            : `> No vector neighbours or keyword matches for ${focalLabel}${
                input.label ? ` within label \`${input.label}\`` : ""
              }. The org may be sparsely populated, or the focal may genuinely be isolated.`,
        ),
        data: { hits: [], reason: allBelow ? "below_similarity_floor" : "no_neighbours" },
      };
    }

    const keywordOnly = fused.filter((h) => h.via === "keyword").length;
    const md: string[] = [
      `**Top ${fused.length} nearest neighbour${fused.length === 1 ? "" : "s"} to ${focalLabel}${
        input.label ? ` (label: \`${input.label}\`)` : ""
      }:**`,
      "",
      ...(warmingLine ? [`_${warmingLine}._`, ""] : []),
      "| # | qname | label | similarity | via |",
      "| - | ----- | ----- | ---------- | --- |",
    ];
    // Near-copies (display only): data.hits keeps every row; the report lists a copy under the
    // first (best-ranked) member of its group.
    const copyOf = nearCopies(
      fused.map((h) => ({ id: h.qname, kind: h.label, text: copyText(ctx.graphStore, ctx.orgId, h) })),
    );
    const copiesOf = new Map<string, string[]>();
    for (const [c, rep] of copyOf) copiesOf.set(rep, [...(copiesOf.get(rep) ?? []), c]);
    const rowOf = new Map(fused.map((h, i) => [h.qname, i + 1]));
    fused.forEach((h, i) => {
      const sim = h.similarity == null ? "—" : h.similarity.toFixed(3);
      const rep = copyOf.get(h.qname);
      md.push(
        `| ${i + 1} | \`${h.qname}\` | \`${h.label}\` | ${sim} | ${h.via}${rep ? `; near-copy of #${rowOf.get(rep)}` : ""} |`,
      );
    });
    if (cutByCutoff > 0) {
      md.push(
        "",
        `_${cutByCutoff} weak match(es) cut: a field, object or settings record below ${DATA_LABEL_FLOOR}, or a meaning-only match below ${RELATIVE_CUTOFF} of the closest. \`min_similarity: 0\` keeps them._`,
      );
    }
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

    const top = fused[0]!;
    const demoted = fused.filter((h) => h.demoted).length;
    const hidden = cutByFloor
      ? `${countNoun(cutByFloor, "weaker match", "weaker matches")} ${cutByFloor === 1 ? "was" : "were"} hidden below the similarity floor of ${input.min_similarity}`
      : "";
    const pieces: Piece[] = fused
      .filter((h) => !copyOf.has(h.qname))
      .map((h) => {
        const copies = copiesOf.get(h.qname);
        return {
          name: h.qname,
          kind: h.label,
          role: `${h.similarity == null ? "no similarity score" : `similarity ${h.similarity.toFixed(3)}`}, found ${VIA_PLAIN[h.via]}${h.demoted ? `; listed last (${input.text !== undefined ? "test code, a field or a settings record" : "test code"})` : ""}${h.sharedBy ? `; used by ${andList(h.sharedBy.map((q) => code(q.slice(q.indexOf(":") + 1))))}, so it is part of the same process` : ""}${copies ? `; ${countNoun(copies.length, "near-copy", "near-copies")} (almost the same code): ${andList(copies.map((q) => code(q.slice(q.indexOf(":") + 1))))}` : ""}.`,
        };
      });
    const cutLine = cutByCutoff
      ? `${countNoun(cutByCutoff, "weak match", "weak matches")} ${cutByCutoff === 1 ? "was" : "were"} left out for scoring well below the closest match`
      : "";
    const markdown = renderReport({
      title: TITLE,
      inShort: [
        `Found ${countNoun(fused.length, "piece")} similar to ${focalPlain}${among}: ${kindCounts(fused.map((h) => h.label))}${copyOf.size ? `; ${countNoun(copyOf.size, "of them is a near-copy", "of them are near-copies")} of another match, listed under it` : ""}.`,
        `The closest is ${shown(top.qname)}${top.similarity == null ? ", found by name" : ` (similarity ${top.similarity.toFixed(3)} out of 1)`}${keywordOnly ? `; ${countNoun(keywordOnly, "match", "matches")} ${keywordOnly === 1 ? "was" : "were"} found by name only` : ""}.`,
        ...(hidden || demoted || cutLine
          ? [
              `${[hidden, cutLine, demoted ? `${countNoun(demoted, "match", "matches")} ${demoted === 1 ? "is" : "are"} ${input.text !== undefined ? "test code, fields or settings records" : "test code"}, listed last` : ""].filter(Boolean).join("; ")}.`.replace(
                /^./,
                (c) => c.toUpperCase(),
              ),
            ]
          : []),
        ...(warming
          ? ["The search by meaning is still being built, so only the search by name was used."]
          : []),
      ],
      pieces,
      details: md.join("\n"),
      next: [
        ...(cutByFloor || cutByCutoff ? ["Lower `min_similarity` (0 turns every cut off) to see weaker matches."] : []),
        "Use `explain_code` on a match to read its code.",
        "Set `label` to compare with one kind only.",
        "Matches are listed per component (a method as its class), never the starting component itself.",
      ],
    });
    return {
      summary: `${fused.length} neighbour${fused.length === 1 ? "" : "s"} of ${focalLabel}`,
      markdown,
      data: {
        focalQname: focalQname ?? null,
        focalText: input.text ?? null,
        label: input.label ?? null,
        k: input.k,
        minSimilarity: input.min_similarity,
        cutByFloor,
        // Text searches only (the cutoffs do not apply to a focal piece).
        ...(input.text !== undefined ? { cutByCutoff } : {}),
        ...(warming ? { vectorIndexWarming: warming } : {}),
        hits: fused.map((h) => ({
          qname: h.qname,
          label: h.label,
          distance: h.distance,
          similarity: h.similarity,
          via: h.via,
          ...(h.demoted ? { demoted: true } : {}),
          ...(h.sharedBy ? { sharedBy: h.sharedBy } : {}),
          ...(copyOf.has(h.qname) ? { nearCopyOf: copyOf.get(h.qname) } : {}),
        })),
      },
    };
  },
});
