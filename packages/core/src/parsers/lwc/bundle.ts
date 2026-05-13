import { createHash } from "node:crypto";
import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";
import { extractHtmlEdges } from "./html-visitor.js";
import { extractJsEdges } from "./js-visitor.js";
import { extractMetaXml } from "./xml-meta.js";

export interface LwcBundleInput {
  bundleName: string;
  files: Record<string, string>;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function bundleContentHash(files: Record<string, string>): string {
  const keys = Object.keys(files).sort();
  const h = createHash("sha256");
  for (const k of keys) {
    h.update(k);
    h.update("\0");
    h.update(files[k] ?? "");
    h.update("\0");
  }
  return h.digest("hex");
}

export class LwcBundleParser implements Parser<LwcBundleInput> {
  readonly category = METADATA_CATEGORY.LWC;
  readonly type = "LightningComponentBundle";

  async parse(input: LwcBundleInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const bundleName = stripNs(input.bundleName, ctx.namespace);
    const lwcQname = `LWC:${bundleName}`;
    const bundleQname = `LWCBundle:${bundleName}`;
    const hash = bundleContentHash(input.files);

    // Meta
    const metaKey = Object.keys(input.files).find((k) => k.endsWith(".js-meta.xml"));
    const meta = metaKey && input.files[metaKey] ? extractMetaXml(input.files[metaKey]) : {};

    nodes.push(makeNode(ctx, "LWC", lwcQname, { name: bundleName, ...meta }, hash));
    nodes.push(
      makeNode(
        ctx,
        "LWCBundle",
        bundleQname,
        { name: bundleName, files: Object.keys(input.files) },
        hash,
      ),
    );
    edges.push(makeEdge(ctx, bundleQname, REL_TYPES.CONTAINS_COMPONENT, lwcQname));

    // JS files
    for (const [fname, source] of Object.entries(input.files)) {
      if (fname.endsWith(".js")) {
        const { extraEdges, extraNodes } = extractJsEdges(source, lwcQname, ctx);
        edges.push(...extraEdges);
        nodes.push(...extraNodes);
      } else if (fname.endsWith(".html")) {
        const { extraEdges, extraNodes } = extractHtmlEdges(source, lwcQname, ctx);
        edges.push(...extraEdges);
        nodes.push(...extraNodes);
      }
    }
    void sha256;
    return { nodes, edges };
  }
}
