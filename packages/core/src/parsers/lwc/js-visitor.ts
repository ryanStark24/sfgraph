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
}

const APEX_IMPORT_RE = /^@salesforce\/apex\/([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/;
const SR_IMPORT_RE = /^@salesforce\/resourceUrl\/([A-Za-z_]\w*)$/;
const LABEL_IMPORT_RE = /^@salesforce\/label\/c\.([A-Za-z_]\w*)$/;

export function extractJsEdges(
  source: string,
  lwcQname: string,
  ctx: ParseContext,
): JsExtractResult {
  const extraEdges: EdgeFact[] = [];
  const extraNodes: NodeFact[] = [];
  // Map of localName -> { className, methodName } for apex imports.
  const apexImports: Record<string, { className: string; methodName: string }> = {};

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
    return { extraEdges, extraNodes };
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

  return { extraEdges, extraNodes };
}

function lwcCtx(ctx: ParseContext): ParseContext {
  return ctx;
}
