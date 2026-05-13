import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import { makeEdge } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";
import { asJson, buildBaseNode, extractFieldRefs, sha256 } from "./common.js";

export interface DataRaptorInput {
  name: string;
  datapack: unknown; // JSON or string
}

export class DataRaptorParser implements Parser<DataRaptorInput> {
  readonly category = METADATA_CATEGORY.VLOCITY_DATARAPTOR;
  readonly type = "VlocityDataRaptor";

  async parse(input: DataRaptorInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const dp = asJson(input.datapack);
    const hash = sha256(JSON.stringify(dp));
    const node = buildBaseNode({
      ctx,
      label: "DataRaptor",
      prefix: "DR",
      name: input.name,
      raw: dp,
      hash,
    });
    nodes.push(node);

    const src = node.qualifiedName as unknown as string;
    const type = String(dp.Type ?? dp.type ?? "");
    const inputSObject = String(dp.InputSObjectType ?? dp.inputSObjectType ?? "");
    const outputSObject = String(dp.OutputSObjectType ?? dp.outputSObjectType ?? "");

    // Extract source/destination field refs
    const json = JSON.stringify(dp);
    const refs = extractFieldRefs(json);

    const readType = type === "Extract" || type === "Turbo";
    const writeType = type === "Load";

    for (const r of refs) {
      if (readType || (!writeType && inputSObject)) {
        edges.push(
          makeEdge(ctx, src, REL_TYPES.DR_READS_FIELD, `CustomField:${r.object}.${r.field}`),
        );
      }
      if (writeType) {
        edges.push(
          makeEdge(ctx, src, REL_TYPES.DR_WRITES_FIELD, `CustomField:${r.object}.${r.field}`),
        );
      }
    }

    if (type === "Transform") {
      edges.push(makeEdge(ctx, src, REL_TYPES.DR_TRANSFORMS, `Transform:${input.name}`));
    }
    void inputSObject;
    void outputSObject;

    return { nodes, edges };
  }
}
