import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
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

export class FlowParser implements Parser<FlowInput> {
  readonly category = METADATA_CATEGORY.FLOW;
  readonly type = "Flow";

  async parse(input: FlowInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
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

    return { nodes, edges };
  }
}
