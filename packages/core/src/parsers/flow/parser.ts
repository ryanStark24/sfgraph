import { createHash } from "node:crypto";
import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { XMLParser } from "fast-xml-parser";
import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import type { SnippetRecord } from "../../storage/interfaces.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";
import { FLOW_NODE_HASH_SALT } from "../hash-salts.js";

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
/** `var.Field`, or a relationship path `var.Rel.….Field` (`$Record.Account.Name`). */
const VAR_PATH_RE = /(?<![\w$.])(\$Record(?:__Prior)?|[A-Za-z]\w*)((?:\.[A-Za-z]\w*)+)(?![\w.])/g;
/** Keys whose text is a label/name, never a reference. */
const NON_REF_KEYS = new Set(["name", "label", "description", "interviewLabel", "fullName"]);
const LWC_EXTENSION_RE = /^c:([A-Za-z]\w*)$/;
/** Assignment operators that put a record into a collection. */
const ADD_OPS = new Set(["Add", "AddAtStart"]);

type FieldRel = "READS_FIELD" | "WRITES_FIELD";

/** A `Rel.….Field` path from a record of `object`, left for the graph resolver
 *  (`relationship-resolver.ts`), which knows each lookup's target object. */
export interface FlowRelationshipPath {
  object: string;
  path: string;
  rel: FieldRel;
}

/**
 * Field references in a Flow: element `field`s against the element's object,
 * and `var.Field` references resolved through `$Record` (start object), SObject
 * `<variables><objectType>`, Get Records element names / `outputReference`s,
 * and loops (name or `assignNextValueToReference`) over a typed collection.
 * An `assignToReference` `var.Field` is a write only when that record is
 * persisted: the variable is the `inputReference` of a Create/Update Records
 * element, it is added (Add / AddAtStart) to a collection that is, or it is
 * `$Record` in a before-save flow. Any other assignment (in-memory copies, Get
 * Records `outputAssignments`) and every other reference is a read.
 *
 * Multi-hop references (`$Record.Account.Region__c`) and a trailing custom
 * relationship (`rec.Site__r`) are returned as `paths` for the graph resolver.
 * An `inputReference` names a record (or a related one), never a field; a
 * related one (`$Record.Account`) makes its element's fields paths through it.
 */
function flowFieldRefs(
  flow: any,
  ns: string | null,
): {
  refs: Array<{ rel: FieldRel; obj: string; field: string; via: string }>;
  paths: FlowRelationshipPath[];
} {
  const out: Array<{ rel: FieldRel; obj: string; field: string; via: string }> = [];
  const paths: FlowRelationshipPath[] = [];
  const seenPaths = new Set<string>();
  const add = (rel: FieldRel, obj: string, field: unknown, via: string) => {
    const f = typeof field === "string" ? field.trim() : "";
    if (obj && IDENT_RE.test(f)) out.push({ rel, obj, field: stripNs(f, ns), via });
  };
  const addPath = (rel: FieldRel, obj: string, segs: string[]) => {
    if (!obj || segs.length === 0 || !segs.every((s) => IDENT_RE.test(s))) return;
    const path = segs.map((s) => stripNs(s, ns)).join(".");
    const k = `${rel}|${obj}|${path}`;
    if (seenPaths.has(k)) return;
    seenPaths.add(k);
    paths.push({ object: obj, path, rel });
  };
  const str = (x: unknown): string => (typeof x === "string" ? x.trim() : "");
  const objOf = (x: unknown): string => (IDENT_RE.test(str(x)) ? stripNs(str(x), ns) : "");

  const vars = new Map<string, string>();
  const setType = (name: string, obj: string): boolean => {
    if (!name || !obj || vars.has(name)) return false;
    vars.set(name, obj);
    return true;
  };
  const startObj = objOf(flow.start?.object);
  if (startObj) {
    vars.set("$Record", startObj);
    vars.set("$Record__Prior", startObj);
  }
  for (const v of toArr<any>(flow.variables)) setType(str(v?.name), objOf(v?.objectType));
  for (const l of toArr<any>(flow.recordLookups)) {
    const o = objOf(l?.object);
    setType(str(l?.name), o);
    setType(str(l?.outputReference), o);
  }
  // Records added to collections (collection -> members), Add / AddAtStart only.
  const members = new Map<string, Set<string>>();
  for (const a of toArr<any>(flow.assignments)) {
    for (const it of toArr<any>(a?.assignmentItems)) {
      const coll = str(it?.assignToReference);
      const member = str(it?.value?.elementReference);
      if (!ADD_OPS.has(str(it?.operator)) || !IDENT_RE.test(coll) || !IDENT_RE.test(member))
        continue;
      const set = members.get(coll) ?? new Set<string>();
      set.add(member);
      members.set(coll, set);
    }
  }
  // A loop's item takes its collection's type; a collection and the records
  // added to it share one. Repeated until stable (loops over built lists).
  for (let changed = true; changed; ) {
    changed = false;
    for (const l of toArr<any>(flow.loops)) {
      const o = vars.get(str(l?.collectionReference)) ?? "";
      if (setType(str(l?.name), o)) changed = true;
      if (setType(str(l?.assignNextValueToReference), o)) changed = true;
    }
    for (const [coll, set] of members) {
      for (const m of set) {
        if (setType(m, vars.get(coll) ?? "")) changed = true;
        if (setType(coll, vars.get(m) ?? "")) changed = true;
      }
    }
  }
  const typeOfRef = (r: unknown): string => vars.get(str(r)) ?? "";

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
      if (!obj) {
        // A related record (`$Record.Account`): its fields are paths through it.
        const [base = "", ...rels] = str(el?.inputReference).split(".");
        const from = vars.get(base) ?? "";
        if (!from || rels.length === 0) continue;
        const viaRel = (rel: FieldRel, f: unknown) => addPath(rel, from, [...rels, str(f)]);
        if (filters) for (const f of toArr<any>(el.filters)) viaRel("READS_FIELD", f?.field);
        if (writes)
          for (const a of toArr<any>(el.inputAssignments)) viaRel("WRITES_FIELD", a?.field);
        continue;
      }
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

  // Records whose assigned fields are persisted, and every record added to a
  // persisted collection.
  const saved = new Set<string>();
  for (const key of ["recordCreates", "recordUpdates"]) {
    for (const el of toArr<any>(flow[key])) {
      const ref = str(el?.inputReference);
      if (ref) saved.add(ref);
    }
  }
  if (String(flow.start?.triggerType ?? "") === "RecordBeforeSave") saved.add("$Record");
  for (let changed = true; changed; ) {
    changed = false;
    for (const [coll, set] of members) {
      if (!saved.has(coll)) continue;
      for (const m of set) {
        if (saved.has(m)) continue;
        saved.add(m);
        changed = true;
      }
    }
  }

  const scan = (text: string, assignTarget: boolean) => {
    if (!text.includes(".")) return;
    for (const m of text.matchAll(VAR_PATH_RE)) {
      const name = m[1] ?? "";
      const obj = vars.get(name);
      if (!obj) continue;
      const segs = (m[2] ?? "").slice(1).split(".");
      const record = [name, ...segs.slice(0, -1)].join(".");
      const rel: FieldRel = assignTarget && saved.has(record) ? "WRITES_FIELD" : "READS_FIELD";
      // One hop is a field, unless it is a custom relationship (`Site__r`).
      if (segs.length === 1 && !/__r$/i.test(segs[0] ?? "")) add(rel, obj, segs[0], "reference");
      else addPath(rel, obj, segs);
    }
  };
  const visit = (v: unknown, key: string, parent: string): void => {
    if (typeof v === "string") {
      // `inputReference` names a record (or a related one), never a field.
      if (!NON_REF_KEYS.has(key) && key !== "inputReference")
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
  return { refs: out, paths };
}

/**
 * Platform events: a Create Records on a `__e` object (named by `<object>` or
 * by the SObject type of its `inputReference` variable) publishes the event;
 * a platform-event-triggered flow (`<triggerType>PlatformEvent`) subscribes to
 * its start object.
 */
function flowPlatformEvents(
  flow: any,
  ns: string | null,
): Array<{ rel: "PUBLISHES_EVENT" | "SUBSCRIBES_TO_EVENT"; event: string; via: string }> {
  const out: Array<{
    rel: "PUBLISHES_EVENT" | "SUBSCRIBES_TO_EVENT";
    event: string;
    via: string;
  }> = [];
  const name = (x: unknown): string =>
    typeof x === "string" && IDENT_RE.test(x.trim()) ? stripNs(x.trim(), ns) : "";
  const start = flow.start;
  const startObj = name(start?.object);
  if (startObj && String(start?.triggerType ?? "") === "PlatformEvent")
    out.push({ rel: "SUBSCRIBES_TO_EVENT", event: startObj, via: "start" });
  const varTypes = new Map<string, string>();
  for (const v of toArr<any>(flow.variables)) {
    const n = name(v?.name);
    const o = name(v?.objectType);
    if (n && o) varTypes.set(n, o);
  }
  const seen = new Set<string>();
  for (const c of toArr<any>(flow.recordCreates)) {
    const obj = name(c?.object) || varTypes.get(name(c?.inputReference)) || "";
    if (!obj.endsWith("__e") || seen.has(obj)) continue;
    seen.add(obj);
    out.push({ rel: "PUBLISHES_EVENT", event: obj, via: "recordCreates" });
  }
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
    const fieldRefs = flowFieldRefs(flow, ctx.namespace);
    // Salted (hash-salts.ts): node attributes can change for unchanged XML.
    const nodeHash = sha256(`${FLOW_NODE_HASH_SALT}\n${input.xml}`);

    nodes.push(
      makeNode(
        ctx,
        "Flow",
        flowQname,
        {
          name: fullName,
          processType: flow.processType ?? null,
          status,
          ...(fieldRefs.paths.length > 0 ? { flowRelationshipPaths: fieldRefs.paths } : {}),
        },
        nodeHash,
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
    for (const ref of fieldRefs.refs) {
      const dst = `CustomField:${ref.obj}.${ref.field}`;
      const k = `${ref.rel}|${dst}`;
      if (seenField.has(k)) continue;
      seenField.add(k);
      edges.push(makeEdge(ctx, flowQname, REL_TYPES[ref.rel], dst, { via: ref.via }));
    }
    for (const ev of flowPlatformEvents(flow, ctx.namespace)) {
      edges.push(
        makeEdge(ctx, flowQname, REL_TYPES[ev.rel], `PlatformEvent:${ev.event}`, { via: ev.via }),
      );
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
