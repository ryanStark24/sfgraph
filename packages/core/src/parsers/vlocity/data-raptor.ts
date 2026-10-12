import {
  type EdgeFact,
  METADATA_CATEGORY,
  type NodeFact,
  REL_TYPES,
  type RelType,
  STANDARD_SOBJECT_WHITELIST,
} from "../../domain/index.js";
import { makeEdge } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";
import {
  asJson,
  buildBaseNode,
  isPlainFieldName,
  isSObjectName,
  payloadParseErrors,
  pickProp,
  sha256,
} from "./common.js";

export interface DataRaptorInput {
  name: string;
  datapack: unknown; // JSON or string
}

/** A `Rel__r.Field` path on a real object, left for the graph resolver
 *  (`dr-relationship-resolver.ts`), which knows each lookup's target. */
export interface DrRelationshipPath {
  object: string;
  path: string;
  rel: RelType;
}

/**
 * Folded into the DataRaptor node's content hash. Bump it when the parser
 * starts emitting new node attributes for an unchanged pack: the graph merge
 * only rewrites attributes on a hash change. v2: drRelationshipPaths.
 */
export const DATARAPTOR_NODE_HASH_SALT = "dataraptor-attrs:v2";

const NS_TOKEN_RE = /%vlocity_namespace%__/g;
const CUSTOM_SUFFIX_RE = /__(?:c|mdt|e|b|x)$/;
const REL_PATH_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
// `Alias:Path` / `A:B:Path` tokens in formula text (JSON paths of the DR).
const ALIAS_TOKEN_RE = /[A-Za-z_][\w]*(?::[A-Za-z_][\w]*)+(?:\.[A-Za-z_][\w]*)*/g;
const VLOCITY_SYS_RE = /\$Vlocity\.\w+/gi;
const OBJECT_FIELD_RE = /\b([A-Z][A-Za-z0-9_]*)\.([A-Z][A-Za-z0-9_]*)\b/g;

/** Strip the unsubstituted DataPack namespace token (the DataPack extractor
 *  substitutes the real namespace when the source tree shows one). */
function normNs(v: unknown): unknown {
  return typeof v === "string" ? v.replace(NS_TOKEN_RE, "").trim() : v;
}

/** Object names a formula's `Object.Field` text may name: custom-suffixed
 *  or a known standard SObject (not JSON nodes such as `$Vlocity`). */
function isKnownObjectName(o: string): boolean {
  return CUSTOM_SUFFIX_RE.test(o) || STANDARD_SOBJECT_WHITELIST.has(o);
}

/** A mapping side pair that is a DR pseudo side, not an SObject field
 *  (`Formula`/`Formula`, `Configuration`/`Configuration`, …). */
function isPseudoPair(obj: string, field: string): boolean {
  return obj.toLowerCase() === "formula" || obj.toLowerCase() === field.toLowerCase();
}

export class DataRaptorParser implements Parser<DataRaptorInput> {
  readonly category = METADATA_CATEGORY.VLOCITY_DATARAPTOR;
  readonly type = "VlocityDataRaptor";

  async parse(input: DataRaptorInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const dp = asJson(input.datapack);
    const hash = sha256(`${DATARAPTOR_NODE_HASH_SALT}\n${JSON.stringify(dp)}`);
    const node = buildBaseNode({
      ctx,
      label: "DataRaptor",
      prefix: "DR",
      name: input.name,
      raw: dp,
      hash,
    });
    nodes.push(node, ...payloadParseErrors(ctx, node, dp));

    const src = node.qualifiedName as unknown as string;
    const type = String(dp.Type ?? dp.type ?? "");
    const writeType = type === "Load";
    const fieldRel = writeType ? REL_TYPES.DR_WRITES_FIELD : REL_TYPES.DR_READS_FIELD;

    const seenFields = new Set<string>();
    const seenObjects = new Set<string>();
    const relPaths: DrRelationshipPath[] = [];
    const seenPaths = new Set<string>();
    const emitField = (obj: string, field: string, rel: RelType) => {
      seenObjects.add(obj);
      const key = `${obj}.${field}`;
      if (seenFields.has(key)) return;
      seenFields.add(key);
      edges.push(makeEdge(ctx, src, rel, `CustomField:${key}`));
    };
    // Field or `Rel__r.Field` path on a real object. Anything else: nothing.
    const emitPath = (obj: string, path: string, rel: RelType) => {
      if (isPlainFieldName(path)) {
        if (!isPseudoPair(obj, path)) emitField(obj, path, rel);
        return;
      }
      if (!REL_PATH_RE.test(path)) return;
      seenObjects.add(obj);
      const key = `${obj}|${path}|${rel}`;
      if (seenPaths.has(key)) return;
      seenPaths.add(key);
      relPaths.push({ object: obj, path, rel });
    };

    // DRMapItem children (attached as `elements` by the Vlocity runner's
    // child fetch / DataPack extractor) carry the mapping structurally: one
    // side names a real SObject + field, the other side is a JSON/XML path
    // (colon-separated, e.g. `Details:AccountNumber`). For Extract/Turbo the
    // Salesforce side is the Interface pair; for Load it is the Domain pair —
    // checking both sides independently is direction-agnostic, because the
    // payload side never passes isSObjectName.
    // Disabled mappings (`IsDisabled: true`) neither read nor write, and
    // their step rows define no alias: drop them before both passes.
    const elements: any[] = (Array.isArray(dp.elements) ? dp.elements : []).filter(
      (el: unknown) => pickProp(el, "IsDisabled") !== true,
    );

    // Extract step rows name the real object for an output alias: the
    // Interface side is the SObject, the Domain field is the alias path
    // (`Quote`, `Contract:Order`). Output rows then read `Alias:Field`.
    const aliasToObj = new Map<string, string | null>();
    for (const el of elements) {
      const obj = normNs(pickProp(el, "InterfaceObjectName"));
      const alias = normNs(pickProp(el, "DomainObjectFieldAPIName"));
      const domainObj = normNs(pickProp(el, "DomainObjectAPIName"));
      if (!isSObjectName(obj) || typeof alias !== "string" || !alias) continue;
      if (isSObjectName(domainObj)) continue; // a Load row: the Domain pair is a real field
      const prev = aliasToObj.get(alias);
      // Conflicting objects for one alias: ambiguous, resolve nothing.
      aliasToObj.set(alias, prev === undefined || prev === obj ? obj : null);
    }
    const aliasLookup = (alias: string): string | null => {
      const hit = aliasToObj.get(alias);
      if (hit !== undefined) return hit;
      const lower = alias.toLowerCase();
      const found = [...aliasToObj.entries()].filter(([a]) => a.toLowerCase() === lower);
      return found.length === 1 ? (found[0]?.[1] ?? null) : null;
    };
    const resolveAliasPath = (value: string, rel: RelType): boolean => {
      const cut = value.lastIndexOf(":");
      if (cut <= 0) return false;
      const obj = aliasLookup(value.slice(0, cut));
      if (!obj) return false;
      emitPath(obj, value.slice(cut + 1), rel);
      return true;
    };

    for (const el of elements) {
      // [object, field, alias-resolvable]: only the Interface side of a
      // non-Load map reads `Alias:Field`; the Domain side of an Extract is
      // the output JSON path, which often reuses the alias names.
      const sides: Array<[unknown, unknown, boolean]> = [
        [pickProp(el, "InterfaceObjectName"), pickProp(el, "InterfaceFieldAPIName"), !writeType],
        [pickProp(el, "DomainObjectAPIName"), pickProp(el, "DomainObjectFieldAPIName"), false],
        [
          pickProp(el, "LookupDomainObjectName"),
          pickProp(el, "LookupDomainObjectFieldName"),
          false,
        ],
      ];
      for (const [rawObj, rawField, viaAlias] of sides) {
        const obj = normNs(rawObj);
        const field = normNs(rawField);
        if (typeof field !== "string" || !field) continue;
        if (isSObjectName(obj)) emitPath(obj, field, fieldRel);
        else if (viaAlias) resolveAliasPath(field, fieldRel);
      }
      // Formula text reads fields as `Alias:Field` (resolved through the
      // step aliases) or, occasionally, `Object.Field` on a known SObject.
      for (const fkey of ["Formula", "FormulaConverted", "TransformValuesMap"]) {
        const fv = normNs(pickProp(el, fkey));
        if (typeof fv !== "string" || fv.length === 0) continue;
        const rest = fv.replace(VLOCITY_SYS_RE, " ").replace(ALIAS_TOKEN_RE, (tok) => {
          resolveAliasPath(tok, REL_TYPES.DR_READS_FIELD);
          return " ";
        });
        for (const m of rest.matchAll(OBJECT_FIELD_RE)) {
          const o = m[1] ?? "";
          const f = m[2] ?? "";
          // Mid-path (`a.B.C`) or relationship (`X__r.F`) text is a JSON
          // path, not `Object.Field`: emit nothing rather than a guess.
          const before = m.index > 0 ? rest.charAt(m.index - 1) : "";
          if (before === "." || o.endsWith("__r") || !isKnownObjectName(o)) continue;
          emitField(o, f, REL_TYPES.DR_READS_FIELD);
        }
      }
    }

    for (const obj of seenObjects) {
      edges.push(makeEdge(ctx, src, REL_TYPES.REFERENCES_OBJECT, `CustomObject:${obj}`));
    }
    if (relPaths.length > 0) node.attributes.drRelationshipPaths = relPaths;

    if (type === "Transform") {
      edges.push(makeEdge(ctx, src, REL_TYPES.DR_TRANSFORMS, `Transform:${input.name}`));
    }

    return { nodes, edges };
  }
}
