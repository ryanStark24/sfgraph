import { createHash } from "node:crypto";
import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";
import { stripCommentsAndStrings } from "./common.js";

export interface ApexTriggerInput {
  triggerName: string;
  body: string;
  metaXml?: string;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export class ApexTriggerParser implements Parser<ApexTriggerInput> {
  readonly category = METADATA_CATEGORY.APEX_TRIGGER;
  readonly type = "ApexTrigger";

  async parse(input: ApexTriggerInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const name = stripNs(input.triggerName, ctx.namespace);
    const cleaned = stripCommentsAndStrings(input.body);
    const triggerQname = `ApexTrigger:${name}`;

    // Parse header: trigger <Name> on <Object>(after insert, before update, ...) {
    const m = cleaned.match(/trigger\s+([A-Za-z_]\w*)\s+on\s+([A-Za-z_][\w.]*)\s*\(([^)]*)\)/i);
    if (!m) {
      nodes.push(
        makeNode(
          ctx,
          "ParseError",
          `ParseError:ApexTrigger:${name}`,
          { message: "could not parse trigger header" },
          sha256(input.body),
        ),
      );
      return { nodes, edges };
    }
    const triggerName = m[1] ?? name;
    const object = stripNs(m[2] ?? "", ctx.namespace);
    const events = (m[3] ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);

    const apiVersionMatch = input.metaXml?.match(/<apiVersion>([^<]+)<\/apiVersion>/);
    const apiVersion = apiVersionMatch?.[1] ? apiVersionMatch[1].trim() : null;

    nodes.push(
      makeNode(
        ctx,
        "ApexTrigger",
        triggerQname,
        { name: triggerName, object, events, apiVersion },
        sha256(input.body),
      ),
    );
    edges.push(
      makeEdge(ctx, triggerQname, REL_TYPES.TRIGGERS_ON, `CustomObject:${object}`, { events }),
    );

    return { nodes, edges };
  }
}
