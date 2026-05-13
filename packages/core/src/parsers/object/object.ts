import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";
import { parseField } from "./field.js";
import { parseRecordType } from "./record-type.js";
import { parseValidationRule } from "./validation-rule.js";

export interface ObjectDirInput {
  apiName: string; // e.g. Account, Order_Event__e
  objectXml: string;
  fields?: Record<string, string>; // apiName -> xml
  recordTypes?: Record<string, string>;
  validationRules?: Record<string, string>;
}

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

const FORMULA_RE = /\b([A-Z][A-Za-z0-9_]*(?:__r)?)\.([A-Z][A-Za-z0-9_]*(?:__c)?)\b/g;

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
        },
        sha256(input.objectXml),
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

    // Fields (separate XML files in source-dir layout)
    for (const [fieldApi, fxml] of Object.entries(input.fields ?? {})) {
      const f = parseField(fieldApi, fxml);
      const fieldQname = `CustomField:${apiName}.${f.apiName}`;
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
          },
          sha256(fxml),
        ),
      );
      edges.push(makeEdge(ctx, objQname, REL_TYPES.DEFINES_FIELD, fieldQname));

      if (f.formula) {
        const re = new RegExp(FORMULA_RE.source, "g");
        let m: RegExpExecArray | null = re.exec(f.formula);
        const seen = new Set<string>();
        while (m !== null) {
          const refObj = (m[1] ?? "").replace(/__r$/, "");
          const refField = m[2] ?? "";
          const key = `${refObj}.${refField}`;
          if (!seen.has(key)) {
            seen.add(key);
            edges.push(
              makeEdge(
                ctx,
                fieldQname,
                REL_TYPES.READS_FIELD,
                `CustomField:${refObj}.${refField}`,
                {
                  via: "formula",
                },
              ),
            );
          }
          m = re.exec(f.formula);
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

      if (vr.errorConditionFormula) {
        const re = new RegExp(FORMULA_RE.source, "g");
        let m: RegExpExecArray | null = re.exec(vr.errorConditionFormula);
        const seen = new Set<string>();
        while (m !== null) {
          const refObj = (m[1] ?? "").replace(/__r$/, "");
          const refField = m[2] ?? "";
          const key = `${refObj}.${refField}`;
          if (!seen.has(key)) {
            seen.add(key);
            edges.push(
              makeEdge(ctx, vrQname, REL_TYPES.READS_FIELD, `CustomField:${refObj}.${refField}`),
            );
          }
          m = re.exec(vr.errorConditionFormula);
        }
      }
    }

    return { nodes, edges };
  }
}
