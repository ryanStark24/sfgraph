import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";
import { parseField } from "./field.js";
import { type FormulaFieldInfo, formulaFieldRefs } from "./formula-refs.js";
import { parseRecordType } from "./record-type.js";
import { parseValidationRule } from "./validation-rule.js";

export interface ObjectDirInput {
  apiName: string; // e.g. Account, Order_Event__e
  objectXml: string;
  /** True when the source folder has `fields/` but no `<O>.object-meta.xml`. */
  stub?: boolean;
  fields?: Record<string, string>; // apiName -> xml
  recordTypes?: Record<string, string>;
  validationRules?: Record<string, string>;
}

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Folded into the content hash of source-file CustomField nodes. Bump it when
 * the parser starts emitting new attributes for unchanged XML: the graph merge
 * only rewrites attributes when the hash changes, so a plain re-ingest would
 * otherwise keep the old attributes. v2: referenceTo / relationshipName.
 */
export const FIELD_NODE_HASH_SALT = "custom-field-attrs:v2";

/**
 * Same idea for the CustomObject / PlatformEvent node built from the object
 * XML. v2: customSettingsType.
 */
export const OBJECT_NODE_HASH_SALT = "custom-object-attrs:v2";

export class CustomObjectParser implements Parser<ObjectDirInput> {
  readonly category = METADATA_CATEGORY.OBJECT;
  readonly type = "CustomObject";

  async parse(input: ObjectDirInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const apiName = stripNs(input.apiName, ctx.namespace);
    const objQname = `CustomObject:${apiName}`;

    let parsed: any = {};
    try {
      parsed = xmlParser.parse(input.objectXml);
    } catch {
      // emit ParseError and continue with empty object body
    }
    const obj = parsed?.CustomObject ?? {};
    const isPlatformEvent = apiName.endsWith("__e");

    nodes.push(
      makeNode(
        ctx,
        isPlatformEvent ? "PlatformEvent" : "CustomObject",
        objQname,
        {
          apiName,
          label: obj.label ?? null,
          sharingModel: obj.sharingModel ?? null,
          isPlatformEvent,
          // Description is extracted from the org but was dropped here, leaving
          // buildEmbedText's `description` branch permanently empty. Carry it so
          // object descriptions become semantically searchable.
          description: obj.description ?? null,
          // `List` / `Hierarchy` marks a custom setting (absent on data objects).
          ...(obj.customSettingsType ? { customSettingsType: String(obj.customSettingsType) } : {}),
          ...(input.stub ? { stub: true } : {}),
        },
        sha256(`${OBJECT_NODE_HASH_SALT}\n${input.objectXml}`),
      ),
    );

    if (isPlatformEvent) {
      // Also emit a discoverable PlatformEvent:Name__e qname
      nodes.push(
        makeNode(
          ctx,
          "PlatformEvent",
          `PlatformEvent:${apiName}`,
          { apiName },
          sha256(input.objectXml),
        ),
      );
    }

    // Track which field qnames we've already emitted so the separate-file
    // loop below doesn't duplicate the inline ones.
    const emittedFieldQnames = new Set<string>();
    // Every field of this object (for formula resolution) and the formulas
    // to resolve once all of them are known.
    const fieldInfos: FormulaFieldInfo[] = [];
    const formulas: Array<{ src: string; formula: string; attrs: Record<string, unknown> }> = [];

    // Inline fields (live-org describe path). The live extractor builds a
    // CustomObject XML with <fields> elements containing fullName/type/
    // referenceTo/relationshipName/formula etc. The filesystem path passes
    // fields separately via input.fields — that loop runs after this one.
    //
    // Without this block, every SObject ingested from a live org becomes
    // a node with zero outgoing edges and zero CustomField children, which
    // breaks trace_downstream / analyze_field for standard objects like
    // Account / Contact / Opportunity.
    const inlineFields = obj.fields ? (Array.isArray(obj.fields) ? obj.fields : [obj.fields]) : [];
    for (const f of inlineFields) {
      if (!f || typeof f !== "object") continue;
      const fieldApi = String(f.fullName ?? f.name ?? "");
      if (!fieldApi) continue;
      const fieldQname = `CustomField:${apiName}.${fieldApi}`;
      if (emittedFieldQnames.has(fieldQname)) continue;
      emittedFieldQnames.add(fieldQname);
      const fieldType = f.type ? String(f.type) : null;
      const formula = f.formula ? String(f.formula) : null;
      const required = f.required === true || f.required === "true";
      // fast-xml-parser collapses array-of-strings differently depending on
      // count: 0 -> undefined, 1 -> string, 2+ -> string[]. Normalise.
      const refRaw = f.referenceTo;
      const referenceTo: string[] = Array.isArray(refRaw)
        ? refRaw.map((x: unknown) => String(x))
        : refRaw
          ? [String(refRaw)]
          : [];
      const relationshipName = f.relationshipName ? String(f.relationshipName) : null;
      nodes.push(
        makeNode(
          ctx,
          "CustomField",
          fieldQname,
          {
            apiName: fieldApi,
            type: fieldType,
            formula,
            required,
            object: apiName,
            referenceTo,
            relationshipName,
            // Field description / inline help — extracted but previously dropped,
            // so the embedding's `description` branch never fired for fields.
            description: f.description ? String(f.description) : null,
          },
          sha256(
            `${fieldQname}|${fieldType ?? ""}|${formula ?? ""}|${referenceTo.join(",")}|${f.description ?? ""}`,
          ),
        ),
      );
      edges.push(makeEdge(ctx, objQname, REL_TYPES.DEFINES_FIELD, fieldQname));
      // Lookup / Master-Detail relationships: emit one REFERENCES_OBJECT
      // edge per target in the referenceTo array.
      for (const target of referenceTo) {
        if (!target) continue;
        edges.push(
          makeEdge(ctx, fieldQname, REL_TYPES.REFERENCES_OBJECT, `CustomObject:${target}`, {
            ...(relationshipName ? { relationshipName } : {}),
            ...(fieldType ? { fieldType } : {}),
          }),
        );
      }
      // W2-04: MCD gap-fill edges. The platform's
      // MetadataComponentDependency SObject omits picklist→GlobalValueSet
      // and dependent-picklist→controlling-field references; synthesise
      // them from the field's describe payload. The valueSet structure
      // is fast-xml-parser's nested form: `{ valueSetName: 'X' }` or
      // `{ controllingField: 'Status__c', valueSettings: [...] }`.
      const valueSet = f.valueSet;
      if (valueSet && typeof valueSet === "object") {
        const valueSetName = (valueSet as Record<string, unknown>).valueSetName;
        if (typeof valueSetName === "string" && valueSetName.length > 0) {
          edges.push(
            makeEdge(
              ctx,
              fieldQname,
              REL_TYPES.USES_GLOBAL_VALUE_SET,
              `GlobalValueSet:${valueSetName}`,
              { ...(fieldType ? { fieldType } : {}) },
            ),
          );
        }
        const controllingField = (valueSet as Record<string, unknown>).controllingField;
        if (typeof controllingField === "string" && controllingField.length > 0) {
          // Controlling field is named on the SAME object as this dependent
          // picklist (Salesforce only supports same-object controllers).
          edges.push(
            makeEdge(
              ctx,
              fieldQname,
              REL_TYPES.DEPENDS_ON_FIELD,
              `CustomField:${apiName}.${controllingField}`,
              { reason: "dependent-picklist" },
            ),
          );
        }
      }
      fieldInfos.push({ apiName: fieldApi, referenceTo, relationshipName });
      // Formula refs are resolved once every field of the object is known.
      if (formula) formulas.push({ src: fieldQname, formula, attrs: { via: "formula" } });
    }

    // Fields (separate XML files in source-dir layout)
    for (const [fieldApi, fxml] of Object.entries(input.fields ?? {})) {
      const f = parseField(fieldApi, fxml);
      const fieldQname = `CustomField:${apiName}.${f.apiName}`;
      // Skip if already emitted via the inline-fields path above.
      if (emittedFieldQnames.has(fieldQname)) continue;
      emittedFieldQnames.add(fieldQname);
      // Lookup / Master-Detail target and relationship name, so graph
      // resolvers can follow `X__r.F` paths (same keys as the inline path).
      const fsRaw = f.raw as Record<string, unknown> | undefined;
      const fsRef = fsRaw?.referenceTo;
      const fsReferenceTo: string[] = Array.isArray(fsRef)
        ? fsRef.map((x: unknown) => String(x))
        : fsRef
          ? [String(fsRef)]
          : [];
      const fsRelName = fsRaw?.relationshipName ? String(fsRaw.relationshipName) : null;
      nodes.push(
        makeNode(
          ctx,
          "CustomField",
          fieldQname,
          {
            apiName: f.apiName,
            type: f.type,
            formula: f.formula,
            required: f.required,
            object: apiName,
            ...(fsReferenceTo.length > 0 ? { referenceTo: fsReferenceTo } : {}),
            ...(fsRelName ? { relationshipName: fsRelName } : {}),
          },
          sha256(`${FIELD_NODE_HASH_SALT}\n${fxml}`),
        ),
      );
      edges.push(makeEdge(ctx, objQname, REL_TYPES.DEFINES_FIELD, fieldQname));

      fieldInfos.push({
        apiName: f.apiName,
        referenceTo: fsReferenceTo,
        relationshipName: fsRelName,
      });
      if (f.formula)
        formulas.push({ src: fieldQname, formula: f.formula, attrs: { via: "formula" } });

      // W2-04 MCD gap-fill on the filesystem path (mirrors the inline path
      // above). parseField exposes the unparsed XML as `raw`, which we
      // probe for valueSet.valueSetName / valueSet.controllingField.
      const rawField = f.raw as Record<string, unknown> | undefined;
      const fsValueSet = rawField?.valueSet;
      if (fsValueSet && typeof fsValueSet === "object") {
        const valueSetName = (fsValueSet as Record<string, unknown>).valueSetName;
        if (typeof valueSetName === "string" && valueSetName.length > 0) {
          edges.push(
            makeEdge(
              ctx,
              fieldQname,
              REL_TYPES.USES_GLOBAL_VALUE_SET,
              `GlobalValueSet:${valueSetName}`,
              { ...(f.type ? { fieldType: f.type } : {}) },
            ),
          );
        }
        const controllingField = (fsValueSet as Record<string, unknown>).controllingField;
        if (typeof controllingField === "string" && controllingField.length > 0) {
          edges.push(
            makeEdge(
              ctx,
              fieldQname,
              REL_TYPES.DEPENDS_ON_FIELD,
              `CustomField:${apiName}.${controllingField}`,
              { reason: "dependent-picklist" },
            ),
          );
        }
      }
    }

    // Record types
    for (const [rtApi, rxml] of Object.entries(input.recordTypes ?? {})) {
      const rt = parseRecordType(rtApi, rxml);
      const rtQname = `RecordType:${apiName}.${rt.apiName}`;
      nodes.push(
        makeNode(
          ctx,
          "RecordType",
          rtQname,
          { apiName: rt.apiName, label: rt.label, active: rt.active, object: apiName },
          sha256(rxml),
        ),
      );
      edges.push(makeEdge(ctx, objQname, REL_TYPES.HAS_RECORD_TYPE, rtQname));
    }

    // Validation rules
    for (const [vrApi, vxml] of Object.entries(input.validationRules ?? {})) {
      const vr = parseValidationRule(vrApi, vxml);
      const vrQname = `ValidationRule:${apiName}.${vr.apiName}`;
      nodes.push(
        makeNode(
          ctx,
          "ValidationRule",
          vrQname,
          {
            apiName: vr.apiName,
            active: vr.active,
            errorConditionFormula: vr.errorConditionFormula,
            object: apiName,
          },
          sha256(vxml),
        ),
      );
      edges.push(makeEdge(ctx, objQname, REL_TYPES.HAS_VALIDATION_RULE, vrQname));

      if (vr.errorConditionFormula)
        formulas.push({ src: vrQname, formula: vr.errorConditionFormula, attrs: {} });
    }

    for (const { src, formula, attrs } of formulas) {
      const refs = formulaFieldRefs(formula, apiName, fieldInfos);
      for (const target of refs.fields) {
        const rel = refs.hops[target];
        edges.push(
          makeEdge(
            ctx,
            src,
            REL_TYPES.READS_FIELD,
            `CustomField:${stripNs(target, ctx.namespace)}`,
            rel ? { ...attrs, hopRelationship: rel } : attrs,
          ),
        );
      }
      for (const label of refs.labels)
        edges.push(
          makeEdge(ctx, src, REL_TYPES.REFERENCES, `CustomLabel:${label}`, { via: "formula" }),
        );
    }

    return { nodes, edges };
  }
}
