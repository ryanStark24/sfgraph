import { createHash } from "node:crypto";
import type { EdgeFact, NodeFact, RelType } from "../../domain/index.js";
import { REL_TYPES } from "../../domain/index.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext } from "../contract.js";

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function asJson(input: unknown): any {
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch {
      return {};
    }
  }
  return input ?? {};
}

/**
 * Walk an arbitrary object tree and invoke `visit` on every value (objects/arrays/scalars).
 */
export function walk(
  obj: any,
  visit: (v: any, key: string | number | null, parent: any) => void,
): void {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const v = obj[i];
      visit(v, i, obj);
      if (v && typeof v === "object") walk(v, visit);
    }
  } else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      visit(v, k, obj);
      if (v && typeof v === "object") walk(v, visit);
    }
  }
}

export interface FieldRef {
  object: string;
  field: string;
}

const FIELD_PATH_RE = /\b([A-Z][A-Za-z0-9_]*(?:__r)?)\.([A-Z][A-Za-z0-9_]*(?:__c)?)\b/g;

export function extractFieldRefs(text: string): FieldRef[] {
  const out: FieldRef[] = [];
  const seen = new Set<string>();
  const re = new RegExp(FIELD_PATH_RE.source, "g");
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    const o = (m[1] ?? "").replace(/__r$/, "");
    const f = m[2] ?? "";
    const k = `${o}.${f}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push({ object: o, field: f });
    }
    m = re.exec(text);
  }
  return out;
}

export interface BuildArgs {
  ctx: ParseContext;
  label: string;
  prefix: string; // "DR" | "IP" | "OS" | "VC" | "Omni..."
  name: string;
  raw: any;
  hash: string;
}

export function buildBaseNode(args: BuildArgs): NodeFact {
  return makeNode(
    args.ctx,
    args.label,
    `${args.label}:${stripNs(args.name, args.ctx.namespace)}`,
    {
      name: stripNs(args.name, args.ctx.namespace),
      flavor: args.prefix,
    },
    args.hash,
  );
}

export { REL_TYPES };
