import { parse as parseHtml } from "parse5";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { REL_TYPES } from "../../domain/index.js";
import { makeEdge } from "../common.js";
import type { ParseContext } from "../contract.js";

export interface HtmlExtractResult {
  extraEdges: EdgeFact[];
  extraNodes: NodeFact[];
}

function walk(node: any, visit: (n: any) => void): void {
  visit(node);
  // <template> elements wrap their children in a `content` DocumentFragment per HTML spec.
  const tplContent = node?.content?.childNodes ?? [];
  for (const c of tplContent) walk(c, visit);
  const kids = node?.childNodes ?? [];
  for (const c of kids) walk(c, visit);
}

export function extractHtmlEdges(
  source: string,
  lwcQname: string,
  ctx: ParseContext,
): HtmlExtractResult {
  const extraEdges: EdgeFact[] = [];
  const extraNodes: NodeFact[] = [];
  const tree = parseHtml(source);
  const seenLwc = new Set<string>();
  const seenEvt = new Set<string>();

  walk(tree, (n: any) => {
    const tag: string | undefined = n?.tagName;
    if (!tag) return;
    // LWC custom elements use hyphenated names with a namespace, e.g. c-account-detail
    const m = tag.match(/^([a-z]+)-([a-z][a-z0-9-]*)$/);
    if (m) {
      const ns = m[1];
      const rest = m[2] ?? "";
      // Convert kebab to camelCase for bundle ref
      const bundleName = rest.replace(/-([a-z0-9])/g, (_x, l) => String(l).toUpperCase());
      if (ns === "c" || ns === "lightning") {
        const dst = `LWC:${bundleName}`;
        if (!seenLwc.has(dst)) {
          seenLwc.add(dst);
          extraEdges.push(makeEdge(ctx, lwcQname, REL_TYPES.EMBEDS_LWC, dst, { tag }));
        }
      } else {
        const dst = `AuraComponent:${ns}:${rest}`;
        extraEdges.push(makeEdge(ctx, lwcQname, REL_TYPES.EMBEDS_AURA, dst, { tag }));
      }
    }
    // Attributes that look like onevent listeners
    for (const a of n?.attrs ?? []) {
      const name: string = a?.name ?? "";
      if (name.startsWith("on") && name.length > 2) {
        const evtName = name.slice(2);
        if (!seenEvt.has(evtName)) {
          seenEvt.add(evtName);
          extraEdges.push(
            makeEdge(ctx, lwcQname, REL_TYPES.LISTENS_TO_EVENT, `LWCEvent:${evtName}`),
          );
        }
      }
    }
  });

  return { extraEdges, extraNodes };
}
