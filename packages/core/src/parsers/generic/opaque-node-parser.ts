import { type EdgeFact, METADATA_CATEGORY, type NodeFact } from "../../domain/index.js";
import { sha256 } from "../_xml-helpers.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";
import { GENERIC_SCAN_HASH_SALT, OPAQUE_DATAPACK_HASH_SALT } from "../hash-salts.js";
import { collectNameMatchCandidates, scanDataPackRefs } from "../vlocity/datapack-refs.js";
import { scanGenericRefs } from "./ref-scanner.js";

export interface OpaqueInput {
  metadataType: string;
  name: string;
  raw: string;
  /** Vlocity DataPack members: JSON `raw` is scanned for OmniScript launch
   *  URLs and DR bundle-name fields (REFERENCES edges). */
  scanDataPackRefs?: boolean;
}

/**
 * Fallback for long-tail XML metadata types not given a dedicated parser.
 * Emits a single node with the raw blob as `rawSize` (the body is discarded)
 * plus, when the generic scanner (`ref-scanner.ts`) finds any, a bounded
 * `genericRefs` candidate list that the post-merge resolver turns into
 * GENERIC_REFERENCES_* edges where a candidate matches a real node. Edges here
 * only for Vlocity DataPack members (`scanDataPackRefs`).
 */
export class OpaqueNodeParser implements Parser<OpaqueInput> {
  readonly category = METADATA_CATEGORY.OPAQUE;
  readonly type = "OpaqueMetadata";

  async parse(input: OpaqueInput, ctx: ParseContext): Promise<ParseResult> {
    let name = stripNs(input.name, ctx.namespace);
    // A message channel is `Foo__c` in imports (and possibly the Metadata API)
    // but `Foo` in source files: one name, so LWC / Aura edges meet the node
    // whichever way the org was ingested.
    if (input.metadataType === "LightningMessageChannel") name = name.replace(/__c$/, "");
    const qname = `${input.metadataType}:${name}`;
    const edges: EdgeFact[] = [];
    let candidates: string[] = [];
    if (input.scanDataPackRefs && input.raw) {
      let rec: unknown;
      try {
        rec = JSON.parse(input.raw);
      } catch {
        rec = null;
      }
      for (const r of scanDataPackRefs(rec))
        edges.push(makeEdge(ctx, qname, r.rel, r.dst, r.attrs));
      candidates = collectNameMatchCandidates(rec);
    }
    const scan = scanGenericRefs(input.raw);
    const scanned = scan.candidates.length > 0;
    const node = makeNode(
      ctx,
      input.metadataType,
      qname,
      {
        name,
        metadataType: input.metadataType,
        rawSize: input.raw?.length ?? 0,
        ...(candidates.length > 0 ? { nameMatchCandidates: candidates } : {}),
        ...(scanned ? { genericRefs: scan.candidates } : {}),
        ...(scanned && scan.truncated ? { genericRefsTruncated: true } : {}),
      },
      // Salted for scanned DataPack members so existing graphs re-parse when
      // the scanner's output changes (v2: cards, dataSource, LWC, name-match).
      sha256(
        input.scanDataPackRefs
          ? `${OPAQUE_DATAPACK_HASH_SALT}\n${scanned ? `${GENERIC_SCAN_HASH_SALT}\n` : ""}${input.raw ?? ""}`
          : scanned
            ? `${GENERIC_SCAN_HASH_SALT}\n${input.raw ?? ""}`
            : (input.raw ?? ""),
      ),
    );
    return { nodes: [node], edges };
  }
}
