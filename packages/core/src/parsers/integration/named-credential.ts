import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { type EdgeFact, METADATA_CATEGORY, type NodeFact } from "../../domain/index.js";
import { makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";

export interface NamedCredentialInput {
  name: string;
  xml: string;
}

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export class NamedCredentialParser implements Parser<NamedCredentialInput> {
  readonly category = METADATA_CATEGORY.NAMED_CREDENTIAL;
  readonly type = "NamedCredential";

  async parse(input: NamedCredentialInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const name = stripNs(input.name, ctx.namespace);
    const parsed = xmlParser.parse(input.xml) as any;
    const nc = parsed?.NamedCredential ?? {};
    nodes.push(
      makeNode(
        ctx,
        "NamedCredential",
        `NamedCredential:${name}`,
        {
          name,
          endpoint: nc.endpoint ?? null,
          principalType: nc.principalType ?? null,
          protocol: nc.protocol ?? null,
        },
        sha256(input.xml),
      ),
    );
    return { nodes, edges };
  }
}
