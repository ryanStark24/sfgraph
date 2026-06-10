import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import { makeEdge } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";
import {
  asJson,
  buildBaseNode,
  extractFieldRefs,
  isPlainFieldName,
  isSObjectName,
  pickProp,
  sha256,
} from "./common.js";

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
    const writeType = type === "Load";
    const fieldRel = writeType ? REL_TYPES.DR_WRITES_FIELD : REL_TYPES.DR_READS_FIELD;

    // DRMapItem children (attached as `elements` by the Vlocity runner's
    // child fetch) carry the mapping structurally: one side names a real
    // SObject + field, the other side is a JSON/XML path (colon-separated,
    // e.g. `Details:AccountNumber`). For Extract/Turbo the Salesforce side
    // is the Interface pair; for Load it is the Domain pair — but checking
    // both sides independently is direction-agnostic and survives map
    // variants, because the payload side never passes isSObjectName.
    const seenFields = new Set<string>();
    const seenObjects = new Set<string>();
    const elements: any[] = Array.isArray(dp.elements) ? dp.elements : [];
    for (const el of elements) {
      const sides: Array<[unknown, unknown]> = [
        [pickProp(el, "InterfaceObjectName"), pickProp(el, "InterfaceFieldAPIName")],
        [pickProp(el, "DomainObjectAPIName"), pickProp(el, "DomainObjectFieldAPIName")],
        [pickProp(el, "LookupDomainObjectName"), pickProp(el, "LookupDomainObjectFieldName")],
      ];
      for (const [obj, field] of sides) {
        if (!isSObjectName(obj) || !isPlainFieldName(field)) continue;
        seenObjects.add(obj);
        const key = `${obj}.${field}`;
        if (seenFields.has(key)) continue;
        seenFields.add(key);
        edges.push(makeEdge(ctx, src, fieldRel, `CustomField:${key}`));
      }
      // Formula expressions reference fields as `Object.Field` text — the
      // one place the regex extractor is still the right tool.
      for (const fkey of ["Formula", "FormulaConverted", "TransformValuesMap"]) {
        const fv = pickProp(el, fkey);
        if (typeof fv !== "string" || fv.length === 0) continue;
        for (const r of extractFieldRefs(fv)) {
          const key = `${r.object}.${r.field}`;
          if (seenFields.has(key)) continue;
          seenFields.add(key);
          edges.push(makeEdge(ctx, src, REL_TYPES.DR_READS_FIELD, `CustomField:${key}`));
        }
      }
    }

    for (const obj of seenObjects) {
      edges.push(makeEdge(ctx, src, REL_TYPES.REFERENCES_OBJECT, `CustomObject:${obj}`));
    }

    if (type === "Transform") {
      edges.push(makeEdge(ctx, src, REL_TYPES.DR_TRANSFORMS, `Transform:${input.name}`));
    }

    return { nodes, edges };
  }
}
