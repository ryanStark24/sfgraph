import { createHash } from "node:crypto";
import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { XMLParser } from "fast-xml-parser";
import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import type { SnippetRecord } from "../../storage/interfaces.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";

export interface FlowInput {
  fullName: string;
  xml: string;
}

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function toArr<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

const IDENT_RE = /^[A-Za-z]\w*$/;
/** `var.Field` (one hop only; `$Record.Account.Name` is a relationship path
 *  whose target object is not known here, so it is skipped). */
const VAR_FIELD_RE = /(?<![\w$.])(\$Record(?:__Prior)?|[A-Za-z]\w*)\.([A-Za-z]\w*)(?![\w.])/g;
/** Keys whose text is a label/name, never a reference. */
const NON_REF_KEYS = new Set(["name", "label", "description", "interviewLabel", "fullName"]);
const LWC_EXTENSION_RE = /^c:([A-Za-z]\w*)$/;

/**
 * Field references in a Flow: element `field`s against the element's object,
 * and `var.Field` references resolved through `$Record` (start object), SObject
 * `<variables><objectType>`, Get Records element names and loop names.
 * An `assignToReference` `var.Field` is a write only when that record is
 * persisted: the variable is the `inputReference` of a Create/Update Records
 * element, or it is `$Record` in a before-save flow. Any other assignment
 * (in-memory copies, Get Records `outputAssignments`) and every other
 * reference is a read.
 */
function flowFieldRefs(
  flow: any,
  ns: string | null,
): Array<{ rel: "READS_FIELD" | "WRITES_FIELD"; obj: string; field: string; via: string }> {
  const out: Array<{
    rel: "READS_FIELD" | "WRITES_FIELD";
    obj: string;
    field: string;
    via: string;
  }> = [];
  const add = (rel: "READS_FIELD" | "WRITES_FIELD", obj: string, field: unknown, via: string) => {
    const f = typeof field === "string" ? field.trim() : "";
    if (obj && IDENT_RE.test(f)) out.push({ rel, obj, field: stripNs(f, ns), via });
  };
  const objOf = (x: unknown): string =>
    typeof x === "string" && IDENT_RE.test(x.trim()) ? stripNs(x.trim(), ns) : "";

  const vars = new Map<string, string>();
  const startObj = objOf(flow.start?.object);
  if (startObj) {
    vars.set("$Record", startObj);
    vars.set("$Record__Prior", startObj);
  }
  for (const v of toArr<any>(flow.variables)) {
    const o = objOf(v?.objectType);
    if (o && typeof v?.name === "string") vars.set(v.name, o);
  }
  for (const l of toArr<any>(flow.recordLookups)) {
    const o = objOf(l?.object);
    if (o && typeof l?.name === "string") vars.set(l.name, o);
  }
  for (const l of toArr<any>(flow.loops)) {
    const o = vars.get(String(l?.collectionReference ?? ""));
    if (o && typeof l?.name === "string") vars.set(l.name, o);
  }
  const typeOfRef = (r: unknown): string =>
    typeof r === "string" ? (vars.get(r.trim()) ?? "") : "";

  for (const f of toArr<any>(flow.start?.filters)) add("READS_FIELD", startObj, f?.field, "start");
  const elements: Array<[string, boolean, boolean]> = [
    // [key, writes inputAssignments, reads filters]
    ["recordLookups", false, true],
    ["recordUpdates", true, true],
    ["recordCreates", true, false],
    ["recordDeletes", false, true],
  ];
  for (const [key, writes, filters] of elements) {
    for (const el of toArr<any>(flow[key])) {
      const obj = objOf(el?.object) || typeOfRef(el?.inputReference);
      if (!obj) continue;
      if (filters) for (const f of toArr<any>(el.filters)) add("READS_FIELD", obj, f?.field, key);
      if (writes)
        for (const a of toArr<any>(el.inputAssignments)) add("WRITES_FIELD", obj, a?.field, key);
      if (key === "recordLookups") {
        for (const a of toArr<any>(el.outputAssignments)) add("READS_FIELD", obj, a?.field, key);
        for (const q of toArr<any>(el.queriedFields)) add("READS_FIELD", obj, q, key);
        add("READS_FIELD", obj, el.sortField, key);
      }
    }
  }

  // Record variables whose assigned fields are persisted.
  const saved = new Set<string>();
  for (const key of ["recordCreates", "recordUpdates"])
    for (const el of toArr<any>(flow[key]))
      if (typeof el?.inputReference === "string") saved.add(el.inputReference.trim());
  if (String(flow.start?.triggerType ?? "") === "RecordBeforeSave") saved.add("$Record");

  const scan = (text: string, assignTarget: boolean) => {
    if (!text.includes(".")) return;
    for (const m of text.matchAll(VAR_FIELD_RE)) {
      const name = m[1] ?? "";
      const obj = vars.get(name);
      if (obj)
        add(
          assignTarget && saved.has(name) ? "WRITES_FIELD" : "READS_FIELD",
          obj,
          m[2],
          "reference",
        );
    }
  };
  const visit = (v: unknown, key: string, parent: string): void => {
    if (typeof v === "string") {
      if (!NON_REF_KEYS.has(key))
        scan(v, key === "assignToReference" && parent !== "outputAssignments");
      return;
    }
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x, key, parent);
      return;
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) visit(x, k, key);
  };
  visit(flow, "", "");
  return out;
}

/** Screen-component LWCs: `<extensionName>c:name</extensionName>` anywhere. */
function flowScreenLwcs(flow: any): string[] {
  const out = new Set<string>();
  const visit = (v: unknown): void => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    const o = v as Record<string, unknown>;
    const ext =
      typeof o.extensionName === "string" ? LWC_EXTENSION_RE.exec(o.extensionName.trim()) : null;
    if (ext?.[1]) out.add(ext[1]);
    for (const x of Object.values(o)) visit(x);
  };
  visit(flow.screens);
  return [...out];
}

export class FlowParser implements Parser<FlowInput> {
  readonly category = METADATA_CATEGORY.FLOW;
  readonly type = "Flow";

  async parse(input: FlowInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const snippets: SnippetRecord[] = [];
    const fullName = stripNs(input.fullName, ctx.namespace);
    const hash = sha256(input.xml);

    let parsed: any;
    try {
      parsed = xmlParser.parse(input.xml);
    } catch (err) {
      nodes.push(
        makeNode(ctx, "ParseError", `ParseError:Flow:${fullName}`, {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      return { nodes, edges };
    }

    const flow = parsed?.Flow ?? {};
    const apiVersion = String(flow.apiVersion ?? "");
    const status = flow.status ?? null;
    const flowQname = `Flow:${fullName}`;
    const versionQname = `FlowVersion:${fullName}.v${apiVersion || "0"}`;

    nodes.push(
      makeNode(
        ctx,
        "Flow",
        flowQname,
        {
          name: fullName,
          processType: flow.processType ?? null,
          status,
        },
        hash,
      ),
    );
    nodes.push(
      makeNode(
        ctx,
        "FlowVersion",
        versionQname,
        {
          name: fullName,
          apiVersion: apiVersion || null,
          status,
        },
        hash,
      ),
    );
    edges.push(makeEdge(ctx, flowQname, REL_TYPES.CONTAINS, versionQname));

    // Store the Flow definition XML so explain_code / find_similar can read and
    // reason about the Flow's logic — Flows previously stored NO source, leaving
    // them as opaque nodes that explain/search couldn't open. Keyed by the Flow
    // qname (the unit a user explains), formatted as "flow".
    if (input.xml.trim() !== "") {
      snippets.push({
        orgId: asOrgId(ctx.orgId),
        qualifiedName: asQualifiedName(flowQname),
        sourceFormat: "flow",
        sourceText: input.xml,
        sourceHash: asSha256(hash),
        startLine: 1,
        endLine: input.xml.split("\n").length,
      });
    }

    // start element references an object (record-triggered flows)
    const start = flow.start;
    if (start?.object) {
      const obj = stripNs(String(start.object), ctx.namespace);
      edges.push(
        makeEdge(ctx, versionQname, REL_TYPES.TRIGGER_FIRES_ON, `CustomObject:${obj}`, {
          triggerType: start.triggerType ?? null,
          recordTriggerType: start.recordTriggerType ?? null,
        }),
      );
    } else if (String(flow.processType ?? "") === "Workflow") {
      // Process Builder: no <start><object>; the process's own (top-level)
      // processMetadataValues name the object and the trigger kind.
      const pmv = (name: string): string | null => {
        const hit = toArr<any>(flow.processMetadataValues).find(
          (p) => String(p?.name ?? "") === name,
        );
        const v = hit?.value?.stringValue;
        return typeof v === "string" && v.trim() ? v.trim() : null;
      };
      const objType = pmv("ObjectType");
      if (objType) {
        const obj = stripNs(objType, ctx.namespace);
        edges.push(
          makeEdge(ctx, versionQname, REL_TYPES.TRIGGER_FIRES_ON, `CustomObject:${obj}`, {
            triggerType: null,
            recordTriggerType: null,
            processTriggerType: pmv("TriggerType"),
          }),
        );
      }
    }

    // actionCalls -> apex / actions
    for (const ac of toArr<any>(flow.actionCalls)) {
      const actionType = String(ac.actionType ?? "");
      const actionName = stripNs(String(ac.actionName ?? ""), ctx.namespace);
      if (actionType === "apex") {
        edges.push(
          makeEdge(ctx, versionQname, REL_TYPES.FLOW_INVOKES_APEX, `ApexClass:${actionName}`, {
            actionName,
          }),
        );
      } else if (actionType === "flow" && actionName) {
        // An actionCall of type `flow` is a subflow call by another name.
        edges.push(
          makeEdge(ctx, versionQname, REL_TYPES.FLOW_INVOKES_SUBFLOW, `Flow:${actionName}`, {
            flowName: actionName,
            via: "actionCall",
          }),
        );
      } else if (actionType === "emailAlert" && actionName) {
        // `<Object>.<AlertName>`: the workflow email alert (WorkflowAlert node
        // emitted by the Workflow rule parser).
        edges.push(
          makeEdge(
            ctx,
            versionQname,
            REL_TYPES.FLOW_INVOKES_ACTION,
            `WorkflowAlert:${actionName}`,
            { actionType },
          ),
        );
      } else {
        edges.push(
          makeEdge(
            ctx,
            versionQname,
            REL_TYPES.FLOW_INVOKES_ACTION,
            `FlowAction:${actionType}:${actionName}`,
            {
              actionType,
            },
          ),
        );
      }
    }

    // subflows
    for (const sf of toArr<any>(flow.subflows)) {
      const target = stripNs(String(sf.flowName ?? ""), ctx.namespace);
      edges.push(
        makeEdge(ctx, versionQname, REL_TYPES.FLOW_INVOKES_SUBFLOW, `Flow:${target}`, {
          flowName: target,
        }),
      );
    }

    // recordCreates / recordUpdates / recordDeletes / recordLookups -> REFERENCES_OBJECT
    const recordElements: Array<{ key: string; arr: any[] }> = [
      { key: "recordCreates", arr: toArr<any>(flow.recordCreates) },
      { key: "recordUpdates", arr: toArr<any>(flow.recordUpdates) },
      { key: "recordDeletes", arr: toArr<any>(flow.recordDeletes) },
      { key: "recordLookups", arr: toArr<any>(flow.recordLookups) },
    ];
    const seenObjs = new Set<string>();
    for (const { key, arr } of recordElements) {
      for (const r of arr) {
        const obj = stripNs(String(r.object ?? ""), ctx.namespace);
        if (obj && !seenObjs.has(`${key}:${obj}`)) {
          seenObjs.add(`${key}:${obj}`);
          edges.push(
            makeEdge(ctx, versionQname, REL_TYPES.REFERENCES_OBJECT, `CustomObject:${obj}`, {
              kind: key,
            }),
          );
        }
      }
    }

    // Field references and screen LWCs hang off the Flow (not the
    // FlowVersion) so field/impact answers name the Flow itself.
    const seenField = new Set<string>();
    for (const ref of flowFieldRefs(flow, ctx.namespace)) {
      const dst = `CustomField:${ref.obj}.${ref.field}`;
      const k = `${ref.rel}|${dst}`;
      if (seenField.has(k)) continue;
      seenField.add(k);
      edges.push(makeEdge(ctx, flowQname, REL_TYPES[ref.rel], dst, { via: ref.via }));
    }
    for (const lwc of flowScreenLwcs(flow)) {
      edges.push(
        makeEdge(ctx, flowQname, REL_TYPES.EMBEDS_LWC, `LWC:${stripNs(lwc, ctx.namespace)}`, {
          via: "screen-extension",
        }),
      );
    }

    return { nodes, edges, snippets };
  }
}
