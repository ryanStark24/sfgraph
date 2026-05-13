import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { type EdgeFact, METADATA_CATEGORY, type NodeFact } from "../../domain/index.js";
import { makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";

export interface PlatformEventInput {
  apiName: string;
  xml: string;
}

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export class PlatformEventParser implements Parser<PlatformEventInput> {
  readonly category = METADATA_CATEGORY.PLATFORM_EVENT;
  readonly type = "PlatformEvent";

  async parse(input: PlatformEventInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const apiName = stripNs(input.apiName, ctx.namespace);
    const parsed = xmlParser.parse(input.xml) as any;
    const co = parsed?.CustomObject ?? {};
    nodes.push(
      makeNode(
        ctx,
        "PlatformEvent",
        `PlatformEvent:${apiName}`,
        {
          apiName,
          label: co.label ?? null,
          eventType: co.eventType ?? null,
          publishBehavior: co.publishBehavior ?? null,
        },
        sha256(input.xml),
      ),
    );
    return { nodes, edges };
  }
}
