import _parser from "@babel/parser";
import _traverse from "@babel/traverse";
import type { NodePath } from "@babel/traverse";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { REL_TYPES } from "../../domain/index.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext } from "../contract.js";

const parser = (_parser as any).default ?? _parser;
const traverse = (_traverse as any).default ?? _traverse;

export interface JsExtractResult {
  extraEdges: EdgeFact[];
  extraNodes: NodeFact[];
  /** Phase 5: bindings the HTML visitor needs to resolve `{var.field}`. */
  bindings: LwcBindings;
}

const APEX_IMPORT_RE = /^@salesforce\/apex\/([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/;
const SR_IMPORT_RE = /^@salesforce\/resourceUrl\/([A-Za-z_]\w*)$/;
const LABEL_IMPORT_RE = /^@salesforce\/label\/c\.([A-Za-z_]\w*)$/;
const SCHEMA_OBJ_RE = /^@salesforce\/schema\/([A-Za-z_][\w]*)$/;
const SCHEMA_FIELD_RE = /^@salesforce\/schema\/([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)$/;

/**
 * LWC template bindings discovered through JS analysis. Consumed by
 * html-visitor to resolve `{var.field}` expressions in markup to real
 * CustomField qnames when possible.
 */
export interface LwcBindings {
  /** Map of wired property name → sObject API name. Populated from
   *  `@wire(getRecord, { fields: [...] })` and similar wire adapters whose
   *  result is bound to an instance property. */
  wireToSObject: Map<string, string>;
  /** Map of imported local name → CustomField qname. From
   *  `import NAME_FIELD from '@salesforce/schema/Account.Name'`. */
  schemaFieldImports: Map<string, { sObject: string; field: string }>;
  /** Map of imported local name → sObject API name. From
   *  `import ACCOUNT_OBJECT from '@salesforce/schema/Account'`. */
  schemaObjectImports: Map<string, string>;
}

export function extractJsEdges(
  source: string,
  lwcQname: string,
  ctx: ParseContext,
): JsExtractResult {
  const extraEdges: EdgeFact[] = [];
  const extraNodes: NodeFact[] = [];
  // Map of localName -> { className, methodName } for apex imports.
  const apexImports: Record<string, { className: string; methodName: string }> = {};
  const bindings: LwcBindings = {
    wireToSObject: new Map(),
    schemaFieldImports: new Map(),
    schemaObjectImports: new Map(),
  };

  let ast: any;
  try {
    ast = parser.parse(source, {
      sourceType: "module",
      plugins: ["decorators-legacy", "classProperties", "typescript"],
    });
  } catch (err) {
    extraNodes.push(
      makeNode(ctx, "ParseError", `ParseError:LWC:${lwcQname}`, {
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return { extraEdges, extraNodes, bindings };
  }

  traverse(ast, {
    ImportDeclaration(path: NodePath<any>) {
      const src = String(path.node.source?.value ?? "");
      let m = APEX_IMPORT_RE.exec(src);
      if (m) {
        const className = stripNs(m[1] ?? "", ctx.namespace);
        const methodName = m[2] ?? "";
        const localDefault = path.node.specifiers?.find(
          (s: any) => s.type === "ImportDefaultSpecifier",
        );
        if (localDefault?.local?.name) {
          apexImports[String(localDefault.local.name)] = { className, methodName };
        }
        extraEdges.push(
          makeEdge(
            lwcCtx(ctx),
            lwcQname,
            REL_TYPES.IMPORTS_APEX,
            `ApexMethod:${className}.${methodName}(?)`,
            {
              className,
              methodName,
            },
          ),
        );
        return;
      }
      m = SR_IMPORT_RE.exec(src);
      if (m) {
        extraEdges.push(
          makeEdge(
            ctx,
            lwcQname,
            REL_TYPES.IMPORTS_STATIC_RESOURCE,
            `StaticResource:${stripNs(m[1] ?? "", ctx.namespace)}`,
          ),
        );
        return;
      }
      m = LABEL_IMPORT_RE.exec(src);
      if (m) {
        extraEdges.push(
          makeEdge(
            ctx,
            lwcQname,
            REL_TYPES.IMPORTS_CUSTOM_LABEL,
            `CustomLabel:${stripNs(m[1] ?? "", ctx.namespace)}`,
          ),
        );
        return;
      }
      // Schema field import: `import NAME_FIELD from '@salesforce/schema/Account.Name'`.
      m = SCHEMA_FIELD_RE.exec(src);
      if (m) {
        const sObject = stripNs(m[1] ?? "", ctx.namespace);
        const field = m[2] ?? "";
        const localDefault = path.node.specifiers?.find(
          (s: any) => s.type === "ImportDefaultSpecifier",
        );
        if (localDefault?.local?.name) {
          bindings.schemaFieldImports.set(String(localDefault.local.name), { sObject, field });
        }
        extraEdges.push(
          makeEdge(
            ctx,
            lwcQname,
            REL_TYPES.READS_FIELD,
            `CustomField:${sObject}.${field}`,
            { via: "schema-import" },
          ),
        );
        return;
      }
      // Schema object import: `import ACCOUNT_OBJECT from '@salesforce/schema/Account'`.
      m = SCHEMA_OBJ_RE.exec(src);
      if (m) {
        const sObject = stripNs(m[1] ?? "", ctx.namespace);
        const localDefault = path.node.specifiers?.find(
          (s: any) => s.type === "ImportDefaultSpecifier",
        );
        if (localDefault?.local?.name) {
          bindings.schemaObjectImports.set(String(localDefault.local.name), sObject);
        }
        extraEdges.push(
          makeEdge(
            ctx,
            lwcQname,
            REL_TYPES.REFERENCES_OBJECT,
            `CustomObject:${sObject}`,
            { via: "schema-import" },
          ),
        );
      }
    },

    Decorator(path: NodePath<any>) {
      const expr = path.node.expression;
      if (expr?.type === "CallExpression" && expr.callee?.name === "wire") {
        const arg0 = expr.arguments?.[0];
        if (arg0?.type === "Identifier") {
          const target = apexImports[String(arg0.name)];
          if (target) {
            extraEdges.push(
              makeEdge(
                ctx,
                lwcQname,
                REL_TYPES.USES_WIRE,
                `ApexMethod:${target.className}.${target.methodName}(?)`,
                { kind: "apex" },
              ),
            );
          }
        }
        // For wire adapters that return a record/records of a known sObject
        // (getRecord / getRecords / getRelatedListRecords), bind the wired
        // property name to that sObject so the template visitor can resolve
        // `{record.Name}` → CustomField:Account.Name.
        const wireAdapter = arg0?.type === "Identifier" ? String(arg0.name) : "";
        const RECORD_ADAPTERS = new Set([
          "getRecord",
          "getRecords",
          "getRecordCreateDefaults",
          "getRecordUi",
          "getRelatedListRecords",
        ]);
        if (RECORD_ADAPTERS.has(wireAdapter)) {
          // Pull `fields: [X, Y]` from the second arg if present, infer
          // sObject from the first imported schema field.
          const optsArg = expr.arguments?.[1];
          let sObject: string | null = null;
          if (optsArg?.type === "ObjectExpression") {
            for (const prop of optsArg.properties) {
              const keyName = prop?.key?.name ?? prop?.key?.value;
              if (keyName === "fields" || keyName === "optionalFields") {
                const elements = prop.value?.elements ?? [];
                for (const el of elements) {
                  if (el?.type === "Identifier") {
                    const ref = bindings.schemaFieldImports.get(String(el.name));
                    if (ref) {
                      sObject = ref.sObject;
                      break;
                    }
                  }
                }
              } else if (keyName === "objectApiName") {
                const v = prop.value;
                if (v?.type === "Identifier") {
                  const ref = bindings.schemaObjectImports.get(String(v.name));
                  if (ref) sObject = ref;
                }
              }
              if (sObject) break;
            }
          }
          // The decorated node is a ClassProperty / MethodDefinition; pull its name.
          const decoratedName = (() => {
            const parent = path.parentPath?.node as any;
            const key = parent?.key;
            return key?.name ?? key?.value;
          })();
          if (sObject && typeof decoratedName === "string") {
            bindings.wireToSObject.set(decoratedName, sObject);
          }
        }
      }
    },

    CallExpression(path: NodePath<any>) {
      const callee = path.node.callee;
      // Apex imperative call: importedName({...})
      if (callee?.type === "Identifier") {
        const target = apexImports[String(callee.name)];
        if (target) {
          extraEdges.push(
            makeEdge(
              ctx,
              lwcQname,
              REL_TYPES.CALLS_APEX_FROM_LWC,
              `ApexMethod:${target.className}.${target.methodName}(?)`,
            ),
          );
        }
      }
      // dispatchEvent(new CustomEvent('name', ...))
      if (callee?.type === "MemberExpression" && callee.property?.name === "dispatchEvent") {
        const arg = path.node.arguments?.[0];
        if (
          arg?.type === "NewExpression" &&
          arg.callee?.name === "CustomEvent" &&
          arg.arguments?.[0]?.type === "StringLiteral"
        ) {
          const evtName = String(arg.arguments[0].value);
          extraEdges.push(
            makeEdge(ctx, lwcQname, REL_TYPES.DISPATCHES_EVENT, `LWCEvent:${evtName}`),
          );
        }
      }
    },
  });

  return { extraEdges, extraNodes, bindings };
}

function lwcCtx(ctx: ParseContext): ParseContext {
  return ctx;
}
