import {
  type EdgeFact,
  METADATA_CATEGORY,
  type NodeFact,
  REL_TYPES,
  type RelType,
} from "../../domain/index.js";
import { toArr } from "../_xml-helpers.js";
import { makeEdge } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";
import {
  asStructured,
  buildBaseNode,
  isPlainFieldName,
  isSObjectName,
  pickProp,
  sha256,
} from "../vlocity/common.js";

export interface OmniDataTransformInput {
  name: string;
  metadata: unknown;
}

export class OmniDataTransformParser implements Parser<OmniDataTransformInput> {
  readonly category = METADATA_CATEGORY.OMNI_DATA_TRANSFORM;
  readonly type = "OmniDataTransform";

  async parse(input: OmniDataTransformInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    // SOQL path yields parsed JSON; the Metadata-API retrieve path yields
    // raw XML — asStructured handles both so retrieve-hydrated content is
    // no longer silently dropped.
    const md = asStructured(input.metadata);
    const hash = sha256(JSON.stringify(md));
    const node = buildBaseNode({
      ctx,
      label: "OmniDataTransform",
      prefix: "OMNI",
      name: input.name,
      raw: md,
      hash,
    });
    nodes.push(node);
    const src = node.qualifiedName as unknown as string;

    // OmniDataTransformItem rows carry the field mappings structurally.
    // SOQL child fetch attaches them as `items` (UpperCamel field names);
    // Metadata-API XML nests them as `omniDataTransformItem` (lowerCamel).
    // A side that names a real SObject is a Salesforce read/write; the
    // JSON payload side ("json", colon-separated paths) never qualifies.
    const items: any[] = Array.isArray(pickProp(md, "Items"))
      ? (pickProp(md, "Items") as any[])
      : Array.isArray(md.items)
        ? md.items
        : toArr(pickProp(md, "OmniDataTransformItem"));

    const seenFields = new Set<string>();
    const seenObjects = new Set<string>();
    const emitField = (obj: unknown, field: unknown, rel: RelType) => {
      if (!isSObjectName(obj) || !isPlainFieldName(field)) return;
      seenObjects.add(obj);
      const key = `${obj}.${field}`;
      if (seenFields.has(key)) return;
      seenFields.add(key);
      edges.push(makeEdge(ctx, src, rel, `CustomField:${key}`));
    };

    for (const it of items) {
      emitField(
        pickProp(it, "InputObjectName"),
        pickProp(it, "InputFieldName"),
        REL_TYPES.DR_READS_FIELD,
      );
      emitField(
        pickProp(it, "OutputObjectName"),
        pickProp(it, "OutputFieldName"),
        REL_TYPES.DR_WRITES_FIELD,
      );
      emitField(
        pickProp(it, "LookupObjectName"),
        pickProp(it, "LookupByFieldName"),
        REL_TYPES.DR_READS_FIELD,
      );
    }

    const sourceObject = pickProp(md, "SourceObject");
    if (isSObjectName(sourceObject)) seenObjects.add(sourceObject);
    for (const obj of seenObjects) {
      edges.push(makeEdge(ctx, src, REL_TYPES.REFERENCES_OBJECT, `CustomObject:${obj}`));
    }

    return { nodes, edges };
  }
}
