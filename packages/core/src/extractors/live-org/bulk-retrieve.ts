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

/** Naive sequential merge — predictable order, simpler back-pressure semantics.
 *  Kept for back-compat and tests; production ingest uses
 *  {@link mergeAsyncIterablesParallel} so different pools (Tooling/Metadata/
 *  Data) can saturate simultaneously instead of one extractor at a time. */
export async function* mergeAsyncIterables<T>(...iters: Array<AsyncIterable<T>>): AsyncIterable<T> {
  for (const it of iters) {
    for await (const v of it) yield v;
  }
}

/**
 * Parallel merge over a BOUNDED number of concurrent iterators. Drains
 * `iters` in waves of at most `concurrency` at a time — within a wave the
 * iterators race via `Promise.race` for maximum throughput, but no more
 * than `concurrency` are ever live simultaneously.
 *
 * Bounding matters for ingest robustness: running all ~60 source iterators
 * concurrently caused silent native aborts at ~30s on macOS 26+, almost
 * certainly from cumulative jsforce/libuv state (HTTP agent pool, response
 * handlers in flight, etc.) exceeding some internal threshold. With a
 * bounded wave size, each wave completes and its state is GC'd before the
 * next wave starts — keeps total in-flight state flat at any moment.
 *
 * Default concurrency = 6: large enough for the three rate-limit pools
 * (Tooling 5 / Metadata 5 / Data 10) to all be saturated by some wave
 * member, small enough that cumulative HTTP/jsforce state stays bounded.
 * Override via `SFGRAPH_SOURCE_CONCURRENCY=<n>` (1 = strictly sequential,
 * 64 = original unbounded).
 *
 * Output ordering is non-deterministic. `live-ingest`'s processOne is
 * order-independent (idempotent per-record upserts), so this is safe.
 */
export async function* mergeAsyncIterablesParallel<T>(
  ...iters: Array<AsyncIterable<T>>
): AsyncIterable<T> {
  const envConcurrency = Number.parseInt(process.env.SFGRAPH_SOURCE_CONCURRENCY ?? "", 10);
  const concurrency =
    Number.isFinite(envConcurrency) && envConcurrency > 0 ? envConcurrency : 6;
  // Process in waves: take up to `concurrency` iterators, drain them
  // concurrently to completion, then move to the next batch.
  for (let waveStart = 0; waveStart < iters.length; waveStart += concurrency) {
    const wave = iters.slice(waveStart, waveStart + concurrency);
    yield* drainWaveConcurrently(wave);
  }
}

/** Concurrent drain of a single wave — exactly the original Promise.race
 *  pattern, now scoped to one bounded batch instead of all iterators. */
async function* drainWaveConcurrently<T>(
  iters: Array<AsyncIterable<T>>,
): AsyncIterable<T> {
  const iterators = iters.map((it) => it[Symbol.asyncIterator]());
  type Tagged = Promise<{ idx: number; result: IteratorResult<T> }>;
  const pending = new Map<number, Tagged>();
  const advance = (idx: number): void => {
    const it = iterators[idx];
    if (!it) return;
    pending.set(
      idx,
      it.next().then(
        (result) => ({ idx, result }),
        // Per-iter rejections are handled by the failSoft() wrapper one
        // level up. Anything that reaches here is unexpected; mark the
        // iter done so the outer race makes forward progress.
        () => ({
          idx,
          result: { value: undefined as unknown as T, done: true } as IteratorResult<T>,
        }),
      ),
    );
  };
  for (let i = 0; i < iterators.length; i++) advance(i);
  while (pending.size > 0) {
    const { idx, result } = await Promise.race(pending.values());
    if (result.done) {
      pending.delete(idx);
      continue;
    }
    yield result.value;
    advance(idx);
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
  const debug = process.env.SFGRAPH_DEBUG_INGEST === "1";
  const startedAt = Date.now();
  let count = 0;
  let started = false;
  try {
    if (debug) console.log(`ingest: [debug] ${label} ← invoked at ${startedAt}`);
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
    // remediation block instead of N scattered warnings. In debug mode,
    // also print the full error so the user can see exactly why a source
    // failed without waiting for the end-of-run summary.
    console.log(`ingest:   ${label} ✗ skipped`);
    if (debug) {
      console.error(`ingest: [debug] ${label} failure detail: ${err?.message ?? String(err)}`);
      if (err?.stack) console.error(err.stack);
    }
  } finally {
    if (debug) {
      console.log(
        `ingest: [debug] ${label} → finalised (${count} records, ${Date.now() - startedAt}ms)`,
      );
    }
  }
}

/** Typed-extractor ownership map: which XML type names a dedicated extractor covers. */
const APEX_TYPES = new Set(["ApexClass", "ApexTrigger"]);
const LWC_TYPES = new Set(["LightningComponentBundle"]);
const FLOW_TYPES = new Set(["Flow"]);
const OBJECT_TYPES = new Set(["CustomObject"]);
const SECURITY_TYPES = new Set(["Profile", "PermissionSet", "SharingRules"]);
const INTEGRATION_TYPES = new Set(["NamedCredential", "ExternalServiceRegistration"]);

/**
 * High-value generic metadata types we'll route to `iterGenericMetadata` by
 * default. Salesforce's `describeMetadata()` returns 400+ types on modern
 * orgs — most of them platform internals, industry-cloud scaffolding,
 * Setup-internal stuff that returns 0 records or has no graph value AND
 * adds queued HTTP requests to Bottleneck (each one a closure + socket
 * state). Scheduling all 400 at once was causing silent process exits
 * post-object-phase on the user's cleanDemoOrg — too many pending
 * metadata.list calls in the metadata pool's queue.
 *
 * This list is curated for "does user code typically reference this?" /
 * "does it carry graph-relevant edges?". Add types to it as you discover
 * value in them. Override via `SFGRAPH_INCLUDE_ALL_GENERIC=1` to invoke
 * every discovered type (useful for industry-cloud-specific ingest).
 */
const GENERIC_TYPE_WHITELIST = new Set([
  // UI / pages — typically referenced from FlexiPages / Lightning App Builder
  "FlexiPage",
  "Layout",
  "QuickAction",
  "CustomTab",
  "CustomApplication",
  "HomePageLayout",
  "CustomPageWebLink",
  "WebLink",
  // Apex / VF surfaces routed here (not in core extractors)
  "ApexPage",
  "ApexComponent",
  "AuraDefinitionBundle",
  // Process automation
  "Workflow",
  "ApprovalProcess",
  "AssignmentRules",
  "AutoResponseRules",
  "EscalationRules",
  "FlowDefinition",
  // Data quality
  "DuplicateRule",
  "MatchingRule",
  // Custom Metadata + labels
  "CustomMetadata",
  "CustomLabels",
  "CustomLabel",
  "GlobalValueSet",
  "StandardValueSet",
  "CustomPermission",
  // Custom Notification + Settings
  "CustomNotificationType",
  "CustomSite",
  // Reports / Dashboards / Analytics
  "Report",
  "Dashboard",
  "ReportType",
  // Networks / Communities
  "Network",
  "NetworkBranding",
  "NavigationMenu",
  "Community",
  "ExperienceBundle",
  "DigitalExperienceBundle",
  // Identity / Access
  "ConnectedApp",
  "Profile",
  "PermissionSet",
  "PermissionSetGroup",
  "MutingPermissionSet",
  "ProfilePasswordPolicy",
  "ProfileSessionSetting",
  "SamlSsoConfig",
  // Sharing
  "SharingRules",
  "SharingSet",
  "GroupMember",
  // Platform Events / CDC
  "PlatformEventChannel",
  "PlatformEventChannelMember",
  "PlatformEventSubscriberConfig",
  // Integrations
  "RemoteSiteSetting",
  "CspTrustedSite",
  "NamedCredential",
  "ExternalCredential",
  // Email
  "EmailTemplate",
  "EmailServicesFunction",
  // Misc commonly-used
  "StaticResource",
  "LightningComponentBundle",
  "LightningMessageChannel",
  "RecordActionDeployment",
  "PathAssistant",
  "GenAiPromptTemplate",
  "GenAiFunction",
  "GenAiPlugin",
  // Bot / Einstein
  "Bot",
  "GenAiPlannerBundle",
]);

function shouldRouteGeneric(type: string): boolean {
  if (process.env.SFGRAPH_INCLUDE_ALL_GENERIC === "1") return true;
  return GENERIC_TYPE_WHITELIST.has(type);
}

export interface BulkRetrieveOpts {
  skipReport?: IngestSkipReport;
  /** When set, only invoke source labels in this set. Labels are the same
   *  source-keys used by the dispatch table: 'apex', 'lwc', 'flow', 'object',
   *  'security', 'integration', 'vlocity', 'omnistudio', or
   *  'generic:<MetadataType>' for the long tail. */
  onlyLabels?: Set<string>;
}

export async function* bulkRetrieve(
  conn: any,
  caps: OrgCapabilities,
  orgId: OrgId,
  opts: BulkRetrieveOpts | IngestSkipReport = {},
): AsyncIterable<RawMember> {
  // Back-compat: callers used to pass IngestSkipReport directly as the 4th arg.
  // Accept both shapes.
  const normalized: BulkRetrieveOpts =
    opts && typeof opts === "object" && "skips" in (opts as object)
      ? { skipReport: opts as IngestSkipReport }
      : (opts as BulkRetrieveOpts);
  const skipReport = normalized.skipReport;
  const onlyLabels = normalized.onlyLabels;
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
    // --only filter: when onlyLabels is set, skip any source not in the set.
    // Filter applies to the exact source key ('apex', 'generic:Profile', etc.)
    // for precise targeting of retry/partial-refresh flows.
    if (onlyLabels && !onlyLabels.has(key)) return;
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
    let routedGeneric = 0;
    let skippedGeneric = 0;
    for (const [type, route] of dispatch.entries()) {
      switch (route.strategy) {
        case "toolingSoql":
          if (APEX_TYPES.has(type)) invoke("apex", () => iterApex(conn));
          else if (LWC_TYPES.has(type)) invoke("lwc", () => iterLwc(conn));
          else if (shouldRouteGeneric(type)) {
            routedGeneric += 1;
            invoke(`generic:${type}`, () => iterGenericMetadata(conn, String(orgId), type));
          } else {
            skippedGeneric += 1;
          }
          break;
        case "metadataReadList":
          if (FLOW_TYPES.has(type)) invoke("flow", () => iterFlow(conn));
          else if (OBJECT_TYPES.has(type)) invoke("object", () => iterObject(conn));
          else if (SECURITY_TYPES.has(type)) invoke("security", () => iterSecurity(conn));
          else if (INTEGRATION_TYPES.has(type)) invoke("integration", () => iterIntegration(conn));
          else if (shouldRouteGeneric(type)) {
            routedGeneric += 1;
            invoke(`generic:${type}`, () => iterGenericMetadata(conn, String(orgId), type));
          } else {
            skippedGeneric += 1;
          }
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
  // Log the generic-type filter summary once at fan-out start — makes the
  // skip-vs-route decision visible without --debug.
  if (types.length > 0) {
    console.log(
      `ingest: dispatch routed=${sources.length} sources (${types.length} discovered metadata types; generic-type whitelist active — set SFGRAPH_INCLUDE_ALL_GENERIC=1 to invoke all)`,
    );
  }

  // Parallel by default: fan out across all source iterators so different
  // pools (Tooling/Metadata/Data) saturate simultaneously. Escape hatch:
  // SFGRAPH_SEQUENTIAL_SOURCES=1 falls back to the legacy serial merge for
  // anyone who hits an ordering bug or wants the old log layout.
  const sequential = process.env.SFGRAPH_SEQUENTIAL_SOURCES === "1";
  yield* sequential ? mergeAsyncIterables(...sources) : mergeAsyncIterablesParallel(...sources);
}
