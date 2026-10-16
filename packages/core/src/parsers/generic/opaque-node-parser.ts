import { type EdgeFact, METADATA_CATEGORY, type NodeFact } from "../../domain/index.js";
import { sha256 } from "../_xml-helpers.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";
import { OPAQUE_DATAPACK_HASH_SALT } from "../hash-salts.js";
import { collectNameMatchCandidates, scanDataPackRefs } from "../vlocity/datapack-refs.js";

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
 * Emits a single node with the raw blob as `rawSize`; edges only for Vlocity
 * DataPack members (`scanDataPackRefs`).
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
    const node = makeNode(
      ctx,
      input.metadataType,
      qname,
      {
        name,
        metadataType: input.metadataType,
        rawSize: input.raw?.length ?? 0,
        ...(candidates.length > 0 ? { nameMatchCandidates: candidates } : {}),
      },
      // Salted for scanned DataPack members so existing graphs re-parse when
      // the scanner's output changes (v2: cards, dataSource, LWC, name-match).
      sha256(
        input.scanDataPackRefs
          ? `${OPAQUE_DATAPACK_HASH_SALT}\n${input.raw ?? ""}`
          : (input.raw ?? ""),
      ),
    );
    return { nodes: [node], edges };
  }
}
