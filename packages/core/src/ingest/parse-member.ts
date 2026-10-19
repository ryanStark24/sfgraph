/**
 * Member → parser dispatch, shared by the in-process (serial) ingest path and
 * the parse worker (`parse-worker.ts`), so both run exactly the same code.
 * Kept free of extractor / storage imports so a worker loads only the parser
 * registry.
 */
import type { Logger } from "@ryanstark24/sfgraph-shared";
import { METADATA_CATEGORY } from "../domain/metadata-category.js";
import type { MemberRef } from "../extractors/interfaces/metadata-source.js";
import type { ParseContext, ParseResult } from "../parsers/contract.js";
import type { ObjectDirInput } from "../parsers/object/object.js";
import { parserRegistry } from "../parsers/registry.js";
import { ensureRulesLoaded } from "../parsers/rules/_loader.js";
// Ensure all code parsers are registered before we look them up.
import "../parsers/index.js";

/** Live-org Apex extractor wraps body in a `{body, metaXml}` JSON envelope
 *  so we can forward Tooling-row ApiVersion/Status to the parser. Filesystem
 *  extractor still passes raw body. Detect by trying JSON.parse — if it
 *  yields an object with `body`, unwrap; otherwise treat as raw body. */
function unwrapApexEnvelope(content: string): { body: string; metaXml?: string } {
  if (!content) return { body: "" };
  if (content[0] !== "{") return { body: content };
  try {
    const parsed = JSON.parse(content) as { body?: unknown; metaXml?: unknown };
    if (parsed && typeof parsed === "object" && typeof parsed.body === "string") {
      const out: { body: string; metaXml?: string } = { body: parsed.body };
      if (typeof parsed.metaXml === "string") out.metaXml = parsed.metaXml;
      return out;
    }
  } catch {
    /* fallthrough — raw body */
  }
  return { body: content };
}

/** Maps the Vlocity runner's emitted memberType (the bare VlocityDataPackType)
 *  to the parser-registry key the four rich Vlocity parsers register under.
 *  Only these four DataPack types have dedicated parsers; the other ~44 fall
 *  through to the opaque node parser (node-only, by design). */
const VLOCITY_MEMBER_TO_PARSER: Record<string, string> = {
  DataRaptor: "VlocityDataRaptor",
  VlocityDataRaptor: "VlocityDataRaptor",
  IntegrationProcedure: "VlocityIntegrationProcedure",
  VlocityIntegrationProcedure: "VlocityIntegrationProcedure",
  OmniScript: "VlocityOmniScript",
  VlocityOmniScript: "VlocityOmniScript",
  VlocityCard: "VlocityCard",
};

/** Filesystem Aura bundle content (`{bundleName, files}` JSON), or null. */
function parseAuraBundleJson(
  content: string,
): { bundleName?: string; files: Record<string, string> } | null {
  let v: unknown;
  try {
    v = JSON.parse(content || "null");
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as { bundleName?: unknown; files?: unknown };
  if (!o.files || typeof o.files !== "object" || Array.isArray(o.files)) return null;
  // review minor 9: a non-string file body is not the filesystem bundle shape.
  if (Object.values(o.files).some((f) => typeof f !== "string")) return null;
  return {
    ...(typeof o.bundleName === "string" ? { bundleName: o.bundleName } : {}),
    files: o.files as Record<string, string>,
  };
}

/** Exported for tests — maps a RawMember to the registered parser's input shape. */
export function adaptParserInput(
  ref: MemberRef,
  content: string,
): { type: string; input: unknown } | null {
  switch (ref.memberType) {
    case "ApexClass": {
      const { body, metaXml } = unwrapApexEnvelope(content);
      return {
        type: "ApexClass",
        input: { className: ref.memberName, body, ...(metaXml ? { metaXml } : {}) },
      };
    }
    case "ApexTrigger": {
      const { body, metaXml } = unwrapApexEnvelope(content);
      return {
        type: "ApexTrigger",
        input: { triggerName: ref.memberName, body, ...(metaXml ? { metaXml } : {}) },
      };
    }
    case "LightningComponentBundle": {
      try {
        const parsed = JSON.parse(content || "{}") as {
          bundleName?: string;
          files?: Record<string, string>;
        };
        return {
          type: "LightningComponentBundle",
          input: { bundleName: parsed.bundleName ?? ref.memberName, files: parsed.files ?? {} },
        };
      } catch {
        return null;
      }
    }
    case "AuraDefinitionBundle": {
      // corecorr-08: filesystem bundles arrive as `{bundleName, files}` JSON
      // and go to the Aura parser. Anything else (the live generic extractor's
      // metadata.read() JSON) keeps the opaque node it produced before.
      const parsed = parseAuraBundleJson(content);
      if (parsed) {
        return {
          type: "AuraDefinitionBundle",
          input: {
            bundleName: parsed.bundleName ?? ref.memberName,
            files: parsed.files,
          },
        };
      }
      return {
        type: "OpaqueMetadata",
        input: { metadataType: ref.memberType, name: ref.memberName, raw: content },
      };
    }
    case "Flow":
      return { type: "Flow", input: { fullName: ref.memberName, xml: content } };
    case "CustomObject": {
      const s = content.trimStart();
      if (s.startsWith("{")) {
        try {
          const p = JSON.parse(s) as Partial<ObjectDirInput>;
          return {
            type: "CustomObject",
            input: { ...p, apiName: p.apiName ?? ref.memberName, objectXml: p.objectXml ?? "" },
          };
        } catch {
          /* fall through to raw XML */
        }
      }
      return { type: "CustomObject", input: { apiName: ref.memberName, objectXml: content } };
    }
    case "Profile":
      return { type: "Profile", input: { name: ref.memberName, xml: content } };
    case "PermissionSet":
      return { type: "PermissionSet", input: { name: ref.memberName, xml: content } };
    case "SharingRules":
      return { type: "SharingRules", input: { object: ref.memberName, xml: content } };
    case "NamedCredential":
      return { type: "NamedCredential", input: { name: ref.memberName, xml: content } };
    case "ExternalServiceRegistration":
      return { type: "ExternalServiceRegistration", input: { name: ref.memberName, xml: content } };
    case "OmniProcess":
    case "OmniUiCard":
    case "OmniDataTransform":
    case "OmniIntegrationProcedure": {
      let metadata: unknown = content;
      try {
        metadata = JSON.parse(content);
      } catch {
        /* keep raw */
      }
      return { type: ref.memberType, input: { name: ref.memberName, metadata } };
    }
    // The Vlocity runner emits the bare VlocityDataPackType as memberType
    // ("DataRaptor", "IntegrationProcedure", "OmniScript", "VlocityCard"),
    // but the four rich parsers register under "Vlocity"-prefixed type names
    // ("VlocityDataRaptor", …). Without this mapping the runner's members
    // never matched a case here and fell through to the opaque fallback —
    // shallow nodes with zero DR_/IP_/OS_ edges. Only "VlocityCard" happened
    // to align on both sides, which is why a real ingest produced VC edges
    // but no DataRaptor/IP/OmniScript lineage. The golden tests call the
    // parsers directly, so this runner→dispatch seam was never covered.
    // The legacy "Vlocity*"-prefixed keys are kept too in case any caller
    // (or a future filesystem source) emits them.
    case "DataRaptor":
    case "VlocityDataRaptor":
    case "IntegrationProcedure":
    case "VlocityIntegrationProcedure":
    case "OmniScript":
    case "VlocityOmniScript":
    case "VlocityCard": {
      let datapack: unknown = content;
      try {
        datapack = JSON.parse(content);
      } catch {
        /* keep raw */
      }
      return {
        type: VLOCITY_MEMBER_TO_PARSER[ref.memberType] ?? ref.memberType,
        input: { name: ref.memberName, datapack },
      };
    }
    default: {
      // Long-tail metadata types: route to a registered parser when one
      // exists (the 21 rule-based YAML parsers register under their raw
      // metadata type name, e.g. "Layout", "Dashboard"), otherwise fall
      // back to the opaque node parser so the member still becomes a
      // graph node. Before this fallback every generic-extractor member
      // was silently dropped here — extracted, logged as ✓, and never
      // merged — which left grant/reference edges dangling (e.g. 59k
      // GRANTS_TAB_ACCESS edges pointing at CustomTab nodes that were
      // never created).
      if (parserRegistry.for(ref.memberType)) {
        return { type: ref.memberType, input: genericRuleInput(ref.memberName, content) };
      }
      return {
        type: "OpaqueMetadata",
        input: {
          metadataType: ref.memberType,
          name: ref.memberName,
          raw: content,
          ...(ref.category === METADATA_CATEGORY.VLOCITY ? { scanDataPackRefs: true } : {}),
        },
      };
    }
  }
}

/**
 * Build the `{ name, xml, ...siblings }` input shape the rule-based parsers'
 * `xml-string` coercion expects. Filesystem sources hand us raw XML; the
 * live generic extractor hands us the JSON-serialized `metadata.read()`
 * object — whose keys mirror the parsed XML root, so they can be promoted
 * to sibling keys directly (coerceInput merges siblings into the record).
 */
function genericRuleInput(name: string, content: string): Record<string, unknown> {
  const s = (content ?? "").trimStart();
  if (s.startsWith("<")) return { name, xml: content };
  let parsed: Record<string, unknown> = {};
  try {
    const j: unknown = JSON.parse(s);
    if (j && typeof j === "object" && !Array.isArray(j)) parsed = j as Record<string, unknown>;
  } catch {
    /* not JSON — leave record empty; the node still gets name + label */
  }
  return { xml: "", ...parsed, name };
}

/** The run-wide part of a ParseContext (everything but the per-member fields). */
export interface ParseCtxBase {
  orgId: string;
  parseTimestamp: string;
}

/**
 * Outcome of parsing one member.
 * - `skip`: nothing to merge (no adapter / no registered parser).
 * - `parsed`: the parser's result.
 * - `error`: `phase: "parse"` is a parser failure (counted as a parse error);
 *   `phase: "adapt"` means building the parser input threw; `phase: "worker"`
 *   means the parse pool lost the member's worker (crash, exit, stall,
 *   protocol error) — not a verdict on the content, so it is retried;
 *   `phase: "quarantined"` means workers failed on this exact content
 *   WORKER_FAILURE_LIMIT times in a row, so it is not parsed until it changes
 *   (T15 N5-1, see member-rows.ts).
 */
export type MemberParse =
  | { kind: "skip"; parseMs: number }
  | { kind: "parsed"; result: ParseResult; parseMs: number }
  | {
      kind: "error";
      phase: "adapt" | "parse" | "worker" | "quarantined";
      message: string;
      stack?: string;
      parseMs: number;
    };

/**
 * Adapt and parse one member. Pure with respect to the graph: parsers see only
 * the member's content and the context, never the store, so members can be
 * parsed in any order or thread.
 */
export async function parseMember(
  ref: MemberRef,
  content: string,
  base: ParseCtxBase,
  logger: Logger,
): Promise<MemberParse> {
  try {
    await ensureRulesLoaded();
  } catch (e) {
    logger.warn("parse-member: rule load failed", { err: (e as Error).message });
  }
  let adapted: { type: string; input: unknown } | null;
  try {
    adapted = adaptParserInput(ref, content);
  } catch (e) {
    return { kind: "error", phase: "adapt", ...errorParts(e), parseMs: 0 };
  }
  if (!adapted) return { kind: "skip", parseMs: 0 };
  const parser = parserRegistry.for(adapted.type);
  if (!parser) return { kind: "skip", parseMs: 0 };
  const ctx: ParseContext = {
    orgId: base.orgId,
    parseTimestamp: base.parseTimestamp,
    namespace: null,
    logger,
    sourceUri: ref.sourceUri,
  };
  ctx.namespace = ref.namespace ?? null;
  const t0 = performance.now();
  try {
    const result = await parser.parse(adapted.input, ctx);
    return { kind: "parsed", result, parseMs: performance.now() - t0 };
  } catch (e) {
    return { kind: "error", phase: "parse", ...errorParts(e), parseMs: performance.now() - t0 };
  }
}

function errorParts(e: unknown): { message: string; stack?: string } {
  const err = e as { message?: unknown; stack?: unknown } | null;
  const message = typeof err?.message === "string" ? err.message : String(e);
  return typeof err?.stack === "string" ? { message, stack: err.stack } : { message };
}
