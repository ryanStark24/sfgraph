import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";

export interface ExternalServiceInput {
  name: string;
  xml: string;
}

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export class ExternalServiceRegistrationParser implements Parser<ExternalServiceInput> {
  readonly category = METADATA_CATEGORY.EXTERNAL_SERVICE_REGISTRATION;
  readonly type = "ExternalServiceRegistration";

  async parse(input: ExternalServiceInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const name = stripNs(input.name, ctx.namespace);
    const parsed = xmlParser.parse(input.xml) as any;
    const esr = parsed?.ExternalServiceRegistration ?? {};
    const qname = `ExternalServiceRegistration:${name}`;
    nodes.push(
      makeNode(
        ctx,
        "ExternalServiceRegistration",
        qname,
        {
          name,
          status: esr.status ?? null,
          schemaType: esr.schemaType ?? null,
        },
        sha256(input.xml),
      ),
    );
    const ncName = esr.namedCredential ?? esr.namedCredentialReference ?? null;
    if (ncName) {
      const nc = stripNs(String(ncName), ctx.namespace);
      edges.push(
        makeEdge(ctx, qname, REL_TYPES.ESR_USES_NAMED_CREDENTIAL, `NamedCredential:${nc}`),
      );
    }
    return { nodes, edges };
  }
}
