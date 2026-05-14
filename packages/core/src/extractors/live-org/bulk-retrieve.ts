import type { OrgId } from "@ryanstark24/sfgraph-shared";
import type { RawMember } from "../interfaces/metadata-source.js";
import type { OrgCapabilities } from "./capabilities.js";
import { discoverMetadataTypes } from "./discovery.js";
import { buildDispatchTable } from "./dispatch.js";
import { iterApex } from "./extractors/apex.js";
import { iterFlow } from "./extractors/flow.js";
import { iterGenericMetadata } from "./extractors/generic-metadata.js";
import { iterIntegration } from "./extractors/integration.js";
import { iterLwc } from "./extractors/lwc.js";
import { iterObject } from "./extractors/object.js";
import { iterOmnistudio } from "./extractors/omnistudio.js";
import { iterSecurity } from "./extractors/security.js";
import { iterVlocity } from "./extractors/vlocity.js";

/** Aggregate of every source that errored during a bulkRetrieve run.
 *  bulkRetrieve mutates this in-place via onError; live-ingest reads it at
 *  end of run to print a consolidated summary instead of warning per-source
 *  in the middle of progress output. */
export interface IngestSkipReport {
  skips: Array<{ label: string; reason: string; category: SkipCategory }>;
}

export type SkipCategory =
  | "insufficient_access"
  | "not_found"
  | "rate_limit"
  | "network"
  | "unknown";

/** Best-effort classification so the end-of-run recommendation is targeted. */
function classifySkip(msg: string): SkipCategory {
  const m = msg.toUpperCase();
  if (m.includes("INSUFFICIENT_ACCESS") || m.includes("INSUFFICIENT") || m.includes("FORBIDDEN")) {
    return "insufficient_access";
  }
  if (m.includes("NOT_FOUND") || m.includes("INVALID_TYPE")) return "not_found";
  if (m.includes("REQUEST_LIMIT_EXCEEDED") || m.includes("RATE_LIMIT")) return "rate_limit";
  if (m.includes("ECONNREFUSED") || m.includes("ENOTFOUND") || m.includes("ETIMEDOUT")) {
    return "network";
  }
  return "unknown";
}

/** Naive sequential merge — predictable order, simpler back-pressure semantics. */
export async function* mergeAsyncIterables<T>(...iters: Array<AsyncIterable<T>>): AsyncIterable<T> {
  for (const it of iters) {
    for await (const v of it) yield v;
  }
}

/** Wrap an iterable so a thrown error is captured + the stream ends cleanly
 *  instead of aborting the whole ingest. The error is recorded into a
 *  shared skip report (consumed at end-of-run) and a compact ✗ line is
 *  printed so the user sees something happened without the full error
 *  message scrolling past during the run. */
async function* failSoft<T>(
  label: string,
  factory: () => AsyncIterable<T>,
  onError?: (label: string, err: Error) => void,
): AsyncIterable<T> {
  const startedAt = Date.now();
  let count = 0;
  let started = false;
  try {
    for await (const v of factory()) {
      if (!started) {
        started = true;
        console.log(`ingest:   ${label} → starting…`);
      }
      count += 1;
      yield v;
    }
    if (started) {
      console.log(`ingest:   ${label} ✓ ${count} records (${Date.now() - startedAt}ms)`);
    } else {
      console.log(`ingest:   ${label} ✓ 0 records (${Date.now() - startedAt}ms)`);
    }
  } catch (e) {
    const err = e as Error;
    onError?.(label, err);
    // Compact one-liner during the run — full details are aggregated and
    // surfaced in the end-of-run skip summary so the user gets one clear
    // remediation block instead of N scattered warnings.
    console.log(`ingest:   ${label} ✗ skipped`);
  }
}

/** Typed-extractor ownership map: which XML type names a dedicated extractor covers. */
const APEX_TYPES = new Set(["ApexClass", "ApexTrigger"]);
const LWC_TYPES = new Set(["LightningComponentBundle"]);
const FLOW_TYPES = new Set(["Flow"]);
const OBJECT_TYPES = new Set(["CustomObject"]);
const SECURITY_TYPES = new Set(["Profile", "PermissionSet", "SharingRules"]);
const INTEGRATION_TYPES = new Set(["NamedCredential", "ExternalServiceRegistration"]);

export async function* bulkRetrieve(
  conn: any,
  caps: OrgCapabilities,
  orgId: OrgId,
  skipReport?: IngestSkipReport,
): AsyncIterable<RawMember> {
  // Discover the type list this org actually supports. If discovery fails or
  // returns nothing usable, fall back to invoking every known extractor —
  // preserves Commit-A behavior for mocks that don't implement describe.
  let types: Awaited<ReturnType<typeof discoverMetadataTypes>> = [];
  try {
    types = await discoverMetadataTypes(conn);
  } catch {
    types = [];
  }

  const sources: Array<AsyncIterable<RawMember>> = [];
  const invoked = new Set<string>(); // source-key dedup

  const onSkip = skipReport
    ? (label: string, err: Error) => {
        const reason = err?.message ?? String(err);
        skipReport.skips.push({ label, reason, category: classifySkip(reason) });
      }
    : undefined;

  const invoke = (key: string, factory: () => AsyncIterable<RawMember>) => {
    if (invoked.has(key)) return;
    invoked.add(key);
    // Each source is wrapped fail-soft so one failing type (e.g. a metadata
    // category the user's profile lacks access to) doesn't abort the whole
    // ingest. The wrapper records the source label + error into skipReport
    // (consumed at end of run for a consolidated summary) and ends the
    // stream cleanly.
    sources.push(failSoft(key, factory, onSkip));
  };

  if (types.length === 0) {
    // Discovery unavailable: invoke every dedicated extractor once.
    invoke("apex", () => iterApex(conn));
    invoke("lwc", () => iterLwc(conn));
    invoke("flow", () => iterFlow(conn));
    invoke("object", () => iterObject(conn));
    invoke("security", () => iterSecurity(conn));
    invoke("integration", () => iterIntegration(conn));
  } else {
    const dispatch = buildDispatchTable(types, caps);
    for (const [type, route] of dispatch.entries()) {
      switch (route.strategy) {
        case "toolingSoql":
          if (APEX_TYPES.has(type)) invoke("apex", () => iterApex(conn));
          else if (LWC_TYPES.has(type)) invoke("lwc", () => iterLwc(conn));
          else invoke(`generic:${type}`, () => iterGenericMetadata(conn, String(orgId), type));
          break;
        case "metadataReadList":
          if (FLOW_TYPES.has(type)) invoke("flow", () => iterFlow(conn));
          else if (OBJECT_TYPES.has(type)) invoke("object", () => iterObject(conn));
          else if (SECURITY_TYPES.has(type)) invoke("security", () => iterSecurity(conn));
          else if (INTEGRATION_TYPES.has(type)) invoke("integration", () => iterIntegration(conn));
          else invoke(`generic:${type}`, () => iterGenericMetadata(conn, String(orgId), type));
          break;
        case "vlocityRunner":
          // Single invocation handled below.
          break;
        case "sobjectSoql":
          // Reserved for future CMDT/etc. — none routed here in Commit B.
          break;
        case "genericOpaque":
          // No-op for now: we don't pollute the graph with sentinel-only nodes.
          break;
      }
    }
  }

  if (caps.vlocityLegacy) {
    invoke("vlocity", () => iterVlocity(conn, caps, String(orgId)));
  }
  if (caps.omnistudioOncore) {
    invoke("omnistudio", () => iterOmnistudio(conn));
  }

  yield* mergeAsyncIterables(...sources);
}
