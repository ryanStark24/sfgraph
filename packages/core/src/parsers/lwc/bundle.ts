import { createHash } from "node:crypto";
import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";
import { extractHtmlEdges } from "./html-visitor.js";
import { type LwcBindings, extractJsEdges } from "./js-visitor.js";
import { isOmnidefChunkFile, isOmnidefFile, omnidefEdges, readOmnidef } from "./omnidef.js";
import { extractMetaXml } from "./xml-meta.js";

export interface LwcBundleInput {
  bundleName: string;
  files: Record<string, string>;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Folded into the LWC / LWCBundle node hash. Bump it when the node attributes
 * change so a plain re-ingest re-merges unchanged bundles. v2: recordFieldKeys.
 * v3: recordObjects (static object context for the field-key resolver).
 */
export const LWC_NODE_HASH_SALT = "lwc-attrs:v3";

function bundleContentHash(files: Record<string, string>): string {
  const keys = Object.keys(files).sort();
  const h = createHash("sha256");
  h.update(LWC_NODE_HASH_SALT);
  h.update("\0");
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

    const lwcNode = makeNode(ctx, "LWC", lwcQname, { name: bundleName, ...meta }, hash);
    nodes.push(lwcNode);
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

    // Pass 1: walk the JS first so we know which template variables are
    // wired to which sObjects before walking the HTML.
    const mergedBindings: LwcBindings = {
      wireToSObject: new Map(),
      schemaFieldImports: new Map(),
      schemaObjectImports: new Map(),
    };
    const recordFieldKeys = new Set<string>();
    for (const [fname, source] of Object.entries(input.files)) {
      if (fname.endsWith(".js")) {
        // Compiled-OmniScript definition: classify its elements instead of
        // walking the (large, generated) literal as component code.
        if (isOmnidefChunkFile(fname)) continue;
        if (isOmnidefFile(fname)) {
          const def = readOmnidef(fname, input.files);
          if (def) {
            edges.push(...omnidefEdges(def, lwcQname, ctx));
            continue;
          }
        }
        const {
          extraEdges,
          extraNodes,
          bindings: b,
          recordFieldKeys: keys,
        } = extractJsEdges(source, lwcQname, ctx);
        edges.push(...extraEdges);
        nodes.push(...extraNodes);
        for (const k of keys) recordFieldKeys.add(k);
        for (const [k, v] of b.wireToSObject) mergedBindings.wireToSObject.set(k, v);
        for (const [k, v] of b.schemaFieldImports) mergedBindings.schemaFieldImports.set(k, v);
        for (const [k, v] of b.schemaObjectImports) mergedBindings.schemaObjectImports.set(k, v);
      }
    }
    if (recordFieldKeys.size > 0) {
      lwcNode.attributes.recordFieldKeys = [...recordFieldKeys].sort();
      // Static object context for resolving those keys: `@salesforce/schema`
      // field/object imports and js-meta `targetConfig` objects.
      const objects = new Set<string>(
        Array.isArray(meta.targetObjects) ? (meta.targetObjects as string[]) : [],
      );
      for (const ref of mergedBindings.schemaFieldImports.values()) objects.add(ref.sObject);
      for (const obj of mergedBindings.schemaObjectImports.values()) objects.add(obj);
      if (objects.size > 0) lwcNode.attributes.recordObjects = [...objects].sort();
    }
    // Pass 2: HTML, with the merged bindings available.
    for (const [fname, source] of Object.entries(input.files)) {
      if (fname.endsWith(".html")) {
        const { extraEdges, extraNodes } = extractHtmlEdges(source, lwcQname, ctx, mergedBindings);
        edges.push(...extraEdges);
        nodes.push(...extraNodes);
      }
    }
    void sha256;
    return { nodes, edges };
  }
}
