import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import {
  type EdgeFact,
  METADATA_CATEGORY,
  type MetadataCategory,
  type NodeFact,
  type RelType,
} from "../../domain/index.js";
import { makeEdge, makeNode } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";
import type { EdgeRule, NodeRule, Rule } from "./_schema.js";
import { type EvalCtx, evaluatePredicate, evaluateRaw, evaluateString } from "./_selectors.js";

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function toArr<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

export class RuleBasedParser implements Parser<unknown> {
  constructor(private readonly rule: Rule) {}

  get type(): string {
    return this.rule.type;
  }

  get category(): MetadataCategory {
    // The rule files use the same string constants as METADATA_CATEGORY values.
    return this.rule.category as MetadataCategory;
  }

  async parse(input: unknown, ctx: ParseContext): Promise<ParseResult> {
    const record = this.coerceInput(input);
    const caps = (ctx as unknown as { caps?: Record<string, unknown> }).caps ?? {};
    const evalCtx: EvalCtx = {
      record,
      item: null,
      ns: ctx.namespace,
      caps,
    };

    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    // Source hash derived from input string when available (parity with old parsers).
    const sourceHashSeed = this.deriveSourceText(input);
    const hashBase = sourceHashSeed ? sha256(sourceHashSeed) : "";

    for (const n of this.rule.nodes) {
      this.emitNode(n, evalCtx, ctx, hashBase, nodes);
    }
    for (const e of this.rule.edges) {
      this.emitEdge(e, evalCtx, ctx, edges);
    }

    return { nodes, edges };
  }

  private emitNode(
    n: NodeRule,
    evalCtx: EvalCtx,
    ctx: ParseContext,
    hashBase: string,
    out: NodeFact[],
  ): void {
    const items: unknown[] = n.iterate ? toArr(evaluateRaw(n.iterate, evalCtx)) : [null];
    for (const item of items) {
      const subCtx: EvalCtx = { ...evalCtx, item };
      if (n.when && !evaluatePredicate(n.when, subCtx)) continue;
      const qnameVal = evaluateString(n.qname, subCtx);
      if (qnameVal === undefined || qnameVal === null || qnameVal === "") continue;
      const qname = String(qnameVal);
      const props = this.materializeProps(n.props, subCtx);
      out.push(makeNode(ctx, n.label, qname, props, hashBase));
    }
  }

  private emitEdge(e: EdgeRule, evalCtx: EvalCtx, ctx: ParseContext, out: EdgeFact[]): void {
    const items: unknown[] = e.iterate ? toArr(evaluateRaw(e.iterate, evalCtx)) : [null];
    for (const item of items) {
      const subCtx: EvalCtx = { ...evalCtx, item };
      if (e.when && !evaluatePredicate(e.when, subCtx)) continue;
      const src = evaluateString(e.src, subCtx);
      const dst = evaluateString(e.dst, subCtx);
      if (!src || !dst) continue;
      const props = this.materializeProps(e.props, subCtx);
      // relType is a string union at runtime; rule authors must use canonical names.
      out.push(makeEdge(ctx, String(src), e.relType as RelType, String(dst), props));
    }
  }

  private materializeProps(
    props: Record<string, unknown> | undefined,
    evalCtx: EvalCtx,
  ): Record<string, unknown> {
    if (!props) return {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      if (typeof v === "string") {
        const evaluated = evaluateString(v, evalCtx);
        out[k] = evaluated === undefined ? null : evaluated;
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  private coerceInput(input: unknown): unknown {
    if (this.rule.input === "object") return input;
    if (this.rule.input === "json") {
      return typeof input === "string" ? JSON.parse(input) : input;
    }
    if (this.rule.input === "xml-string") {
      // Inputs in this codebase pass `{ name, xml }` objects (or similar).
      // Parse the xml field and merge any sibling keys into the record so
      // they're addressable as ${record.<key>}.
      const obj = input as Record<string, unknown> | null;
      const xml = typeof obj?.xml === "string" ? (obj.xml as string) : "";
      let parsed: unknown = {};
      if (xml) parsed = xmlParser.parse(xml);
      const rootKey = this.rule.root;
      const root = rootKey ? ((parsed as Record<string, unknown>)?.[rootKey] ?? {}) : parsed;
      const merged: Record<string, unknown> = {
        ...(typeof root === "object" && root !== null ? (root as Record<string, unknown>) : {}),
      };
      // Promote sibling keys (name, object, body, etc.) into the record.
      if (obj && typeof obj === "object") {
        for (const [k, v] of Object.entries(obj)) {
          if (k === "xml") continue;
          merged[k] = v;
        }
      }
      return merged;
    }
    return input;
  }

  private deriveSourceText(input: unknown): string {
    if (typeof input === "string") return input;
    if (input && typeof input === "object") {
      const obj = input as Record<string, unknown>;
      if (typeof obj.xml === "string") return obj.xml;
      if (typeof obj.body === "string") return obj.body;
    }
    return "";
  }
}

export function appliesTo(rule: Rule, caps: Record<string, unknown>): boolean {
  return matchWhen(rule.applies_when, caps);
}

function matchWhen(w: unknown, caps: Record<string, unknown>): boolean {
  if (!w || typeof w !== "object") return false;
  const obj = w as Record<string, unknown>;
  if ("always" in obj) return true;
  if ("capability" in obj) return Boolean(caps[obj.capability as string]);
  if ("not" in obj) return !matchWhen(obj.not, caps);
  if ("any_of" in obj) return (obj.any_of as unknown[]).some((x) => matchWhen(x, caps));
  if ("all_of" in obj) return (obj.all_of as unknown[]).every((x) => matchWhen(x, caps));
  return false;
}

// Re-export METADATA_CATEGORY for rule author convenience (unused but stable).
export { METADATA_CATEGORY };
