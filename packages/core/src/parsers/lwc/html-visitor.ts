import { parse as parseHtml } from "parse5";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { REL_TYPES } from "../../domain/index.js";
import { makeEdge, stripNs } from "../common.js";
import type { ParseContext } from "../contract.js";
import type { LwcBindings } from "./js-visitor.js";

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

const BINDING_RE = /\{([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\}/g;

export function extractHtmlEdges(
  source: string,
  lwcQname: string,
  ctx: ParseContext,
  bindings?: LwcBindings,
): HtmlExtractResult {
  const extraEdges: EdgeFact[] = [];
  const extraNodes: NodeFact[] = [];
  const tree = parseHtml(source);
  const seenLwc = new Set<string>();
  const seenEvt = new Set<string>();
  const seenField = new Set<string>();
  const seenProperty = new Set<string>();

  // Directive attribute names — both the modern `lwc:*` family and the
  // legacy template:1 forms. Each maps to a label recorded on the emitted
  // edge's `attributes.directive` so consumers can distinguish "conditional"
  // bindings from regular property reads.
  //
  // `lwc:for:each` and legacy `for:each` carry an iterable expression; the
  // companion `for:item` / `lwc:for:item` attributes name an alias used by
  // child bindings (e.g. `{card.title}` where `card` aliases `items[i]`).
  // We record the iterable as a property bind with `directive: 'lwc:for:each'`
  // plus `forItem: '<alias>'` when the sibling attribute is present.
  // Alias-resolution of child bindings is intentionally out of scope here —
  // see W2 follow-ups.
  const CONDITIONAL_DIRECTIVES = new Map<string, string>([
    ["lwc:if", "lwc:if"],
    ["lwc:elseif", "lwc:elseif"],
    ["if:true", "if:true"],
    ["if:false", "if:false"],
  ]);
  const FOR_EACH_DIRECTIVES = new Set(["lwc:for:each", "for:each", "lwc:iterator:each"]);
  const FOR_ITEM_ATTRS = new Set(["lwc:for:item", "for:item", "iterator:item"]);

  const emitDirectiveBinding = (
    expr: string,
    directive: string,
    extra: Record<string, unknown>,
  ): void => {
    // Pull the head identifier out of `{user.isAdmin}` → `user.isAdmin` →
    // head = `user`. Mirrors emitBinding's split for consistency, but we
    // always emit as LWC_BINDS_PROPERTY because directive bindings are
    // imperative property reads (not field reads on a @wire'd sObject).
    const dst = `LWCProperty:${expr}`;
    if (seenProperty.has(dst)) return;
    seenProperty.add(dst);
    extraEdges.push(
      makeEdge(ctx, lwcQname, REL_TYPES.LWC_BINDS_PROPERTY, dst, {
        binding: expr,
        directive,
        ...extra,
      }),
    );
  };

  const emitBinding = (expr: string): void => {
    // `record.Name` → split into [record, Name]; `record.fields.Account.Name`
    // is unusual in templates and falls through to property.
    const parts = expr.split(".");
    const head = parts[0] ?? "";
    if (bindings && parts.length >= 2) {
      const sObject = bindings.wireToSObject.get(head);
      if (sObject) {
        // Extract the field name from the binding, handling both adapter shapes:
        //   `record.Name`             → tail = [Name]                → field = Name
        //   `record.fields.Name`      → tail = [fields, Name]        → field = Name
        //   `record.fields.Name.value` → tail = [fields, Name, value] → field = Name
        //     (v53+ getRecord returns FieldValueRepresentation; templates
        //      access `.value` on the field proxy.)
        // We deliberately *don't* concatenate intermediate segments — they're
        // either the `fields` accessor or the proxy `.value`/`.displayValue`,
        // neither of which are part of the CustomField qname.
        const tail = parts.slice(1);
        let field = "";
        if (tail[0] === "fields") {
          field = tail[1] ?? "";
        } else if (tail.length === 1) {
          field = tail[0] ?? "";
        }
        if (field) {
          const dst = `CustomField:${stripNs(sObject, ctx.namespace)}.${stripNs(field, ctx.namespace)}`;
          if (!seenField.has(dst)) {
            seenField.add(dst);
            extraEdges.push(
              makeEdge(ctx, lwcQname, REL_TYPES.LWC_BINDS_FIELD, dst, { binding: expr }),
            );
          }
          return;
        }
      }
    }
    const dst = `LWCProperty:${expr}`;
    if (!seenProperty.has(dst)) {
      seenProperty.add(dst);
      extraEdges.push(makeEdge(ctx, lwcQname, REL_TYPES.LWC_BINDS_PROPERTY, dst, { binding: expr }));
    }
  };

  const scanText = (text: string): void => {
    if (!text || text.indexOf("{") < 0) return;
    BINDING_RE.lastIndex = 0;
    let m: RegExpExecArray | null = BINDING_RE.exec(text);
    while (m !== null) {
      const expr = m[1];
      if (expr) emitBinding(expr);
      m = BINDING_RE.exec(text);
    }
  };

  walk(tree, (n: any) => {
    // Text nodes carry mustache bindings — `{record.Name}`, `{count}`, etc.
    if (n?.nodeName === "#text" && typeof n?.value === "string") {
      scanText(n.value);
    }
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
    // Two-pass attribute scan. First pass picks up directive attributes
    // (lwc:if / lwc:for:each / legacy if:true / for:each) so the binding
    // gets emitted with `attributes.directive` set. Second pass runs the
    // general onevent / value-binding logic and skips bindings the
    // directive pass already recorded.
    const attrs: Array<{ name: string; value: string }> = (n?.attrs ?? []).map(
      (a: { name?: string; value?: string }) => ({ name: a?.name ?? "", value: a?.value ?? "" }),
    );

    // Resolve for:item alias up front so the for:each directive can record it.
    let forItemAlias: string | undefined;
    for (const a of attrs) {
      if (FOR_ITEM_ATTRS.has(a.name)) {
        forItemAlias = a.value || undefined;
        break;
      }
    }

    for (const a of attrs) {
      const directive = CONDITIONAL_DIRECTIVES.get(a.name);
      if (directive) {
        // Conditional directive: `lwc:if={isShown}` / `if:true={state.ready}`
        // The value is a single bound expression wrapped in braces (or
        // sometimes bare for legacy if:true). Strip braces defensively.
        const raw = a.value.trim();
        const expr = raw.startsWith("{") && raw.endsWith("}") ? raw.slice(1, -1) : raw;
        if (expr) emitDirectiveBinding(expr, directive, {});
        continue;
      }
      if (FOR_EACH_DIRECTIVES.has(a.name)) {
        const raw = a.value.trim();
        const expr = raw.startsWith("{") && raw.endsWith("}") ? raw.slice(1, -1) : raw;
        if (expr) {
          const extra: Record<string, unknown> = {};
          if (forItemAlias) extra.forItem = forItemAlias;
          emitDirectiveBinding(expr, a.name, extra);
        }
        continue;
      }
    }

    // Attributes that look like onevent listeners + mustache bindings in
    // attribute values (e.g. `<lightning-input value={record.Name}>`).
    // Directive attributes already handled above are skipped via the
    // `seenProperty` set populated by emitDirectiveBinding.
    for (const a of attrs) {
      const name = a.name;
      if (CONDITIONAL_DIRECTIVES.has(name) || FOR_EACH_DIRECTIVES.has(name) || FOR_ITEM_ATTRS.has(name)) {
        continue;
      }
      if (name.startsWith("on") && name.length > 2) {
        const evtName = name.slice(2);
        if (!seenEvt.has(evtName)) {
          seenEvt.add(evtName);
          extraEdges.push(
            makeEdge(ctx, lwcQname, REL_TYPES.LISTENS_TO_EVENT, `LWCEvent:${evtName}`),
          );
        }
      }
      const val = a.value;
      if (typeof val === "string") scanText(val);
    }
  });

  return { extraEdges, extraNodes };
}
