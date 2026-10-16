import _parser from "@babel/parser";
import _traverse from "@babel/traverse";
import type { NodePath } from "@babel/traverse";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { REL_TYPES } from "../../domain/index.js";
import { makeEdge, makeNode, messageChannelQname, platformEventQname, stripNs } from "../common.js";
import type { ParseContext } from "../contract.js";

const parser = (_parser as any).default ?? _parser;
const traverse = (_traverse as any).default ?? _traverse;

export interface JsExtractResult {
  extraEdges: EdgeFact[];
  extraNodes: NodeFact[];
  /** Phase 5: bindings the HTML visitor needs to resolve `{var.field}`. */
  bindings: LwcBindings;
  /** Custom-field API names used as plain object-literal keys
   *  (`{ Site_Remarks__c: v }`, typically a record payload). They carry no
   *  object, so a post-ingest resolver binds the ones whose name is unique in
   *  the graph (see field-key-resolver.ts). */
  recordFieldKeys: Set<string>;
}

const APEX_IMPORT_RE = /^@salesforce\/apex\/([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/;
const SR_IMPORT_RE = /^@salesforce\/resourceUrl\/([A-Za-z_]\w*)$/;
const LABEL_IMPORT_RE = /^@salesforce\/label\/c\.([A-Za-z_]\w*)$/;
const SCHEMA_OBJ_RE = /^@salesforce\/schema\/([A-Za-z_][\w]*)$/;
const SCHEMA_FIELD_RE = /^@salesforce\/schema\/([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)$/;
/** `import x from 'c/otherCmp'`: a local LWC module (component or service). */
const LOCAL_LWC_IMPORT_RE = /^c\/([A-Za-z]\w*)$/;
/** `c:name` value of a `c__target` navigation state key. */
const C_TARGET_VALUE_RE = /^c:([A-Za-z]\w*)$/;
/** `…?c__target=c:name` inside a URL string. */
const C_TARGET_URL_RE = /c__target=c:([A-Za-z]\w*)/g;
const CUSTOM_FIELD_KEY_RE = /^[A-Za-z]\w*__c$/;
const MESSAGE_CHANNEL_IMPORT_RE = /^@salesforce\/messageChannel\/([A-Za-z]\w*)$/;
/** `Object.Field` (a relationship path like `Contact.Account.Name` is not one). */
const FIELD_PATH_RE = /^([A-Za-z]\w*)\.([A-Za-z]\w*)$/;
const API_NAME_RE = /^[A-Za-z]\w*$/;
/** Platform modules whose named imports are tracked by local name. */
const TRACKED_MODULES = ["lightning/uiRecordApi", "lightning/empApi", "lightning/messageService"];
const RECORD_ADAPTERS = new Set([
  "getRecord",
  "getRecords",
  "getRecordCreateDefaults",
  "getRecordUi",
  "getRelatedListRecords",
]);

/**
 * `CustomField:<obj>.<field>` for `'Object.Field'`, or for a bare `'Field'`
 * when the object is known; null for anything else (relationship paths,
 * `$reactive` strings, `Id`, which names the record rather than a field).
 */
export function stringFieldQname(
  text: string,
  defaultObject: string | undefined,
  namespace: string | null,
): string | null {
  const t = text.trim();
  const m = FIELD_PATH_RE.exec(t);
  const obj = m ? m[1] : API_NAME_RE.test(t) ? defaultObject : undefined;
  const field = m ? m[2] : t;
  if (!obj || !field || field.toLowerCase() === "id") return null;
  return `CustomField:${stripNs(obj, namespace)}.${stripNs(field, namespace)}`;
}

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
  /** Class property name → its statically known string value(s): a string or
   *  an array of strings, with schema imports resolved to `Object.Field` /
   *  `Object` (`fields = ['Name', NAME_FIELD]`, `objectApiName = ACCOUNT_OBJECT`).
   *  Lets the template resolve record-form `fields={fields}`. */
  propertyValues?: Map<string, string[]>;
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
    propertyValues: new Map(),
  };
  const recordFieldKeys = new Set<string>();
  const referenced = new Set<string>();
  // Local name → imported name, per tracked platform module.
  const moduleImports = new Map<string, Map<string, string>>(
    TRACKED_MODULES.map((m) => [m, new Map<string, string>()]),
  );
  const importedAs = (module: string, local: string) => moduleImports.get(module)?.get(local);
  // `import CH from '@salesforce/messageChannel/X__c'`: local name → channel qname.
  const messageChannels = new Map<string, string>();
  const addEdge = (rel: EdgeFact["relType"], dst: string, attrs: Record<string, unknown>) => {
    const key = dst.toLowerCase();
    if (
      extraEdges.some((e) => e.relType === rel && String(e.dstQualifiedName).toLowerCase() === key)
    ) {
      return;
    }
    extraEdges.push(makeEdge(ctx, lwcQname, rel, dst, attrs));
  };
  const fieldRef = (
    rel: EdgeFact["relType"],
    text: string,
    via: string,
    defaultObject?: string,
  ): string | null => {
    const dst = stringFieldQname(text, defaultObject, ctx.namespace);
    if (dst) addEdge(rel, dst, { via });
    return dst;
  };
  const refLwc = (name: string, via: string) => {
    const dst = `LWC:${stripNs(name, ctx.namespace)}`;
    if (dst === lwcQname || referenced.has(dst)) return;
    referenced.add(dst);
    extraEdges.push(makeEdge(ctx, lwcQname, REL_TYPES.REFERENCES, dst, { via }));
  };
  const scanUrlTargets = (text: string) => {
    if (!text.includes("c__target=")) return;
    for (const m of text.matchAll(C_TARGET_URL_RE)) refLwc(m[1] ?? "", "c__target");
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
    return { extraEdges, extraNodes, bindings, recordFieldKeys };
  }

  // Module-level `const` initialisers and class property initialisers, so
  // `fields: FIELDS` or `subscribe(this.channelName, …)` resolve to literals.
  const moduleConsts = new Map<string, any>();
  const classProps = new Map<string, any>();
  for (const stmt of ast.program?.body ?? []) {
    const decl =
      stmt.type === "ExportNamedDeclaration" || stmt.type === "ExportDefaultDeclaration"
        ? stmt.declaration
        : stmt;
    if (decl?.type === "VariableDeclaration" && decl.kind === "const") {
      for (const d of decl.declarations ?? []) {
        if (d.id?.type === "Identifier" && d.init) moduleConsts.set(String(d.id.name), d.init);
      }
    } else if (decl?.type === "ClassDeclaration" || decl?.type === "ClassExpression") {
      for (const member of decl.body?.body ?? []) {
        if (
          member.type === "ClassProperty" &&
          !member.computed &&
          !member.static &&
          member.key?.type === "Identifier" &&
          member.value
        ) {
          classProps.set(String(member.key.name), member.value);
        }
      }
    }
  }
  /** Initialiser of a never-reassigned variable `name`, seen from `path` (or the module). */
  const constInit = (name: string, path?: NodePath<any>): any => {
    const binding = path?.scope?.getBinding(name);
    if (binding) {
      return binding.constant && binding.path.node?.type === "VariableDeclarator"
        ? binding.path.node.init
        : undefined;
    }
    return moduleConsts.get(name);
  };
  /**
   * Statically known string values of an expression: literals, arrays of them,
   * schema imports (`Object.Field` / `Object`, also via `.fieldApiName` /
   * `.objectApiName`), consts and `this.<classProperty>`. Null when unknown.
   */
  const resolveStrings = (node: any, path?: NodePath<any>, depth = 0): string[] | null => {
    if (!node || depth > 4) return null;
    switch (node.type) {
      case "StringLiteral":
        return [String(node.value)];
      case "TemplateLiteral":
        return (node.expressions?.length ?? 0) === 0
          ? [String(node.quasis?.[0]?.value?.cooked ?? "")]
          : null;
      case "ArrayExpression": {
        const out: string[] = [];
        for (const el of node.elements ?? []) {
          const r = resolveStrings(
            el?.type === "SpreadElement" ? el.argument : el,
            path,
            depth + 1,
          );
          if (r) out.push(...r);
        }
        return out;
      }
      case "Identifier": {
        const name = String(node.name);
        const f = bindings.schemaFieldImports.get(name);
        if (f) return [`${f.sObject}.${f.field}`];
        const o = bindings.schemaObjectImports.get(name);
        if (o) return [o];
        return resolveStrings(constInit(name, path), path, depth + 1);
      }
      case "MemberExpression": {
        if (node.computed || node.property?.type !== "Identifier") return null;
        const prop = String(node.property.name);
        if (node.object?.type === "ThisExpression") {
          return resolveStrings(classProps.get(prop), undefined, depth + 1);
        }
        if (prop === "fieldApiName" || prop === "objectApiName") {
          return resolveStrings(node.object, path, depth + 1);
        }
        return null;
      }
      default:
        return null;
    }
  };
  /** An object literal, directly or through a const binding. */
  const resolveObject = (node: any, path: NodePath<any>): any => {
    if (node?.type === "ObjectExpression") return node;
    if (node?.type === "Identifier") {
      const init = constInit(String(node.name), path);
      return init?.type === "ObjectExpression" ? init : undefined;
    }
    return undefined;
  };
  const propValue = (obj: any, name: string): any =>
    obj?.properties?.find(
      (p: any) =>
        p.type === "ObjectProperty" &&
        !p.computed &&
        (p.key?.name === name || p.key?.value === name),
    )?.value;
  /**
   * `createRecord` / `updateRecord(recordInput)`: each key of
   * `recordInput.fields` (literal keys, `[FIELD.fieldApiName]` keys, and
   * `fields.X = …` / `fields[FIELD.fieldApiName] = …` assignments) is written.
   * A bare key needs the object (`apiName`); without it only keys naming
   * their object (schema imports) link.
   */
  const recordWrites = (via: string, arg: any, path: NodePath<any>): void => {
    const input = resolveObject(arg, path);
    if (!input) return;
    const apiName = resolveStrings(propValue(input, "apiName"), path)?.[0];
    const obj = apiName && API_NAME_RE.test(apiName) ? apiName : undefined;
    const fieldsNode = propValue(input, "fields");
    const fieldsObj = resolveObject(fieldsNode, path);
    const keys = (k: any, computed: boolean, at: NodePath<any>): string[] =>
      computed
        ? (resolveStrings(k, at) ?? [])
        : k?.type === "Identifier"
          ? [String(k.name)]
          : k?.type === "StringLiteral"
            ? [String(k.value)]
            : [];
    for (const p of fieldsObj?.properties ?? []) {
      if (p.type !== "ObjectProperty") continue;
      for (const k of keys(p.key, p.computed, path)) fieldRef(REL_TYPES.WRITES_FIELD, k, via, obj);
    }
    if (fieldsNode?.type === "Identifier") {
      const binding = path.scope.getBinding(String(fieldsNode.name));
      for (const ref of binding?.referencePaths ?? []) {
        const member = ref.parentPath;
        const assign = member?.parentPath;
        if (
          member?.node?.type === "MemberExpression" &&
          member.node.object === ref.node &&
          assign?.node?.type === "AssignmentExpression" &&
          assign.node.left === member.node
        ) {
          for (const k of keys(member.node.property, member.node.computed, ref)) {
            fieldRef(REL_TYPES.WRITES_FIELD, k, via, obj);
          }
        }
      }
    }
  };

  traverse(ast, {
    ImportDeclaration(path: NodePath<any>) {
      const src = String(path.node.source?.value ?? "");
      const tracked = moduleImports.get(src);
      if (tracked) {
        for (const s of path.node.specifiers ?? []) {
          if (s.type !== "ImportSpecifier") continue;
          tracked.set(String(s.local?.name), String(s.imported?.name ?? s.imported?.value));
        }
        return;
      }
      const channel = MESSAGE_CHANNEL_IMPORT_RE.exec(src);
      if (channel) {
        const localDefault = path.node.specifiers?.find(
          (s: any) => s.type === "ImportDefaultSpecifier",
        );
        const qname = messageChannelQname(channel[1] ?? "", ctx.namespace);
        if (localDefault?.local?.name && qname) {
          messageChannels.set(String(localDefault.local.name), qname);
        }
        return;
      }
      const local = LOCAL_LWC_IMPORT_RE.exec(src);
      if (local) {
        refLwc(local[1] ?? "", "import");
        return;
      }
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
          makeEdge(ctx, lwcQname, REL_TYPES.READS_FIELD, `CustomField:${sObject}.${field}`, {
            via: "schema-import",
          }),
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
          makeEdge(ctx, lwcQname, REL_TYPES.REFERENCES_OBJECT, `CustomObject:${sObject}`, {
            via: "schema-import",
          }),
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
          // `fields` / `optionalFields` anywhere in the config (getRecords nests
          // them in `records[]`): each `'Object.Field'` (or schema import) is read.
          const fieldLists = (node: any): void => {
            if (node?.type === "ArrayExpression") {
              for (const el of node.elements ?? []) fieldLists(el);
              return;
            }
            if (node?.type !== "ObjectExpression") return;
            for (const prop of node.properties ?? []) {
              if (prop.type !== "ObjectProperty" || prop.computed) continue;
              const keyName = prop.key?.name ?? prop.key?.value;
              if (keyName === "fields" || keyName === "optionalFields") {
                for (const text of resolveStrings(prop.value, path) ?? []) {
                  const dst = fieldRef(REL_TYPES.READS_FIELD, text, "wire");
                  sObject ??= dst ? dst.slice("CustomField:".length, dst.indexOf(".")) : null;
                }
              } else {
                fieldLists(prop.value);
              }
            }
          };
          fieldLists(optsArg);
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

    StringLiteral(path: NodePath<any>) {
      scanUrlTargets(String(path.node.value ?? ""));
    },

    TemplateElement(path: NodePath<any>) {
      scanUrlTargets(String(path.node.value?.cooked ?? path.node.value?.raw ?? ""));
    },

    ObjectExpression(path: NodePath<any>) {
      const props = path.node.properties ?? [];
      for (const p of props) {
        if (p.type !== "ObjectProperty" || p.computed) continue;
        const key =
          p.key?.type === "Identifier"
            ? String(p.key.name)
            : p.key?.type === "StringLiteral"
              ? String(p.key.value)
              : "";
        if (key === "c__target") {
          const v = p.value;
          const text =
            v?.type === "StringLiteral"
              ? String(v.value)
              : v?.type === "TemplateLiteral" && (v.expressions?.length ?? 0) === 0
                ? String(v.quasis?.[0]?.value?.cooked ?? "")
                : "";
          const t = C_TARGET_VALUE_RE.exec(text.trim());
          if (t) refLwc(t[1] ?? "", "c__target");
        } else if (CUSTOM_FIELD_KEY_RE.test(key)) {
          recordFieldKeys.add(stripNs(key, ctx.namespace));
        }
      }
      const get = (n: string) =>
        props.find(
          (p: any) => p.type === "ObjectProperty" && (p.key?.name === n || p.key?.value === n),
        )?.value;
      const cls = get("sClassName");
      const m = get("sMethodName");
      const clsText =
        cls?.type === "StringLiteral"
          ? String(cls.value)
          : cls?.type === "TemplateLiteral"
            ? String(cls.quasis?.[cls.quasis.length - 1]?.value?.cooked ?? "")
            : "";
      if (!clsText.endsWith("IntegrationProcedureService") || m?.type !== "StringLiteral") return;
      const dst = `IntegrationProcedure:${m.value}`;
      if (
        !extraEdges.some(
          (e) => e.relType === REL_TYPES.LWC_CALLS_IP && String(e.dstQualifiedName) === dst,
        )
      ) {
        extraEdges.push(makeEdge(ctx, lwcQname, REL_TYPES.LWC_CALLS_IP, dst));
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
      if (callee?.type === "Identifier") {
        const local = String(callee.name);
        const args = path.node.arguments ?? [];
        const recordApi = importedAs("lightning/uiRecordApi", local);
        if (recordApi === "getFieldValue" || recordApi === "getFieldDisplayValue") {
          for (const text of resolveStrings(args[1], path) ?? []) {
            fieldRef(REL_TYPES.READS_FIELD, text, "getFieldValue");
          }
        } else if (recordApi === "createRecord" || recordApi === "updateRecord") {
          recordWrites(recordApi, args[0], path);
        }
        if (importedAs("lightning/empApi", local) === "subscribe") {
          for (const channel of resolveStrings(args[0], path) ?? []) {
            const dst = platformEventQname(channel, ctx.namespace);
            if (dst) addEdge(REL_TYPES.SUBSCRIBES_TO_EVENT, dst, { via: "empApi", channel });
          }
        }
        const lms = importedAs("lightning/messageService", local);
        if (lms === "publish" || lms === "subscribe") {
          const ch = args[1];
          const ref =
            ch?.type === "MemberExpression" &&
            !ch.computed &&
            ch.object?.type === "ThisExpression" &&
            ch.property?.type === "Identifier"
              ? classProps.get(String(ch.property.name))
              : ch;
          const dst =
            ref?.type === "Identifier" ? messageChannels.get(String(ref.name)) : undefined;
          if (dst) {
            addEdge(
              lms === "publish" ? REL_TYPES.PUBLISHES_EVENT : REL_TYPES.SUBSCRIBES_TO_EVENT,
              dst,
              { via: "messageService" },
            );
          }
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

  for (const [name, init] of classProps) {
    const values = resolveStrings(init);
    if (values && values.length > 0) bindings.propertyValues?.set(name, values);
  }
  return { extraEdges, extraNodes, bindings, recordFieldKeys };
}

function lwcCtx(ctx: ParseContext): ParseContext {
  return ctx;
}
