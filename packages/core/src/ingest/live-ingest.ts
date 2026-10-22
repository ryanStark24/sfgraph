import { existsSync, readFileSync } from "node:fs";
import { type OrgId, type QualifiedName, asQualifiedName } from "@ryanstark24/sfgraph-shared";
import type { Logger } from "@ryanstark24/sfgraph-shared";
import { type ArityResolveOpts, resolveApexMethodArity } from "../parsers/apex/arity-resolver.js";
import { retargetApexInterfaceRefs } from "../parsers/apex/interface-ref-resolver.js";
import { resolveAuraEmbeds } from "../parsers/aura/embed-resolver.js";
import type { ParseContext, ParseResult } from "../parsers/contract.js";
import { resolveCrossFlavor } from "../parsers/cross-flavor-resolver.js";
import { resolveFlowApexMethods } from "../parsers/flow/invocable-resolver.js";
import { resolveFormulaRelationshipHops } from "../parsers/object/formula-hop-resolver.js";
// Ensure all parsers are registered before we look them up.
import "../parsers/index.js";
import { auditDanglingEdges } from "../analyze/audit-graph.js";
import { populateAnalysisTables } from "../analyze/populate.js";
import { REL_TYPES } from "../domain/rel-types.js";
import {
  EmbeddingCache,
  type EmbeddingCacheLike,
  EmbeddingPool,
  EmbeddingQueue,
  type VectorSink,
  defaultEmbeddingWorkerUrl,
  hashEmbedText,
} from "../embedding/index.js";
import { tokenizeIdentifier } from "../embedding/tokenize.js";
import type {
  MemberRef,
  MetadataSource,
  RawMember,
} from "../extractors/interfaces/metadata-source.js";
import { type ResolveOrgDeps, type ResolvedOrg, resolveOrg } from "../extractors/live-org/auth.js";
import { type IngestSkipReport, bulkRetrieve } from "../extractors/live-org/bulk-retrieve.js";
import { type OrgCapabilities, probeCapabilities } from "../extractors/live-org/capabilities.js";
import { type LivenessProbeHandle, startLivenessProbe } from "../extractors/live-org/liveness.js";
import { dataPool, metadataPool, toolingPool } from "../extractors/live-org/rate-limit.js";
import { iterChanges } from "../extractors/live-org/source-member.js";

// SourceMember MemberType -> the node LABEL the parsers actually store under,
// for the (rare) types whose label differs from the member type. The LWC parser
// labels nodes "LWC", not "LightningComponentBundle", so an obsolete-LWC delete
// keyed by the raw member type was a silent no-op. METADATA_CATEGORY is NOT
// usable here: its LWC/AURA values ARE the member-type strings, not the labels.
const MEMBER_TYPE_TO_NODE_LABEL: Record<string, string> = {
  LightningComponentBundle: "LWC",
  AuraDefinitionBundle: "AuraComponent",
};
import { loadAllRules } from "../parsers/rules/_loader.js";
import type { BetterSqlite3Database, GraphStore, MemberRow } from "../storage/interfaces.js";
import type { SnapshotStore } from "../storage/interfaces.js";
import {
  evaluateDeletionGuard,
  isSkipProtected,
  resolveMaxDropRatio,
  skipProtection,
} from "./detect-deletions-guard.js";
import {
  hasGoodPriorOwned,
  isParseFailureOnly,
  isQuarantinedFor,
  isQuarantinedRow,
  memberContentHash,
  memberFailureStamp,
  memberRowsGeneration,
  ownedQnames,
  quarantinedOutcome,
} from "./member-rows.js";
import { OFFLINE_CAPS } from "./offline-org.js";
import { type MemberParse, parseMember } from "./parse-member.js";
import {
  type ParsePoolOpts,
  type ParsePoolStats,
  parsePool,
  resolveParseWorkers,
} from "./parse-pool.js";

export { adaptParserInput } from "./parse-member.js";
import { createIngestProfiler } from "./profile.js";

export type IngestMode = "full" | "incremental" | "auto";

export interface LiveIngestOpts {
  /** Offline source (e.g. FilesystemMetadataSource). When set, no
   *  connection call is made: capability probe, discovery, MCD baseline,
   *  liveness probe and bulkRetrieve are skipped and the source's members
   *  are streamed through processOne. Forces mode "full". */
  metadataSource?: MetadataSource;
  alias: string;
  mode?: IngestMode;
  graphStore: GraphStore;
  snapshotStore?: SnapshotStore;
  logger?: Logger;
  /** Skip pre-sync snapshot. Default false. */
  skipSnapshot?: boolean;
  /** Snapshot retention in days. Default 30. */
  snapshotRetentionDays?: number;
  /** Override @salesforce/core for tests. */
  resolveDeps?: ResolveOrgDeps;
  /** Pre-resolved org (test/mock injection). When supplied, resolveOrg is skipped. */
  preResolved?: ResolvedOrg;
  /** When provided, analysis tables are populated after merge. */
  analysisDb?: BetterSqlite3Database;
  /** When provided, batched embedding vectors are pushed during ingest. */
  vectorStore?: VectorSink;
  /**
   * When true and mode resolves to "full", compute the set of qnames that
   * existed before the sync but were NOT touched during it, and delete them.
   * Aborts (no deletions) if any parse errors occurred — preserves the graph
   * against transient SF API hiccups. No-op in incremental mode (deletions
   * already surface via SourceMember.IsNameObsolete).
   */
  detectDeletions?: boolean;
  /**
   * Restrict the ingest to specific source labels (e.g. 'apex',
   * 'generic:Profile', 'vlocity'). Used by --only and --retry-skipped to
   * fetch a subset of types without rebuilding the whole graph.
   */
  onlyLabels?: Set<string>;
  /**
   * `onlyLabels` was chosen by the user (--only / --retry-skipped) rather
   * than by the CLI's in-run auto-retry: the generic types it names are read
   * in full, without the early stop on identical refusals.
   */
  explicitOnlyLabels?: boolean;
  /**
   * Where to persist the skip report at end of run. When set, the report is
   * written as JSON so --retry-skipped can read it on the next run.
   */
  skipReportPath?: string;
  /** Skip the post-merge Vlocity↔OmniStudio canonical resolve pass. */
  disableCrossFlavor?: boolean;
  /**
   * Skip the post-merge OmniStudio overlap detector that annotates
   * CANONICAL_OF edges with `signaturesMatch` + `divergencePoints`.
   * Default **on** — runs every ingest. Pitfalls research flagged the
   * false-positive recovery cost as high (a wrong "diverged" label
   * sends an engineer chasing a non-issue); we accept that risk in
   * exchange for migration-audit visibility on every sync. Filter by
   * `attributes.signaturesMatch === false` on CANONICAL_OF edges to
   * surface the diverged set; ignore the flag if the column doesn't
   * matter to your use case.
   */
  disableOverlapDetect?: boolean;
  /**
   * Skip the MCD baseline pre-fan-out pass that queries
   * `MetadataComponentDependency` for long-tail metadata types (Layouts,
   * FieldSets, EmailTemplates, Tabs, Groups, Queues) and writes
   * source='mcd' edges before the regular parser fan-out starts.
   * Default **on** — long-tail coverage is generally a clear win;
   * disable only for ingest-time-sensitive scenarios where ~6 Tooling
   * SOQL queries per type are unwelcome.
   */
  disableMcdBaseline?: boolean;
  /**
   * Skip the Metadata API `retrieve()` path for OmniStudio-on-Core
   * types (OmniUiCard, OmniIntegrationProcedure, OmniDataTransform).
   * Default **on** — the SOQL path runs alongside this and the
   * retrieve path yields the full design-time XML envelope (vs
   * PropertySet JSON only). Disable when your org is quota-constrained
   * (Metadata API allows 10k retrieve calls per 24h org-wide) or when
   * you don't need the XML envelope downstream. Quota-guard auto-skips
   * at >=90% utilization regardless of this flag.
   */
  disableOmnistudioRetrieve?: boolean;
  /**
   * Skip the reflection-based generic walker (post-merge). Default
   * **on** — scans every node's attributes for string values that
   * match an existing qname's bare name and emits low-confidence
   * REFERENCES edges tagged `source: 'reflection'`. Pitfalls research
   * flagged precision concerns (false positives when a string
   * coincidentally equals a qname); we accept that in exchange for
   * coverage of OmniStudio/Vlocity blobs the platform doesn't expose
   * a schema for. Filter `attributes.source !== 'reflection'` for the
   * parser-quality subset when precision matters.
   */
  disableReflectionWalker?: boolean;
  /** Skip the post-merge Apex method arity resolver pass. */
  disableArityResolve?: boolean;
  /**
   * Skip the post-merge pass that moves `ApexClass:X` references onto
   * `ApexInterface:X` when no class X exists (independent of
   * `disableArityResolve`).
   */
  disableInterfaceRetarget?: boolean;
  /**
   * Skip the post-merge pass that moves a formula's second-hop field guess
   * onto the CustomField declaring that relationshipName (independent of
   * `disableArityResolve`).
   */
  disableFormulaHopResolve?: boolean;
  /** Skip the post-merge Flow→Apex method-level resolver pass. */
  disableFlowInvocableResolve?: boolean;
  /** Skip the post-merge Vlocity Remote Action → Apex resolver pass. */
  disableVlocityApexResolve?: boolean;
  /** Skip the post-merge DataRaptor `Rel__r.Field` relationship-path resolver pass. */
  disableDrRelationshipResolve?: boolean;
  /** Skip the post-merge Flow `$Record.Account.Field` relationship-path resolver pass. */
  disableFlowRelationshipResolve?: boolean;
  /** Skip the post-merge Vlocity DataPack name-match resolver pass. */
  disableVlocityNameMatchResolve?: boolean;
  /** Skip the post-merge Apex relationship-path / lowercase test-target resolver pass. */
  disableApexRefResolve?: boolean;
  /** Skip the post-merge LWC record-literal `X__c` key → unique CustomField resolver pass. */
  disableLwcFieldKeyResolve?: boolean;
  /** Skip the post-merge dangling-edge audit pass. */
  disableAudit?: boolean;
  /**
   * The caller is rebuilding this org's graph (CLI `--rebuild`). Enables the
   * rebuild fast path (bulk-load window, no per-member delete probes) when the
   * org's graph is empty at start. Emptiness is the correctness condition, so
   * an unset flag behaves like true for full-mode ingests into an empty graph;
   * pass `false` to force the per-member path. `SFGRAPH_DISABLE_FASTPATH=1`
   * always forces the per-member path.
   */
  rebuild?: boolean;
  /**
   * Embedding backend. Defaults to a worker-thread pool owned (and closed) by
   * this ingest in compiled builds, else the in-process model. An injected
   * embedder is owned by the CALLER and is never closed here, so one pool can
   * be shared across several ingests (the CLI does this for multi-org runs).
   */
  embedder?: { embed(texts: string[]): Promise<Float32Array[]>; close?(): unknown };
  /** Persistent text → vector cache file (see `embeddingCachePath`). */
  embeddingCacheFile?: string;
  /**
   * Wait for embeddings to finish before returning (default true). With
   * false, ingest returns at "graph ready"; the unembedded texts stay flagged
   * pending and the next ingest fills them in.
   */
  waitEmbeddings?: boolean;
  /**
   * Parse-pool overrides (tests and tuning). Default: SFGRAPH_PARSE_WORKERS
   * workers (min(4, availableParallelism - 1) when unset, 0 = parse on the
   * main thread), the compiled worker, and serial parsing for inputs under 500
   * members. `stats`, when given, is filled in during the fan-out.
   */
  parsePool?: Pick<ParsePoolOpts, "workers" | "workerUrl" | "minMembers" | "stats">;
  /**
   * Test / instrumentation hook, called synchronously as named phases
   * complete. Today: "sync-complete" (right after markSyncComplete).
   */
  onPhase?: (name: string) => void;
  /**
   * Task 11c: run as the merge step of a project delta (ingest/delta.ts).
   * Requires `metadataSource` and mode "full"; the hooks replace the member
   * stream, scope the resolver passes, and skip the audit, the member-row
   * bookkeeping and the ghost sweep (the delta does its own).
   */
  delta?: LiveIngestDeltaHooks;
}

/** Task 11c: how a delta ingest drives liveIngest (see `LiveIngestOpts.delta`). */
export interface LiveIngestDeltaHooks {
  /** The members to (re)parse, in source order; replaces `metadataSource.iter()`. */
  members: AsyncIterable<RawMember>;
  /** Every member as it is applied (errored: a parse or merge failure). */
  onMember(member: RawMember, outcome: MemberParse, errored: boolean): void;
  /** After the merge (bulk window closed), before the resolver passes. */
  afterMerge(): void;
  /** Scope for each resolver pass; undefined means the whole graph. */
  arityScope(): ArityResolveOpts["scope"] | undefined;
  /** Members whose row ends quarantined after this delta (T15 N5-1). */
  quarantinedCount?(): number;
  retargetInterfaceNames(): ReadonlySet<string> | undefined;
  hopSources(): ReadonlySet<string> | undefined;
  /**
   * Called right before the reflection walk: removes the stale reflection
   * edges and returns the sources to walk (undefined: walk everything).
   */
  reflectionSources(): ReadonlySet<string> | undefined;
  /** After the sync is marked complete and dead code recomputed. */
  finalize(): void;
}

/** Embedding outcome of an ingest (undefined when no vector store). */
export interface LiveIngestEmbeddings {
  /** Vectors served from the persistent cache. */
  cached: number;
  /** Texts run through the model. */
  computed: number;
  /** Texts whose stored vector already matched. */
  unchanged: number;
  /** Texts whose model call failed. */
  failed: number;
  /** Texts left unembedded when the ingest returned (no-wait or failure). */
  pending: number;
  /** Texts re-queued from an earlier run that left vectors pending. */
  backfilled: number;
  /** ms from ingest start until embeddings finished (or were abandoned). */
  doneMs: number;
  /** First embedding error, if any. */
  error?: string;
}

export interface LiveIngestResult {
  orgId: OrgId;
  capabilities: OrgCapabilities;
  mode: IngestMode;
  membersProcessed: number;
  parseErrors: number;
  deletions: number;
  durationMs: number;
  /** Number of CANONICAL_OF edges emitted by the cross-flavor resolver. */
  crossFlavorEdges: number;
  /** Number of stranded Apex CALLS edges rewritten to real-arity targets. */
  arityResolved: number;
  /**
   * Members recorded as failed and skipped until their content changes, after
   * WORKER_FAILURE_LIMIT consecutive parse-worker crashes or stalls (T15 N5-1).
   */
  parseQuarantined?: number;
  /** `ApexClass:X` references moved onto `ApexInterface:X` (Task 11c, M-3). */
  interfaceRefsRetargeted?: number;
  /** Number of Flow→Apex class edges resolved to method-level. */
  flowMethodsResolved: number;
  /** Vlocity Remote Action → Apex resolver counts (undefined when skipped or failed). */
  vlocityApex?:
    | undefined
    | {
        scanned: number;
        resolvedClass: number;
        resolvedMethod: number;
        ambiguous: number;
        external: number;
      };
  /** DataRaptor relationship-path resolver counts (undefined when skipped or failed). */
  drRelationships?:
    | undefined
    | { scanned: number; resolved: number; unresolved: number; edgesEmitted: number };
  /** Number of edges whose dst node does not exist after all post-passes. */
  danglingEdges: number;
  /** REFERENCES edges emitted by the reflection walker. Zero when
   *  `disableReflectionWalker: true` was passed. */
  reflectionEdges: number;
  /**
   * Overlap-detector summary. Zero across the board when
   * `disableOverlapDetect: true` was passed; otherwise populated.
   */
  overlap: {
    /** CANONICAL_OF pairs whose endpoints share an identical signature. */
    matched: number;
    /** CANONICAL_OF pairs whose endpoint signatures diverge. */
    diverged: number;
    /** CANONICAL_OF pairs with no outgoing non-canonical edges on either side. */
    empty: number;
    /** Total CANONICAL_OF edges annotated. */
    annotated: number;
  };
  /**
   * Per-source warnings collected during ingest. Each entry is a stringified
   * `label: reason` describing a skipped extractor, a failed per-type query,
   * a child-fetch failure, or any other non-fatal event the run wants
   * surfaced to MCP consumers (get_ingest_job) rather than buried in stdout.
   * Empty array on a clean run.
   */
  warnings: string[];
  /**
   * The member stream threw part-way (e.g. the parallel merge rethrowing a
   * failed sub-stream): the graph holds what was read before it, nothing was
   * swept, and `warnings` carries `stream:aborted:<message>`.
   */
  streamAborted?: boolean;
  /** ms from ingest start until the graph (merges, resolvers, dead-code) was complete. */
  graphReadyMs?: number;
  embeddings?: LiveIngestEmbeddings;
}

const NOOP_LOG: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Print a consolidated end-of-run summary of metadata types that were
 *  skipped during ingest, grouped by failure category, with a targeted
 *  remediation block per category. */
/**
 * Entries of the previous skip report at `path` (same org) whose label a
 * scoped run did NOT re-run. Missing / malformed / other-org report: none.
 * A `discovery` only-label re-runs every generic:* source (bulkRetrieve), so
 * their entries are not carried either (review N3).
 */
export function carriedOverSkips(
  path: string,
  orgId: string,
  reRun: ReadonlySet<string>,
): IngestSkipReport["skips"] {
  try {
    if (!existsSync(path)) return [];
    const prev = JSON.parse(readFileSync(path, "utf8")) as {
      orgId?: string;
      skips?: IngestSkipReport["skips"];
    };
    if (prev.orgId !== undefined && prev.orgId !== orgId) return [];
    return (prev.skips ?? []).filter(
      (s) =>
        s &&
        typeof s.label === "string" &&
        !reRun.has(s.label) &&
        !(reRun.has("discovery") && s.label.startsWith("generic:")),
    );
  } catch {
    return [];
  }
}

/** A skip reason without a leading "<label>: " — source errors already name
 *  their source, which the summary bullet prints anyway. */
function bulletReason(s: { label: string; reason: string }): string {
  return s.reason.startsWith(`${s.label}: `) ? s.reason.slice(s.label.length + 2) : s.reason;
}
export function printSkipSummary(report: IngestSkipReport, orgAlias: string): void {
  const byCategory = new Map<string, Array<{ label: string; reason: string }>>();
  for (const s of report.skips) {
    const arr = byCategory.get(s.category) ?? [];
    arr.push({ label: s.label, reason: s.reason });
    byCategory.set(s.category, arr);
  }

  const unreadableCount = byCategory.get("unreadable")?.length ?? 0;
  const total = report.skips.length - unreadableCount;
  console.log("");
  if (total > 0) {
    console.log(
      `⚠ ${total} metadata ${total === 1 ? "type was" : "types were"} skipped during this ingest.`,
    );
    console.log("  The rest of the graph completed successfully — these types are simply absent.");
  }
  if (unreadableCount > 0) {
    console.log(
      `⚠ ${unreadableCount} metadata ${unreadableCount === 1 ? "type (or some of its members)" : "types (or some of their members)"} could not be read: the org refused them (unreadable — see below).`,
    );
  }

  if (byCategory.has("insufficient_access")) {
    const list = byCategory.get("insufficient_access") ?? [];
    console.log("");
    console.log(`  Insufficient access (${list.length}):`);
    for (const s of list) console.log(`    • ${s.label}: ${bulletReason(s)}`);
    console.log("");
    console.log("  How to fix permanently:");
    console.log("    1. Have an admin assign your user a permission set with:");
    console.log("         - 'Modify Metadata Through Metadata API Functions'");
    console.log("         - 'View All Data' (or assign the System Administrator profile)");
    console.log("    2. Re-run with --rebuild to pick up the now-accessible types:");
    console.log(`         sfgraph ingest --org ${orgAlias} --rebuild`);
    console.log("    Note: if you ARE already an admin and still see this, it usually means the");
    console.log(
      "    extractor is hitting a system entity that doesn't expose CustomObject metadata.",
    );
    console.log("    File an issue with the error text above so we can deny-list the entity.");
  }

  if (byCategory.has("rate_limit")) {
    const list = byCategory.get("rate_limit") ?? [];
    console.log("");
    console.log(`  Rate-limited (${list.length}):`);
    for (const s of list) console.log(`    • ${s.label}`);
    console.log("    How to fix: wait for the API quota to refresh, then re-fetch ONLY these");
    console.log("    sources (no full rebuild needed):");
    console.log(`         sfgraph ingest --org ${orgAlias} --retry-skipped`);
    console.log("    The previous skip report is persisted at <dataDir>/<orgId>.skips.json.");
  }

  if (byCategory.has("not_found")) {
    const list = byCategory.get("not_found") ?? [];
    console.log("");
    console.log(`  Not retrievable in this org (${list.length}):`);
    for (const s of list) console.log(`    • ${s.label}`);
    console.log("    These types were advertised by describeMetadata() but the org refuses to");
    console.log("    return data for them — usually deprecated or feature-gated. Safe to ignore.");
  }

  if (byCategory.has("network")) {
    const list = byCategory.get("network") ?? [];
    console.log("");
    console.log(`  Network errors (${list.length}):`);
    for (const s of list) console.log(`    • ${s.label}: ${bulletReason(s)}`);
    console.log("    How to fix: check connectivity to your org and re-run.");
  }

  if (byCategory.has("unreadable")) {
    const list = byCategory.get("unreadable") ?? [];
    console.log("");
    console.log(
      `  Unreadable (org refused; re-run with --retry-skipped to try again) (${list.length}):`,
    );
    for (const s of list) console.log(`    • ${s.label}: ${bulletReason(s)}`);
    console.log("    The org rejected these reads as invalid, or returned the same error on");
    console.log("    repeated reads, so they were not auto-retried in this run. To try again:");
    console.log(`         sfgraph ingest --org ${orgAlias} --retry-skipped`);
  }

  if (byCategory.has("unknown")) {
    const list = byCategory.get("unknown") ?? [];
    console.log("");
    console.log(`  Other (${list.length}):`);
    for (const s of list) console.log(`    • ${s.label}: ${bulletReason(s)}`);
  }
  console.log("");
}

/**
 * Build the text embedded for a node's semantic vector. Beyond the
 * label/qname/description baseline, this folds in CONFIG VALUES so
 * `find_similar` matches on what a config artifact actually resolves to —
 * a Custom Metadata record's field values, a Custom Label's text, a Custom
 * Setting's rows. Without this, searching "endpoint for product push" can't
 * reach `Endpoint_Url.ProductPush_Acme` because only its name was embedded.
 * Exported for tests.
 */
export function buildEmbedText(
  label: string,
  qname: string,
  attributes: Record<string, unknown> | undefined,
): string {
  const a = attributes ?? {};
  const parts = [`${label}: ${qname}`];
  // Word-split the identifier so semantic search matches on word boundaries
  // (`account controller` → AccountController, `customer tier` → Customer_Tier__c).
  // Only the name part after the label prefix; skip if it adds nothing.
  const namePart = qname.includes(":") ? qname.slice(qname.indexOf(":") + 1) : qname;
  const words = tokenizeIdentifier(namePart);
  if (words && words !== namePart.toLowerCase()) parts.push(words);
  if (typeof a.description === "string" && a.description) parts.push(a.description);

  // Custom Metadata record field values: [{field,value}] | {field:value} | object.
  const values = a.values;
  if (Array.isArray(values)) {
    for (const v of values) {
      const f = (v as { field?: unknown }).field;
      const val = (v as { value?: unknown }).value;
      if (f != null && val != null) parts.push(`${String(f)} = ${stringifyConfigVal(val)}`);
    }
  } else if (values && typeof values === "object") {
    for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
      if (v != null && v !== "") parts.push(`${k} = ${stringifyConfigVal(v)}`);
    }
  }

  // Custom Label text value.
  if (typeof a.value === "string" && a.value) parts.push(a.value);

  // Custom Setting rows: array of row objects (field=value per row).
  const rows = a.customSettingRows;
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (row && typeof row === "object") {
        const kv = Object.entries(row as Record<string, unknown>)
          .filter(([, v]) => v != null && v !== "")
          .map(([k, v]) => `${k}=${stringifyConfigVal(v)}`)
          .join(", ");
        if (kv) parts.push(kv);
      }
    }
  }

  // Structural attributes that make automation findable by WHAT it acts on:
  // a trigger's object + DML events ("on Account before insert"), a Flow's
  // process type ("AutoLaunchedFlow"/"Flow"). Gated by label — CustomField (and
  // other nodes) also carry an `object` attribute (their parent SObject), and
  // appending "on Account" to every field was pure noise in the embedding.
  if (label === "ApexTrigger" && typeof a.object === "string" && a.object) {
    const ev = Array.isArray(a.events)
      ? (a.events as unknown[]).filter((x): x is string => typeof x === "string").join(" ")
      : "";
    parts.push(`on ${a.object}${ev ? ` ${ev}` : ""}`);
  }
  if (label === "Flow" && typeof a.processType === "string" && a.processType) {
    parts.push(a.processType);
  }

  return parts.join("\n");
}

function stringifyConfigVal(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

export async function liveIngest(opts: LiveIngestOpts): Promise<LiveIngestResult> {
  const logger = opts.logger ?? NOOP_LOG;
  // Load declarative rule parsers (idempotent).
  try {
    await loadAllRules();
  } catch (e) {
    logger.warn("live-ingest: rule load failed", { err: (e as Error).message });
  }
  const startedAt = Date.now();
  const resolved = opts.preResolved ?? (await resolveOrg(opts.alias, opts.resolveDeps));
  logger.info("live-ingest: resolved org", { alias: resolved.alias, orgId: resolved.orgId });

  const graph = opts.graphStore;
  const now = Date.now();
  const apiVersion = resolved.apiVersion;
  graph.upsertOrg({
    id: resolved.orgId,
    alias: resolved.alias,
    instanceUrl: resolved.instanceUrl,
    apiVersion,
    createdAt: now,
  });

  // W1.5-08: flag the org row as having an in-flight ingest before any
  // extractor work. Done after upsertOrg so the row definitely exists.
  // The matching markSyncComplete / markSyncFailed calls below are wired
  // into a try/catch around the whole ingest body so concurrent MCP
  // readers always see in_progress flip back to 0 even when ingest throws.
  // Failure to record sync-start is non-fatal — log and continue rather
  // than aborting an ingest because the bookkeeping column is unhappy.
  const ingestStartedIso = new Date(now).toISOString();
  try {
    graph.markSyncStarted(resolved.orgId, ingestStartedIso);
  } catch (e) {
    logger.warn("live-ingest: markSyncStarted failed", { err: (e as Error).message });
  }

  // Opt-in profiling (SFGRAPH_INGEST_PROFILE=<file>); no-op otherwise.
  // Created before the try so the finally can flush on failure too.
  const profiler = createIngestProfiler();
  // Embedding resources, owned here so the finally can release them on any path.
  let embedQueue: EmbeddingQueue | null = null;
  let ownedEmbedder: EmbeddingPool | null = null;
  let embedCache: EmbeddingCache | null = null;

  // W1.5-08: the rest of the ingest runs inside this try so a thrown
  // exception still flips `sync_in_progress` back to 0 via markSyncFailed.
  // Per-resolver try/catch isolation inside bulkRetrieve / live-ingest is
  // preserved — this wrapper only catches exceptions that escape *all* of
  // those inner handlers (i.e. genuinely fatal failures).
  try {
    const caps = opts.metadataSource ? OFFLINE_CAPS : await probeCapabilities(resolved.conn);
    logger.info("live-ingest: probed capabilities", { caps });

    // Discovery is also invoked implicitly inside bulkRetrieve, but logging the
    // type-count up-front gives operators a quick coverage signal.
    if (!opts.metadataSource) {
      try {
        const { discoverMetadataTypes } = await import("../extractors/live-org/discovery.js");
        const discovered = await discoverMetadataTypes(resolved.conn, apiVersion);
        logger.info("live-ingest: discovered metadata types", { count: discovered.length });
      } catch (e) {
        logger.warn("live-ingest: metadata.describe failed", { err: (e as Error).message });
      }
    }

    const existing = graph.getOrg(resolved.orgId);
    const requestedMode = opts.mode ?? "auto";
    let mode: IngestMode;
    if (opts.metadataSource) {
      mode = "full";
    } else if (requestedMode === "auto") {
      mode = existing?.lastSyncedAt && caps.sourceTracking ? "incremental" : "full";
    } else {
      mode = requestedMode;
    }
    // Incremental reads the Tooling SourceMember table, which exists only on
    // source-tracked orgs (scratch orgs, Developer / Developer Pro sandboxes
    // with tracking on). Asked for it on any other org, the query fails with
    // "sObject type 'SourceMember' is not supported" and nothing is ingested;
    // run a full sync instead, the same choice auto makes.
    let modeFallback: string | undefined;
    if (mode === "incremental" && !caps.sourceTracking) {
      mode = "full";
      modeFallback = "mode:incremental-unavailable:no-source-tracking";
      logger.warn(
        `live-ingest: ${resolved.alias} has no source tracking (no SourceMember table), so incremental is not possible here; running a full sync instead`,
      );
    }

    if (!opts.skipSnapshot && opts.snapshotStore) {
      try {
        opts.snapshotStore.createSnapshot(
          resolved.orgId,
          `pre-sync-${new Date(now).toISOString()}`,
          true,
        );
      } catch (e) {
        logger.warn("live-ingest: snapshot failed", { err: (e as Error).message });
      }
    }

    let membersProcessed = 0;
    let parseErrors = 0;
    let deletions = 0;
    // Incremental detects changed/added members but cannot fetch their content
    // yet, so it skips them. If we then advanced the watermark past them, the
    // next incremental would start AFTER those changes and never see them —
    // silent permanent data loss. Track the count so we can HOLD the watermark.
    let incrementalUnfetched = 0;
    // Set in the full-sync branch if the bulkRetrieve stream itself throws.
    // Detect-deletions reads it post-fan-out to bail out instead of mass-
    // wiping nodes that were never visited due to the abort.
    let streamAborted = false;
    const touchedQnames = new Set<string>();
    // W1.5-07: maintain per-label touched-qnames sets in parallel with the
    // flat `touchedQnames` set so the deletion-sweep guard can compute
    // priorCount/touchedCount per label without re-deriving labels later.
    const touchedQnamesByLabel = new Map<string, Set<string>>();
    // Skip/warning report collected across all branches. Populated by the
    // full-sync fan-out via bulkRetrieve's onError callback; incremental mode
    // currently emits no entries (single-stream iterChanges has no per-source
    // failure surface). Returned on LiveIngestResult.warnings so MCP consumers
    // can read what was skipped without parsing stdout.
    const skipReport: IngestSkipReport = { skips: [] };
    // Phase 1.5 W1.5-02: namespaced wedge warnings populated by bulkRetrieve's
    // soft-isolate path (`wedge:<source>:<stage>:<detail>`). Concatenated with
    // the legacy `${label}: ${reason}` strings from skipReport.skips into the
    // final LiveIngestResult.warnings array. See bulk-retrieve.ts WedgeCoordinator.
    const wedgeWarnings: string[] = [];
    if (modeFallback) wedgeWarnings.push(modeFallback);

    // Task 10 rebuild fast path. On a full ingest into an org whose graph is
    // empty at start, run the fan-out inside the store's bulk-load window:
    // deferred secondary indexes, synchronous=OFF, one transaction per 2,000
    // members, and no per-member delete probes for keys not yet written (the
    // store tracks what this run wrote, so repeats are still reconciled and
    // the graph is identical to the slow path). SFGRAPH_DISABLE_FASTPATH=1
    // forces the per-member path (used by the same-output test and gate).
    const fastPathDisabled = process.env.SFGRAPH_DISABLE_FASTPATH === "1";
    const graphEmptyAtStart =
      !fastPathDisabled &&
      mode === "full" &&
      opts.rebuild !== false &&
      typeof graph.beginBulk === "function" &&
      typeof graph.endBulk === "function" &&
      typeof graph.isOrgEmpty === "function" &&
      graph.isOrgEmpty(resolved.orgId);
    // A vector store on its own connection would hit SQLITE_BUSY behind the
    // held bulk transaction, so keep per-member commits in that case.
    const vectorDb = (opts.vectorStore as { db?: unknown } | undefined)?.db;
    const graphDb = (graph as unknown as { db?: unknown }).db;
    const sharedConnection = vectorDb === undefined || vectorDb === graphDb;
    // Every other full ingest (a normal sync, a delta's merge) writes into a
    // graph that MCP servers may be reading, so the bulk window's relaxed
    // pragmas and dropped indexes are not an option. It still groups members
    // into plain transactions (store.beginBatch: BEGIN IMMEDIATE, committed
    // only between members, at most ~200 ms each), which removes most of the
    // per-member commit cost. Same SQLITE_BUSY rule as the bulk window: a
    // vector store on its own connection keeps per-member commits.
    const batchWrites =
      !fastPathDisabled &&
      !graphEmptyAtStart &&
      mode === "full" &&
      sharedConnection &&
      typeof graph.beginBatch === "function" &&
      typeof graph.endBatch === "function";
    let bulkOpen = false;
    let batchOpen = false;
    let bulkFailure: Error | null = null;
    const openBulk = (): void => {
      if (graphEmptyAtStart && !bulkOpen) {
        graph.beginBulk?.({
          freshOrgId: resolved.orgId,
          ...(sharedConnection ? {} : { batchTransactions: false }),
        });
        bulkOpen = true;
      } else if (batchWrites && !batchOpen) {
        try {
          graph.beginBatch?.();
          batchOpen = true;
        } catch (e) {
          // e.g. the caller holds a transaction: keep per-member commits.
          logger.debug("live-ingest: write batching unavailable", { err: (e as Error).message });
        }
      }
    };
    const closeBulk = (): void => {
      if (batchOpen) {
        batchOpen = false;
        graph.endBatch?.();
      }
      if (!bulkOpen) return;
      bulkOpen = false;
      graph.endBulk?.();
    };

    const parseCtxBase: Omit<ParseContext, "sourceUri"> = {
      orgId: resolved.orgId,
      parseTimestamp: new Date(now).toISOString(),
      namespace: null,
      logger,
    };

    // Task 11a: embeddings run off the graph-ready path. Inference happens in
    // a worker thread (compiled builds) or an injected embedder, with up to 4
    // batches in flight to keep it fed. The queue is HELD until graph ready:
    // texts buffer (bounded by backpressure, which still forces batches out)
    // and no inference competes for CPU with the graph build — measured, an
    // overlapping worker slowed fan-out by ~45%. A persistent text → vector
    // cache makes --rebuild skip the model for unchanged texts. The org is flagged `embeddings_pending` until every
    // vector is written, so find_similar can fall back to text search and the
    // next ingest can fill whatever a no-wait / failed run left behind. The
    // flag is set lazily, when the queue first has real vector work (a text
    // past the unchanged check at dispatch, or live work abandoned), so a
    // re-sync with nothing to embed keeps find_similar's vector leg on.
    let embedError: Error | null = null;
    let wasEmbeddingsPending = false;
    if (opts.vectorStore) {
      const workerUrl = opts.embedder ? null : defaultEmbeddingWorkerUrl();
      ownedEmbedder = opts.embedder ? null : workerUrl ? new EmbeddingPool({ workerUrl }) : null;
      const embedder = opts.embedder ?? ownedEmbedder;
      if (opts.embeddingCacheFile) {
        try {
          embedCache = EmbeddingCache.open(opts.embeddingCacheFile);
        } catch (e) {
          logger.warn("live-ingest: embedding cache unavailable", { err: (e as Error).message });
        }
      }
      wasEmbeddingsPending = graph.getEmbeddingStatus?.(resolved.orgId)?.pending ?? false;
      const maxPendingChars = Number.parseInt(
        process.env.SFGRAPH_EMBED_MAX_PENDING_CHARS ?? "",
        10,
      );
      embedQueue = new EmbeddingQueue({
        vectorStore: opts.vectorStore,
        hold: true,
        ...(maxPendingChars > 0 ? { maxPendingChars } : {}),
        onWork: () => {
          if (!wasEmbeddingsPending) graph.setEmbeddingsPending?.(resolved.orgId, true);
        },
        onCacheError: (err) => {
          logger.warn("live-ingest: embedding cache write failed", { err: err.message });
        },
        ...(embedder ? { embed: (t: string[]) => embedder.embed(t), maxInFlight: 4 } : {}),
        ...(embedCache ? { cache: embedCache as EmbeddingCacheLike } : {}),
        onError: (err) => {
          if (!embedError) embedError = err;
          logger.warn("live-ingest: embedding batch failed", { err: err.message });
        },
      });
    }

    const handleParsed = (parsed: ParseResult): void => {
      if (parsed.nodes.length) {
        graph.mergeNodes(parsed.nodes);
        for (const n of parsed.nodes) {
          const qn = String(n.qualifiedName);
          touchedQnames.add(qn);
          // W1.5-07: also bucket by label for the per-label deletion guard.
          let bucket = touchedQnamesByLabel.get(n.label);
          if (!bucket) {
            bucket = new Set<string>();
            touchedQnamesByLabel.set(n.label, bucket);
          }
          bucket.add(qn);
        }
      }
      // A parser's ParseResult is the COMPLETE authoritative outgoing-edge set
      // for the member it parsed, so reconcile: prune any prior outgoing edge
      // from these sources that the member no longer emits (fixes "immortal
      // edges" — a SOQL/DML/CALLS that lingered after the code dropped it on a
      // non-rebuild re-sync). Resolver post-passes (arity / overlap / reflection)
      // re-add their cross-cutting edges afterward, so this is safe.
      // N-5: a method the member still emits but that now has NO outgoing
      // edge (its only call was removed) is not a source in `parsed.edges`,
      // so it is named explicitly and its stale edges are pruned too.
      const methodSrcs: string[] = [];
      for (const n of parsed.nodes) {
        if (n.label === "ApexMethod" || n.label === "TestMethod") {
          methodSrcs.push(String(n.qualifiedName));
        }
      }
      if (parsed.edges.length || methodSrcs.length) {
        graph.mergeEdges(parsed.edges, {
          reconcileSources: true,
          ...(methodSrcs.length
            ? { reconcileExtraSrcs: { orgId: resolved.orgId, qnames: methodSrcs } }
            : {}),
        });
      }
      if (parsed.snippets?.length) {
        graph.transaction(() => {
          for (const s of parsed.snippets ?? []) {
            graph.upsertSnippet(s);
          }
        });
      }
      // Fold the stored source snippet into the search text for code nodes so
      // search matches on what the code DOES, not just its name/attrs. (The
      // snippet text lives in parsed.snippets, not on the node.) Bounded to a
      // few KB — MiniLM truncates to its token window anyway, and we keep the
      // structured buildEmbedText prefix first so identity stays dominant. The
      // SAME text feeds both the vector index and the FTS keyword index; FTS is
      // populated regardless of embedQueue so it works as the embedder-down
      // fallback leg of hybrid search.
      if (parsed.nodes.length) {
        const snippetByQname = new Map<string, string>();
        for (const s of parsed.snippets ?? []) {
          snippetByQname.set(String(s.qualifiedName), s.sourceText);
        }
        for (const n of parsed.nodes) {
          const qn = String(n.qualifiedName);
          let text = buildEmbedText(n.label, qn, n.attributes);
          const snippet = snippetByQname.get(qn);
          if (snippet) text += `\n${snippet.slice(0, 4000)}`;
          graph.upsertNodeFts(n.orgId, n.qualifiedName, n.label, text);
          if (embedQueue) {
            embedQueue.push({ qname: qn, text, orgId: String(n.orgId), label: n.label });
          }
        }
      }
    };

    // Purge a deleted node's vector so it stops surfacing as a phantom
    // find_similar hit. The vec0 table lives in the VectorStore (not the graph
    // store); feature-detect since lightweight sinks may not implement delete.
    const purgeNodeVector = (qname: QualifiedName): void => {
      const sink = opts.vectorStore;
      if (sink && typeof sink.deleteNodeVector === "function") {
        try {
          sink.deleteNodeVector(resolved.orgId, qname);
        } catch (e) {
          logger.warn("live-ingest: vector purge failed", {
            qname: String(qname),
            err: (e as Error).message,
          });
        }
      }
    };

    const debugProcess = process.env.SFGRAPH_DEBUG_INGEST === "1";
    // Per-member timings, filled by applyMember (parse vs. store write) and
    // consumed by the member loop. Reset on every call. These are shared
    // closure state: applyMember must NOT be called concurrently.
    let lastParseMs = 0;
    let lastWriteMs = 0;
    // Apply one member's parse outcome to the graph (or delete an obsolete
    // member). Always on the main thread, in member order: the parse may have
    // run in a worker (parsePool), the writes never do.
    const applyMember = (ref: MemberRef, outcome: MemberParse): void => {
      const qnameForLog = `${ref.memberType}:${ref.memberName}`;
      lastParseMs = 0;
      lastWriteMs = 0;
      if (ref.obsolete) {
        // Build the qname with the node's LABEL, not the raw SourceMember type:
        // e.g. LightningComponentBundle is stored as `LWC:<name>`, so the old
        // `${memberType}:${name}` never matched and LWC deletes were silent
        // no-ops. Fall back to memberType when no mapping exists.
        const label = MEMBER_TYPE_TO_NODE_LABEL[ref.memberType] ?? ref.memberType;
        const qname = asQualifiedName(`${label}:${ref.memberName}`);
        if (debugProcess) console.log(`ingest: [trace] delete ← ${qnameForLog}`);
        // Cascade to contained children (a class/trigger owns ApexMethod /
        // TestMethod nodes via CONTAINS_METHOD). Deleting only the parent left
        // the method nodes — and their edges/snippets/vectors — orphaned.
        for (const e of graph.listEdgesFrom(resolved.orgId, qname, REL_TYPES.CONTAINS_METHOD)) {
          const child = e.dstQualifiedName;
          graph.deleteEdgesFor(resolved.orgId, child);
          graph.deleteNode(resolved.orgId, child);
          purgeNodeVector(child);
        }
        graph.deleteEdgesFor(resolved.orgId, qname);
        graph.deleteNode(resolved.orgId, qname);
        purgeNodeVector(qname);
        if (debugProcess) console.log(`ingest: [trace] delete ✓ ${qnameForLog}`);
        deletions += 1;
        return;
      }
      // Building the parser input threw: surfaces to the member loop's catch.
      if (outcome.kind === "error" && outcome.phase === "adapt") throw new Error(outcome.message);
      if (outcome.kind === "skip") return;
      // Emitted when the result is applied (in member order); the parse itself
      // may have run earlier in a worker.
      if (debugProcess) console.log(`ingest: [trace] parse ← ${qnameForLog}`);
      lastParseMs = outcome.parseMs;
      try {
        if (outcome.kind === "error") {
          const err = new Error(outcome.message);
          if (outcome.stack) err.stack = outcome.stack;
          throw err;
        }
        const result = outcome.result;
        if (debugProcess)
          console.log(
            `ingest: [trace] parse ✓ ${qnameForLog} (nodes=${result.nodes.length} edges=${result.edges.length})`,
          );
        if (debugProcess) console.log(`ingest: [trace] graph-merge ← ${qnameForLog}`);
        const tWrite = performance.now();
        try {
          handleParsed(result);
        } finally {
          lastWriteMs = performance.now() - tWrite;
        }
        if (debugProcess) console.log(`ingest: [trace] graph-merge ✓ ${qnameForLog}`);
        membersProcessed += 1;
      } catch (e) {
        parseErrors += 1;
        logger.warn("live-ingest: parser failure", {
          type: ref.memberType,
          name: ref.memberName,
          err: (e as Error).message,
        });
        if (debugProcess) {
          console.error(
            `ingest: [trace] FAILURE ${qnameForLog}: ${(e as Error).message}\n${(e as Error).stack}`,
          );
        }
      }
    };
    // Task 11c: member rows (delta ingest's record of what each member owns)
    // and the ghost sweep, on a full ingest of a metadataSource. The rows are
    // cleared now and rewritten only once the ingest completes, so an
    // interrupted run leaves no rows and the next delta falls back to a full
    // rebuild. The ghost sweep deletes what a member owned last run that no
    // member owns now (a deleted / renamed file), before the resolvers run.
    if (opts.delta && (!opts.metadataSource || mode !== "full")) {
      throw new Error("liveIngest: delta hooks need a metadataSource and mode 'full'");
    }
    const deltaHooks = opts.delta;
    const priorRows =
      !deltaHooks &&
      opts.metadataSource &&
      mode === "full" &&
      graph.listMemberRows &&
      graph.replaceMemberRows
        ? graph.listMemberRows(resolved.orgId)
        : null;
    if (priorRows && priorRows.length > 0) graph.clearMemberRows?.(resolved.orgId);
    const memberRows: Map<string, MemberRow> | null = priorRows ? new Map() : null;
    const priorRowByKey = new Map((priorRows ?? []).map((r) => [r.key, r]));
    const keptPrior: string[] = [];
    // T15 N5-1: members quarantined by earlier runs (workers kept failing on
    // that exact content) are not parsed again until their content changes.
    const quarantinedKeys = new Set(
      (priorRows ?? []).filter((r) => isQuarantinedRow(r)).map((r) => r.key),
    );
    const quarantinePreset = (m: RawMember): MemberParse | undefined =>
      quarantinedKeys.has(m.ref.sourceUri) &&
      isQuarantinedFor(priorRowByKey.get(m.ref.sourceUri), memberContentHash(m.content))
        ? quarantinedOutcome()
        : undefined;
    const recordMemberRow = (member: RawMember, outcome: MemberParse, errored: boolean): void => {
      if (!memberRows) return;
      const key = member.ref.sourceUri;
      const prior = priorRowByKey.get(key);
      const owned = outcome.kind === "parsed" ? ownedQnames(outcome.result) : [];
      if (errored || (isParseFailureOnly(owned) && hasGoodPriorOwned(prior))) {
        // Keep what it owned (its nodes are not re-emitted, nor swept). A
        // member that parsed to ParseError only (N2-1) or whose parse threw
        // records the hash of its broken content and is skipped until it
        // changes; one whose merge failed is retried by every delta.
        if (hasGoodPriorOwned(prior)) keptPrior.push(key);
        memberRows.set(key, {
          key,
          ...memberFailureStamp(member, outcome, errored, prior),
          owned: [...new Set([...(prior?.owned ?? []), ...owned])],
        });
        return;
      }
      memberRows.set(key, {
        key,
        fingerprint: member.fingerprint ?? "",
        hash: memberContentHash(member.content),
        owned,
      });
    };
    const finishMemberRows = (): void => {
      if (!memberRows || !priorRows) return;
      if (streamAborted) {
        memberRows.clear();
        return;
      }
      if (priorRows.length === 0) return;
      // Members the source indexed but could not load (unreadable, malformed)
      // keep their previous graph and row (retried by the next delta).
      const unloaded = opts.metadataSource?.unloadedKeys?.();
      if (unloaded) {
        for (const r of priorRows) {
          if (!unloaded.has(r.key) || memberRows.has(r.key)) continue;
          memberRows.set(r.key, { ...r, fingerprint: "" });
          keptPrior.push(r.key);
        }
      }
      if (keptPrior.length > 0) {
        wedgeWarnings.push(`wedge:ingest:kept-prior:members=${keptPrior.length}`);
        logger.warn("live-ingest: unreadable / unparseable members keep their previous graph", {
          members: keptPrior.slice(0, 20),
        });
      }
      if (memberRows.size === 0) {
        // Same guard as detect-deletions' empty-stream refusal: a source that
        // yielded no members at all (wrong path, unreadable tree) must not
        // wipe the graph. No rows are written, so the next delta rebuilds.
        wedgeWarnings.push(
          `wedge:ghost-sweep:refuse:reason=empty-stream:priorMembers=${priorRows.length}`,
        );
        logger.warn("live-ingest: ghost sweep refused (the source yielded no members)", {
          priorMembers: priorRows.length,
        });
        return;
      }
      // Qnames match case-insensitively (the store's NOCASE): `ApexClass:Util`
      // re-emitted as `ApexClass:UTIL` is the same node, not a ghost.
      const ownedNow = new Set<string>();
      for (const r of memberRows.values()) for (const q of r.owned) ownedNow.add(q.toLowerCase());
      const ghosts: string[] = [];
      for (const r of priorRows) {
        for (const q of r.owned) if (!ownedNow.has(q.toLowerCase())) ghosts.push(q);
      }
      if (ghosts.length === 0) return;
      let removed = 0;
      graph.transaction(() => {
        graph.deleteEdgesFrom?.(resolved.orgId, ghosts);
        graph.deleteReflectionEdges?.(resolved.orgId, { dsts: ghosts });
        for (const q of new Set(ghosts)) {
          const qn = asQualifiedName(q);
          if (!graph.getNode(resolved.orgId, qn)) continue;
          graph.deleteNode(resolved.orgId, qn);
          purgeNodeVector(qn);
          removed += 1;
        }
      });
      deletions += removed;
      if (removed > 0)
        logger.info("live-ingest: ghost sweep removed nodes of vanished members", { removed });
    };

    // Serial parse + apply (incremental deletions).
    const processOne = async (ref: MemberRef, content: string): Promise<void> => {
      const outcome: MemberParse = ref.obsolete
        ? { kind: "skip", parseMs: 0 }
        : await parseMember(ref, content, parseCtxBase, logger);
      applyMember(ref, outcome);
    };

    if (mode === "incremental") {
      const sinceIso = existing?.lastSyncedAt
        ? new Date(existing.lastSyncedAt).toISOString()
        : new Date(now - 24 * 3600 * 1000).toISOString();
      // Incremental applies DELETIONS (obsolete members need no content) but
      // does NOT re-parse changed/added members: their content is not fetched
      // here, and calling processOne(ref, "") would overwrite real node
      // attributes with empty-parse garbage and emit no edges — actively
      // degrading the graph. Until per-member content fetch lands, changed
      // members are counted and the user is told to run a full ingest to
      // refresh them. (Deletions are still valuable and safe.)
      let changedNotApplied = 0;
      for await (const ref of iterChanges(resolved.conn, resolved.orgId, sinceIso)) {
        if (ref.obsolete) {
          await processOne(ref, "");
        } else {
          changedNotApplied += 1;
        }
      }
      incrementalUnfetched = changedNotApplied;
      if (changedNotApplied > 0) {
        const msg = `incremental: ${changedNotApplied} changed/added member(s) detected but NOT refreshed (content fetch not implemented for incremental). The sync watermark is being HELD so the next run re-detects them. Run \`sfgraph ingest --org ${resolved.alias} --rebuild\` (or --mode full) to capture them.`;
        logger.warn(msg);
        wedgeWarnings.push(`incremental:contentNotFetched:count=${changedNotApplied}`);
      }
    } else {
      // The outer iteration is also wrapped: bulkRetrieve uses fail-soft per
      // source, but a top-level catch protects against any iterator-protocol
      // surprises (e.g. generator throws during `next()` before yielding).
      // Read live pool caps so the log reflects --tooling-pool/--metadata-pool/
      // --data-pool overrides or SFGRAPH_*_POOL env vars rather than hardcoded
      // defaults.
      const { toolingPool, metadataPool, dataPool } = await import(
        "../extractors/live-org/rate-limit.js"
      );
      const tCap = (
        toolingPool as unknown as { _store: { storeOptions: { maxConcurrent: number } } }
      )._store.storeOptions.maxConcurrent;
      const mCap = (
        metadataPool as unknown as { _store: { storeOptions: { maxConcurrent: number } } }
      )._store.storeOptions.maxConcurrent;
      const dCap = (dataPool as unknown as { _store: { storeOptions: { maxConcurrent: number } } })
        ._store.storeOptions.maxConcurrent;
      console.log(
        `ingest: starting full sync (Tooling pool ${tCap} / Metadata pool ${mCap} / Data pool ${dCap} concurrent)`,
      );

      // MCD baseline runs BEFORE the parser fan-out so any (src, dst, REFERENCES)
      // edges it writes can be overwritten if a real parser produces the same
      // shape later. The MCD path uses generic REFERENCES while parsers use
      // specific rel-types — so in practice MCD and parsed coexist in
      // different edge tables rather than competing for the same row, but
      // the pre-fan-out ordering preserves the "parsed wins" guarantee for
      // the (rare) case where a parser does emit REFERENCES.
      openBulk();
      if (!opts.disableMcdBaseline && !opts.metadataSource) {
        try {
          const { runMcdBaseline } = await import(
            "../extractors/live-org/extractors/mcd-baseline.js"
          );
          const mcdCtx: ParseContext = {
            ...parseCtxBase,
            sourceUri: "mcd-baseline://tooling-soql",
          };
          const mcd = await runMcdBaseline(resolved.conn, {
            orgId: resolved.orgId,
            ctx: mcdCtx,
            onError: (label, err) => {
              skipReport.skips.push({
                label,
                reason: err.message,
                category: "unknown",
              });
            },
          });
          if (mcd.edges.length > 0) {
            graph.mergeEdges(mcd.edges);
          }
          logger.info("live-ingest: MCD baseline complete", {
            edges: mcd.edges.length,
            byType: mcd.byType,
          });
        } catch (e) {
          logger.warn("live-ingest: MCD baseline failed", { err: (e as Error).message });
        }
      }

      const fanOutStart = Date.now();
      let progressCount = 0;
      let lastTickAt = Date.now();
      let lastActivityAt = Date.now();
      let lastMemberLabel = "(none)";
      const PROGRESS_TICK_MS = 5000; // emit a heartbeat at least every 5s
      if (opts.onlyLabels && opts.onlyLabels.size > 0) {
        console.log(
          `ingest: --only filter active (${opts.onlyLabels.size} source${opts.onlyLabels.size === 1 ? "" : "s"}): ${[...opts.onlyLabels].join(", ")}`,
        );
      }
      // Debug mode: SFGRAPH_DEBUG_INGEST=1 enables a heartbeat timer that
      // prints heap usage + seconds-since-last-activity every 10s. Critical
      // for diagnosing silent ingest deaths (OOM, native segfault, hung SF
      // call) where the normal progress log just stops without an error.
      const debug = process.env.SFGRAPH_DEBUG_INGEST === "1";
      let heartbeatTimer: NodeJS.Timeout | null = null;
      let keepAlive: NodeJS.Timeout | null = null;
      let livenessProbe: LivenessProbeHandle | null = null;
      // Track signal handlers we register so we can remove them in finally.
      // Without this, every invocation of liveIngest in debug mode leaked one
      // listener per signal (SIGTERM/SIGINT/SIGUSR2), eventually triggering
      // MaxListenersExceededWarning and N-fold handler firing on first ^C in
      // multi-org / programmatic flows. (Audit finding C2.)
      const installedSignalHandlers: Array<{ sig: NodeJS.Signals; fn: () => void }> = [];
      // streamAborted (hoisted at function scope) gates the post-fan-out
      // detect-deletions block. If the bulkRetrieve stream itself throws
      // (vs individual sources fail-softing), we've only seen a fraction of
      // the org and the `touchedQnames` set is not safe to use for stale-
      // qname computation — without this guard a transient SF error would
      // mass-delete the untouched 70% of the graph. (Audit finding C1.)
      try {
        // Keep-alive sentinel: a ref'd timer that exists purely to prevent the
        // event loop from draining while we're awaiting Bottleneck-scheduled
        // work. Bottleneck's local-datastore reservoir-refresh timer is unref'd
        // internally, jsforce's HTTP keep-alive sockets idle between requests,
        // and Node will happily exit(0) on a perfectly healthy pending Promise
        // if no ref'd handle is left.
        keepAlive = setInterval(() => {}, 60_000);
        // Background liveness probe. Polls conn.identity() every 30s with a
        // 10s deadline; after two consecutive failures it logs a prominent
        // "CONNECTION LOST" warning so the user knows why surviving
        // extractors are about to time out one by one. We intentionally do
        // NOT abort the ingest from here — per-call 60s timeouts (added in
        // 1.1.3) already cap exposure, and aborting mid-flight would need
        // an AbortSignal threaded through every extractor for marginal
        // benefit. The probe's job is observability, not control flow.
        // Disable via SFGRAPH_NO_LIVENESS_PROBE=1 for hermetic test runs
        // where the mock connection has no identity() implementation.
        if (process.env.SFGRAPH_NO_LIVENESS_PROBE !== "1" && !opts.metadataSource) {
          livenessProbe = startLivenessProbe(resolved.conn as { identity: () => Promise<unknown> });
        }
        // Wall-clock heartbeat — always on. Without this, silent phases (where
        // all in-window sources are awaiting Bottleneck-queued metadata reads
        // without yielding) look indistinguishable from a hung process. The
        // per-record progress tick at the bottom of the fan-out loop only
        // fires when a record arrives; this fires on a real timer regardless.
        // Debug mode adds heap/rss; baseline shows processed/lastSource/idle.
        const showPoolCounters = debug || process.env.SFGRAPH_DEBUG_POOLS === "1";
        heartbeatTimer = setInterval(() => {
          const idleSec = Math.round((Date.now() - lastActivityAt) / 1000);
          if (idleSec < 10) return; // suppress chatter when records are flowing
          if (debug) {
            const mem = process.memoryUsage();
            const heapMb = Math.round(mem.heapUsed / 1024 / 1024);
            const rssMb = Math.round(mem.rss / 1024 / 1024);
            const externalMb = Math.round(mem.external / 1024 / 1024);
            console.log(
              `ingest: [heartbeat] processed=${progressCount} lastSource=${lastMemberLabel} idle=${idleSec}s heap=${heapMb}MB rss=${rssMb}MB ext=${externalMb}MB`,
            );
          } else {
            console.log(
              `ingest:   …still working — processed=${progressCount} idle=${idleSec}s lastSource=${lastMemberLabel}`,
            );
          }
          // Pool diagnostics: snapshot Bottleneck state so a wedge can be
          // attributed concretely to reservoir starvation vs. stuck-in-flight
          // jobs vs. pre-yield iterator hangs. Counts are synchronous; the
          // reservoir read is async but fire-and-forget — by the time it
          // resolves we just log it.
          if (showPoolCounters) {
            const snapshot = [
              ["tool", toolingPool],
              ["meta", metadataPool],
              ["data", dataPool],
            ] as const;
            for (const [name, p] of snapshot) {
              const c = p.counts();
              p.currentReservoir().then(
                (reservoir) => {
                  console.log(
                    `ingest: [pool ${name}] running=${c.RUNNING} executing=${c.EXECUTING} queued=${c.QUEUED} received=${c.RECEIVED} reservoir=${reservoir}`,
                  );
                },
                () => {
                  /* swallow — never let a diag failure kill ingest */
                },
              );
            }
          }
        }, 10_000);
        if (debug) {
          console.log("ingest: [debug] SFGRAPH_DEBUG_INGEST=1 active — heartbeat every 10s");
          // Signal handlers — surface what was running when the user (or OS)
          // sends a kill so silent terminations have at least one breadcrumb.
          const onSig = (sig: string) => () => {
            console.error(
              `ingest: [debug] received ${sig} after ${Math.round((Date.now() - fanOutStart) / 1000)}s — processed=${progressCount} lastSource=${lastMemberLabel}`,
            );
            console.error(new Error(`signal:${sig}`).stack);
            process.exitCode = 130;
            // rel-08: a breadcrumb only — never swallow the signal. Drop the
            // debug handlers; if nothing else handles it (an embedding host
            // or the CLI would), re-raise so the default action terminates.
            // Review minor 12: on the library path the default action kills
            // the process without the finally blocks, so the ingest lock file
            // and sync_in_progress stay behind; the next run reclaims both
            // through the dead-owner (stale pid) check (rel-02).
            for (const h of installedSignalHandlers.splice(0)) process.off(h.sig, h.fn);
            if (process.listenerCount(sig) === 0) process.kill(process.pid, sig as NodeJS.Signals);
          };
          const onUsr2 = () => {
            const mem = process.memoryUsage();
            console.error(
              `ingest: [debug] SIGUSR2 — heap=${Math.round(mem.heapUsed / 1024 / 1024)}MB rss=${Math.round(mem.rss / 1024 / 1024)}MB lastSource=${lastMemberLabel}`,
            );
          };
          installedSignalHandlers.push({ sig: "SIGTERM", fn: onSig("SIGTERM") });
          installedSignalHandlers.push({ sig: "SIGINT", fn: onSig("SIGINT") });
          installedSignalHandlers.push({ sig: "SIGUSR2", fn: onUsr2 });
          for (const h of installedSignalHandlers) process.on(h.sig, h.fn);
        }
        try {
          const memberStream: AsyncIterable<RawMember> = deltaHooks
            ? deltaHooks.members
            : opts.metadataSource
              ? opts.metadataSource.iter()
              : bulkRetrieve(resolved.conn, caps, resolved.orgId, {
                  skipReport,
                  warnings: wedgeWarnings,
                  ...(opts.onlyLabels ? { onlyLabels: opts.onlyLabels } : {}),
                  ...(opts.explicitOnlyLabels ? { explicitOnlyLabels: true } : {}),
                  // The bulk-retrieve flag name follows the same convention as
                  // the bulk-retrieve's other opts; semantically it's "do the
                  // retrieve()" which is now on by default. Caller-side disable
                  // routes through this same boolean inverted.
                  ...(opts.disableOmnistudioRetrieve ? {} : { enableOmnistudioRetrieve: true }),
                  // jsforce attaches the version it negotiated on conn.version; fall
                  // back to a sensible recent release if absent (mocks, etc.)
                  apiVersion: (resolved.conn as { version?: string }).version ?? "60.0",
                });
          const tFanout = performance.now();
          // Task 11b: parse in worker threads (SFGRAPH_PARSE_WORKERS, default
          // min(4, availableParallelism - 1); 0 = main thread), apply in member
          // order here.
          const parseStats: ParsePoolStats = opts.parsePool?.stats ?? {
            workers: 0,
            pooled: 0,
            inProcess: 0,
            fallbacks: 0,
            crashes: 0,
            oomFallbacks: 0,
          };
          const parsed = parsePool(memberStream, {
            orgId: parseCtxBase.orgId,
            parseTimestamp: parseCtxBase.parseTimestamp,
            logger,
            workers: opts.parsePool?.workers ?? resolveParseWorkers(),
            ...(opts.parsePool?.workerUrl !== undefined
              ? { workerUrl: opts.parsePool.workerUrl }
              : {}),
            ...(opts.parsePool?.minMembers !== undefined
              ? { minMembers: opts.parsePool.minMembers }
              : {}),
            stats: parseStats,
            ...(quarantinedKeys.size > 0 ? { preset: quarantinePreset } : {}),
          });
          for await (const { member, outcome } of parsed) {
            const errorsBefore = parseErrors;
            if (batchOpen) graph.batchMemberStart?.();
            try {
              applyMember(member.ref, outcome);
              if (profiler.enabled) {
                profiler.member({
                  qname: `${member.ref.memberType}:${member.ref.memberName}`,
                  label: member.ref.memberType,
                  bytes: member.content.length,
                  parseMs: lastParseMs,
                  writeMs: lastWriteMs,
                });
              }
            } catch (e) {
              parseErrors += 1;
              logger.warn("live-ingest: processOne failed", {
                qname: `${member.ref.memberType}:${member.ref.memberName}`,
                error: (e as Error).message,
              });
            }
            // Task 11c: member rows (what each member owns) for delta ingest.
            const errored = outcome.kind === "error" || parseErrors > errorsBefore;
            if (deltaHooks) deltaHooks.onMember(member, outcome, errored);
            else if (memberRows && member.fingerprint !== undefined) {
              recordMemberRow(member, outcome, errored);
            }
            if (bulkOpen || batchOpen) {
              // Outside the per-member catch: if SQLite rolled back the bulk
              // transaction (SQLITE_FULL / IOERR / NOMEM), up to 2,000 earlier
              // members are gone, so the ingest must fail, not count one error.
              // The same holds for a live-graph batch.
              try {
                if (bulkOpen) graph.bulkMemberDone?.();
                else graph.batchMemberDone?.();
              } catch (e) {
                bulkFailure = e as Error;
                break;
              }
            }
            // Backpressure: past the queued-text bound, wait for forced
            // batches to drain (the only inference during fan-out).
            if (embedQueue?.overCapacity) await embedQueue.waitForCapacity();
            progressCount += 1;
            lastActivityAt = Date.now();
            lastMemberLabel = `${member.ref.memberType}:${member.ref.memberName}`;
            if (progressCount % 200 === 0 || Date.now() - lastTickAt > PROGRESS_TICK_MS) {
              const elapsedSec = Math.round((Date.now() - fanOutStart) / 1000);
              const memSuffix = debug
                ? ` heap=${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`
                : "";
              console.log(
                `ingest:   …${progressCount} members processed so far (${elapsedSec}s elapsed)${memSuffix}`,
              );
              lastTickAt = Date.now();
            }
            if (progressCount % 500 === 0) {
              const gs = graph as unknown as { checkpoint?: () => boolean };
              if (typeof gs.checkpoint === "function") gs.checkpoint();
            }
          }
          profiler.phase("fanout", performance.now() - tFanout);
          // Always printed (serial too) so bench runs can record the counts.
          console.log(
            `ingest: parse pool: ${parseStats.workers} workers, ${parseStats.pooled} parsed in workers, ${parseStats.inProcess} on main (${parseStats.fallbacks} fallbacks, ${parseStats.crashes} worker crashes, ${parseStats.oomFallbacks ?? 0} heap-cap re-parses)`,
          );
          console.log(
            `ingest: fan-out complete (${progressCount} members in ${Math.round((Date.now() - fanOutStart) / 1000)}s)`,
          );
          const gs = graph as unknown as { checkpoint?: () => boolean };
          if (typeof gs.checkpoint === "function") gs.checkpoint();
        } catch (e) {
          // The stream itself threw (not an individual source — those are
          // captured by failSoft). Mark so detect-deletions stays its hand.
          streamAborted = true;
          logger.warn("live-ingest: bulkRetrieve stream aborted", {
            error: (e as Error).message,
          });
          // Never a silent partial ingest: the abort is in the result's warnings.
          wedgeWarnings.push(`stream:aborted:${String((e as Error).message).slice(0, 200)}`);
        }
      } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (keepAlive) clearInterval(keepAlive);
        livenessProbe?.stop();
        for (const h of installedSignalHandlers) process.off(h.sig, h.fn);
        // Commit the last bulk batch and rebuild the deferred indexes before
        // any post-pass reads the graph.
        const tEndBulk = performance.now();
        closeBulk();
        if (graphEmptyAtStart) profiler.phase("endBulk", performance.now() - tEndBulk);
      }
      if (bulkFailure) throw bulkFailure;
      if (deltaHooks) {
        // A partial stream must not be finalized as a delta: fail, keeping
        // the pending marker, so the next delta replays it.
        if (streamAborted) throw new Error("delta: member stream aborted");
        deltaHooks.afterMerge();
      } else if (memberRows) {
        finishMemberRows();
      }

      // A scoped run (auto-retry pass, --retry-skipped, --only) re-ran only
      // `onlyLabels`: carry the previous report's entries for every OTHER
      // label forward, so unreadable / insufficient_access entries it did
      // not touch stay in the report, the summary and the warnings (I2).
      if (opts.onlyLabels && opts.skipReportPath) {
        skipReport.skips.push(
          ...carriedOverSkips(opts.skipReportPath, resolved.orgId, opts.onlyLabels),
        );
      }

      // End-of-run skip summary. Grouped by category so the remediation is
      // targeted to the specific class of failure.
      if (skipReport.skips.length > 0) {
        printSkipSummary(skipReport, resolved.alias);
      }

      // Persist the skip report so --retry-skipped can read it next run.
      // Always written (even when empty) so users can tell whether the last
      // run had skips or just hasn't recorded any yet.
      if (opts.skipReportPath) {
        try {
          const { writeFileSync, mkdirSync } = await import("node:fs");
          const { dirname } = await import("node:path");
          mkdirSync(dirname(opts.skipReportPath), { recursive: true });
          writeFileSync(
            opts.skipReportPath,
            JSON.stringify(
              { recordedAt: Date.now(), orgId: resolved.orgId, ...skipReport },
              null,
              2,
            ),
            "utf8",
          );
        } catch (e) {
          logger.warn("live-ingest: skip report write failed", { err: (e as Error).message });
        }
      }
    }

    // Mark the end of input (the held queue still runs nothing until graph ready).
    embedQueue?.startDrain();

    // Full-sync deletion detection: compute previously-known minus touched and
    // delete the difference. Skipped on incremental (SourceMember handles it),
    // skipped if any parse error occurred this run (avoid mass-wipe on
    // transient SF errors).
    // Fast path: an org that was empty at start has no stale qnames — every
    // persisted node was touched by this run — so the sweep (and its
    // deleteEdgesFor calls) would be a no-op; skip it.
    if (opts.detectDeletions && !opts.metadataSource && mode === "full" && !graphEmptyAtStart) {
      if (streamAborted) {
        logger.warn(
          "live-ingest: detect-deletions skipped because bulkRetrieve stream aborted — touchedQnames is incomplete and a full deletion sweep would wrongly wipe untouched-but-still-present nodes",
        );
      } else if (parseErrors > 0) {
        logger.warn("live-ingest: detect-deletions skipped due to parseErrors", { parseErrors });
      } else {
        try {
          // W1.5-07: per-label drop-ratio guard. The sweep used to run as a
          // single set-difference across ALL labels; a wedged source with
          // streamAborted=false + touchedCount=0 for its label would silently
          // wipe every node of that label (graph-extinction risk that
          // compounds with the W1.5-01/02 wedge cascade). Now we evaluate the
          // guard per label and refuse when the implied drop is suspicious.
          const maxDropRatio = resolveMaxDropRatio(
            process.env.SFGRAPH_DETECT_DELETIONS_MAX_DROP_RATIO,
          );
          // Task 11c: a node from a source this run skipped (or carried a
          // skip for) is never "stale" — the source touched nothing.
          const protection = skipProtection(skipReport.skips);
          if (protection.refuseAll) {
            const warning = `wedge:detect-deletions:refuse:label=*:reason=skipped-source:skips=${protection.unknownLabels.join(",")}`;
            wedgeWarnings.push(warning);
            logger.warn(
              "live-ingest: detect-deletions refused (a skipped source has no type mapping)",
              {
                skips: protection.unknownLabels,
              },
            );
          }
          const labels = protection.refuseAll ? [] : graph.listAllLabels();
          let protectedCount = 0;
          for (const label of labels) {
            const priorCount = graph.countNodesByLabel(resolved.orgId, label);
            const touchedCount = touchedQnamesByLabel.get(label)?.size ?? 0;
            const verdict = evaluateDeletionGuard(label, priorCount, touchedCount, maxDropRatio);
            if (!verdict.proceed) {
              if (verdict.warning) wedgeWarnings.push(verdict.warning);
              logger.warn("live-ingest: detect-deletions refused", {
                label,
                priorCount,
                touchedCount,
                maxDropRatio,
                warning: verdict.warning,
              });
              continue;
            }

            // Proceed with deletion for this label only. Scoped to this label's
            // table via listNodesByLabel rather than the global listAllQnames
            // walk, so a refusal for one label cannot accidentally affect
            // sweeps for other labels.
            const touchedSet = touchedQnamesByLabel.get(label);
            const persisted = graph.listNodesByLabel(resolved.orgId, label);
            let labelDeletions = 0;
            for (const node of persisted) {
              const q = String(node.qualifiedName);
              if (touchedSet?.has(q)) continue;
              if (isSkipProtected(protection, node)) {
                protectedCount += 1;
                continue;
              }
              graph.deleteEdgesFor(resolved.orgId, asQualifiedName(q));
              graph.deleteNode(resolved.orgId, asQualifiedName(q));
              purgeNodeVector(asQualifiedName(q));
              deletions += 1;
              labelDeletions += 1;
            }
            if (labelDeletions > 0) {
              logger.info("live-ingest: detect-deletions removed stale qnames", {
                label,
                count: labelDeletions,
              });
            }
          }
          if (protectedCount > 0) {
            logger.info("live-ingest: detect-deletions kept nodes of skipped sources", {
              count: protectedCount,
            });
          }
        } catch (e) {
          logger.warn("live-ingest: detect-deletions failed", { err: (e as Error).message });
        }
      }
    }

    // Backfill: an earlier run returned before its vectors were all written
    // (--no-wait-embeddings, a worker crash, a kill). Every embedded text is
    // also stored verbatim as the node's FTS body, so re-queue the docs this
    // run did not touch whose stored vector is missing or stale.
    let backfilled = 0;
    if (embedQueue && wasEmbeddingsPending && graph.listFtsDocs) {
      const sink = opts.vectorStore;
      try {
        for (const doc of graph.listFtsDocs(resolved.orgId)) {
          if (touchedQnames.has(doc.qname)) continue;
          const stored = sink?.getContentHash?.(resolved.orgId, asQualifiedName(doc.qname));
          if (stored && stored === hashEmbedText(doc.body)) continue;
          embedQueue.push({
            qname: doc.qname,
            text: doc.body,
            orgId: String(resolved.orgId),
            label: doc.label,
          });
          backfilled += 1;
          if (embedQueue.overCapacity) await embedQueue.waitForCapacity();
        }
      } catch (e) {
        logger.warn("live-ingest: embedding backfill failed", { err: (e as Error).message });
      }
      if (backfilled > 0) {
        logger.info("live-ingest: re-queued pending embeddings", { backfilled });
      }
      embedQueue.startDrain();
    }

    // -----------------------------------------------------------------------
    // Post-merge resolver passes. Each step is isolated in try/catch so a
    // single resolver bug never breaks ingest — it just reports zero work done.
    // -----------------------------------------------------------------------
    let crossFlavorEdges = 0;
    let arityResolved = 0;
    let flowMethodsResolved = 0;
    let vlocityApexResult: LiveIngestResult["vlocityApex"];
    let drRelationshipsResult: LiveIngestResult["drRelationships"];
    let danglingEdges = 0;
    let overlapResult = { matched: 0, diverged: 0, empty: 0, annotated: 0 };
    let reflectionEdges = 0;
    // T15 I-2: post-merge steps that threw. A full ingest only warns; a delta
    // must not finalize (see below).
    const postFailures: string[] = [];

    // Synth a ParseContext for post-passes that need to mint edges/nodes.
    const postCtx: ParseContext = {
      ...parseCtxBase,
      sourceUri: "post-merge://resolver",
    };

    // review I4: re-target Aura `<c:name>` embeds at the bundles that exist.
    try {
      const auraEmbeds = resolveAuraEmbeds(graph, resolved.orgId);
      if (auraEmbeds.retargeted > 0) {
        logger.info("live-ingest: aura embed resolver re-targeted embeds", { ...auraEmbeds });
      }
    } catch (e) {
      postFailures.push("aura embed resolver");
      logger.warn("live-ingest: aura embed resolver failed", { err: (e as Error).message });
    }

    if (!opts.disableCrossFlavor) {
      try {
        crossFlavorEdges = resolveCrossFlavor(graph, {
          orgId: resolved.orgId,
          namespace: null,
          ctx: postCtx,
        });
        if (crossFlavorEdges > 0) {
          logger.info("live-ingest: cross-flavor resolver linked Vlocity↔OmniStudio", {
            edges: crossFlavorEdges,
          });
        }
      } catch (e) {
        postFailures.push("cross-flavor resolver");
        logger.warn("live-ingest: cross-flavor resolver failed", { err: (e as Error).message });
      }
    }

    // Overlap detector: opt-in (off by default) — annotates the CANONICAL_OF
    // edges resolveCrossFlavor just emitted with signaturesMatch + divergence
    // detail. Must run *after* cross-flavor and *before* the audit so the
    // audit sees the annotated edges as the same edges (idempotent merge).
    if (!opts.disableOverlapDetect) {
      try {
        const { detectOmnistudioOverlap } = await import(
          "../parsers/omnistudio/overlap-detector.js"
        );
        overlapResult = detectOmnistudioOverlap(graph, {
          orgId: resolved.orgId,
          ctx: postCtx,
        });
        if (overlapResult.annotated > 0) {
          logger.info("live-ingest: omnistudio overlap detector annotated CANONICAL_OF pairs", {
            matched: overlapResult.matched,
            diverged: overlapResult.diverged,
            empty: overlapResult.empty,
            annotated: overlapResult.annotated,
          });
        }
      } catch (e) {
        postFailures.push("omnistudio overlap detector");
        logger.warn("live-ingest: omnistudio overlap detector failed", {
          err: (e as Error).message,
        });
      }
    }

    if (!opts.disableFlowInvocableResolve) {
      const tPhase = performance.now();
      try {
        const flowResult = resolveFlowApexMethods(graph, resolved.orgId, postCtx);
        flowMethodsResolved = flowResult.resolved;
        if (flowResult.scanned > 0) {
          logger.info("live-ingest: flow→apex invocable resolver", {
            scanned: flowResult.scanned,
            resolved: flowResult.resolved,
            missing: flowResult.missing,
            ambiguous: flowResult.ambiguous,
          });
        }
      } catch (e) {
        postFailures.push("flow→apex resolver");
        logger.warn("live-ingest: flow→apex resolver failed", { err: (e as Error).message });
      }
      profiler.phase("resolver:flow-apex", performance.now() - tPhase);
    }

    if (!opts.disableVlocityApexResolve) {
      const tPhase = performance.now();
      try {
        const { resolveVlocityApex } = await import("../parsers/vlocity/apex-resolver.js");
        vlocityApexResult = resolveVlocityApex(graph, resolved.orgId, postCtx);
        if (vlocityApexResult.scanned > 0)
          logger.info("live-ingest: vlocity→apex resolver", vlocityApexResult);
      } catch (e) {
        postFailures.push("vlocity-apex-resolver");
        logger.warn(`vlocity-apex-resolver:failed:${(e as Error).message}`);
        wedgeWarnings.push(`vlocity-apex-resolver:failed:${(e as Error).message}`);
      }
      profiler.phase("resolver:vlocity-apex", performance.now() - tPhase);
    }

    if (!opts.disableDrRelationshipResolve) {
      const tPhase = performance.now();
      try {
        const { resolveDataRaptorRelationships } = await import(
          "../parsers/vlocity/dr-relationship-resolver.js"
        );
        drRelationshipsResult = resolveDataRaptorRelationships(graph, resolved.orgId, postCtx);
        if (drRelationshipsResult.scanned > 0)
          logger.info("live-ingest: dataraptor relationship-path resolver", drRelationshipsResult);
      } catch (e) {
        postFailures.push("dr-relationship-resolver");
        logger.warn(`dr-relationship-resolver:failed:${(e as Error).message}`);
        wedgeWarnings.push(`dr-relationship-resolver:failed:${(e as Error).message}`);
      }
      profiler.phase("resolver:dr-relationship", performance.now() - tPhase);
    }

    if (!opts.disableFlowRelationshipResolve) {
      const tPhase = performance.now();
      try {
        const { resolveFlowRelationshipPaths } = await import(
          "../parsers/flow/relationship-resolver.js"
        );
        const fr = resolveFlowRelationshipPaths(graph, resolved.orgId, postCtx);
        if (fr.scanned > 0) logger.info("live-ingest: flow relationship-path resolver", { ...fr });
      } catch (e) {
        postFailures.push("flow-relationship-resolver");
        logger.warn(`flow-relationship-resolver:failed:${(e as Error).message}`);
        wedgeWarnings.push(`flow-relationship-resolver:failed:${(e as Error).message}`);
      }
      profiler.phase("resolver:flow-relationship", performance.now() - tPhase);
    }

    if (!opts.disableLwcFieldKeyResolve) {
      const tPhase = performance.now();
      try {
        const { resolveLwcFieldKeys } = await import("../parsers/lwc/field-key-resolver.js");
        const r = resolveLwcFieldKeys(graph, resolved.orgId, postCtx);
        if (r.scanned > 0) logger.info("live-ingest: lwc field-key resolver", { ...r });
      } catch (e) {
        postFailures.push("lwc-field-key-resolver");
        logger.warn(`lwc-field-key-resolver:failed:${(e as Error).message}`);
        wedgeWarnings.push(`lwc-field-key-resolver:failed:${(e as Error).message}`);
      }
      profiler.phase("resolver:lwc-field-key", performance.now() - tPhase);
    }

    if (!opts.disableVlocityNameMatchResolve) {
      const tPhase = performance.now();
      try {
        const { resolveVlocityNameMatches } = await import(
          "../parsers/vlocity/name-match-resolver.js"
        );
        const nm = resolveVlocityNameMatches(graph, resolved.orgId, postCtx);
        if (nm.scanned > 0) logger.info("live-ingest: vlocity name-match resolver", { ...nm });
      } catch (e) {
        postFailures.push("vlocity-name-match-resolver");
        logger.warn(`vlocity-name-match-resolver:failed:${(e as Error).message}`);
        wedgeWarnings.push(`vlocity-name-match-resolver:failed:${(e as Error).message}`);
      }
      profiler.phase("resolver:vlocity-name-match", performance.now() - tPhase);
    }

    if (!opts.disableApexRefResolve) {
      const tPhase = performance.now();
      try {
        const { resolveApexReferences } = await import("../parsers/apex/ref-resolver.js");
        const { apexRefNoWorkResult } = await import("./resolver-gates.js");
        // Skip its whole-graph reads when it provably has no input and no
        // earlier output to prune (same result object it would return).
        const ar =
          apexRefNoWorkResult(graph, resolved.orgId) ??
          resolveApexReferences(graph, resolved.orgId, postCtx);
        if (ar.edgesEmitted > 0 || ar.pathsUnresolved > 0 || ar.dynamicSoqlFieldsSkipped > 0)
          logger.info("live-ingest: apex ref resolver", { ...ar });
      } catch (e) {
        postFailures.push("apex-ref-resolver");
        logger.warn(`apex-ref-resolver:failed:${(e as Error).message}`);
        wedgeWarnings.push(`apex-ref-resolver:failed:${(e as Error).message}`);
      }
      profiler.phase("resolver:apex-ref", performance.now() - tPhase);
    }

    // `ApexClass:X` references to an interface X (no class X): move them onto
    // `ApexInterface:X`. Before arity, which then sees interface method calls
    // under their real owner.
    let interfaceRefsRetargeted = 0;
    if (!opts.disableInterfaceRetarget) {
      const tPhase = performance.now();
      try {
        const names = deltaHooks?.retargetInterfaceNames();
        interfaceRefsRetargeted = retargetApexInterfaceRefs(
          graph,
          resolved.orgId,
          names ? { interfaceNames: names } : {},
        );
        if (interfaceRefsRetargeted > 0) {
          logger.info("live-ingest: apex interface references retargeted", {
            interfaceRefsRetargeted,
          });
        }
      } catch (e) {
        postFailures.push("apex interface retarget");
        logger.warn("live-ingest: apex interface retarget failed", { err: (e as Error).message });
      }
      profiler.phase("resolver:interface-retarget", performance.now() - tPhase);
    }

    if (!opts.disableArityResolve) {
      const tPhase = performance.now();
      try {
        const scope = deltaHooks?.arityScope();
        const arityResult = resolveApexMethodArity(graph, {
          orgId: resolved.orgId,
          ctx: postCtx,
          ...(scope ? { scope } : {}),
        });
        arityResolved = arityResult.resolved;
        if (arityResult.scanned > 0) {
          logger.info("live-ingest: apex method arity resolver", {
            scanned: arityResult.scanned,
            resolved: arityResult.resolved,
            ambiguous: arityResult.ambiguous,
            unresolved: arityResult.unresolved,
            edgesEmitted: arityResult.edgesEmitted,
          });
        }
      } catch (e) {
        postFailures.push("apex arity resolver");
        logger.warn("live-ingest: apex arity resolver failed", { err: (e as Error).message });
      }
      profiler.phase("resolver:arity", performance.now() - tPhase);
    }

    // A formula's second-hop field guess moves onto the CustomField that
    // declares that relationshipName.
    if (!opts.disableFormulaHopResolve) {
      const tPhase = performance.now();
      try {
        const sources = deltaHooks?.hopSources();
        const hop = resolveFormulaRelationshipHops(
          graph,
          resolved.orgId,
          sources ? { sources } : {},
        );
        if (hop.moved > 0)
          logger.info("live-ingest: formula relationship hops resolved", { ...hop });
      } catch (e) {
        postFailures.push("formula hop resolver");
        logger.warn("live-ingest: formula hop resolver failed", { err: (e as Error).message });
      }
      profiler.phase("resolver:formula-hop", performance.now() - tPhase);
    }

    // Reflection walker: runs BEFORE the dangling-edge audit so any
    // REFERENCES edges it emits are validated by the audit alongside
    // parser-emitted edges. Default on; disable via disableReflectionWalker.
    if (!opts.disableReflectionWalker) {
      const tPhase = performance.now();
      try {
        const { walkBlobsForReferences } = await import("../parsers/generic/reflection-walker.js");
        const sourceQnames = deltaHooks?.reflectionSources();
        const reflectionResult = walkBlobsForReferences(graph, {
          orgId: resolved.orgId,
          ctx: postCtx,
          ...(sourceQnames ? { sourceQnames } : {}),
        });
        reflectionEdges = reflectionResult.edgesEmitted;
        if (reflectionEdges > 0) {
          logger.info("live-ingest: reflection walker emitted REFERENCES edges", {
            scanned: reflectionResult.scanned,
            edges: reflectionEdges,
            truncated: reflectionResult.truncatedSources,
            ambiguous: reflectionResult.ambiguousMatches,
          });
        }
      } catch (e) {
        postFailures.push("reflection walker");
        logger.warn("live-ingest: reflection walker failed", {
          err: (e as Error).message,
        });
      }
      profiler.phase("resolver:reflection", performance.now() - tPhase);
    }

    // The audit only reports (it changes nothing): a delta skips it.
    if (!opts.disableAudit && !deltaHooks) {
      const tPhase = performance.now();
      try {
        const auditResult = auditDanglingEdges(graph, resolved.orgId, { sampleSize: 25 });
        danglingEdges = auditResult.danglingCount;
        if (auditResult.danglingCount > 0) {
          logger.info("live-ingest: graph audit found dangling edges", {
            totalEdges: auditResult.totalEdges,
            danglingCount: auditResult.danglingCount,
            platformRefs: auditResult.platformRefCount,
            unexpected: auditResult.unexpectedCount,
            byRel: auditResult.byRel,
            byDstPrefix: auditResult.byDstPrefix,
          });
        }
      } catch (e) {
        postFailures.push("graph audit");
        logger.warn("live-ingest: graph audit failed", { err: (e as Error).message });
      }
      profiler.phase("audit", performance.now() - tPhase);
    }

    const completedIso = new Date().toISOString();
    // N4: when incremental skipped changed members it couldn't fetch, do NOT
    // advance the watermark past them — hold it at the prior value so the next
    // incremental re-detects (and keeps warning about) those changes instead of
    // stepping over them forever. generation still increments / in-progress
    // still clears (markSyncComplete does both regardless of the timestamp).
    const holdWatermark = incrementalUnfetched > 0 && existing?.lastSyncedAt != null;
    const watermarkIso = holdWatermark
      ? new Date(existing!.lastSyncedAt as number).toISOString()
      : completedIso;
    // N-1: the held queue has not dispatched yet, so its lazy `onWork` flag
    // may not be set. Make `embeddings_pending` durable BEFORE the sync is
    // marked complete: a crash between here and the drain must leave the
    // next ingest knowing vectors are missing (it backfills them).
    if (embedQueue && !wasEmbeddingsPending && embedQueue.hasVectorWork()) {
      try {
        graph.setEmbeddingsPending?.(resolved.orgId, true);
      } catch (e) {
        logger.warn("live-ingest: setEmbeddingsPending failed", { err: (e as Error).message });
      }
    }
    const populate = async (): Promise<void> => {
      if (!opts.analysisDb) return;
      const tDead = performance.now();
      try {
        await populateAnalysisTables(graph, resolved.orgId, opts.analysisDb);
      } catch (e) {
        postFailures.push("populate analysis tables");
        logger.warn("live-ingest: populate analysis tables failed", {
          err: (e as Error).message,
        });
      }
      profiler.phase("deadcode", performance.now() - tDead);
    };
    // T15 I-2: a delta whose resolver or dead-code pass failed is not a clean
    // sync. Populate runs before the sync is marked complete, and any failure
    // throws here: the pending marker and member rows stay as they were, so the
    // next delta replays the touched members with every resolver at full scope
    // (the outer catch marks the sync failed; the generation does not move).
    if (deltaHooks) {
      await populate();
      if (postFailures.length > 0) {
        throw new Error(
          `delta: post-merge step(s) failed (${postFailures.join(", ")}); not finalized, the next delta re-derives at full scope`,
        );
      }
    }
    try {
      // W1.5-08: markSyncComplete subsumes the old touchSync — it updates
      // last_synced_at AND increments sync_generation AND clears the
      // in-progress flag, atomically in one transaction.
      graph.markSyncComplete(resolved.orgId, watermarkIso);
    } catch (e) {
      logger.warn("live-ingest: markSyncComplete failed", { err: (e as Error).message });
    }
    opts.onPhase?.("sync-complete");

    if (!deltaHooks) await populate();

    // Task 11c: the ingest is complete; record what each member owns.
    if (deltaHooks) deltaHooks.finalize();
    else if (memberRows && !streamAborted) {
      try {
        graph.replaceMemberRows?.(resolved.orgId, [...memberRows.values()], memberRowsGeneration());
      } catch (e) {
        logger.warn("live-ingest: member rows write failed", { err: (e as Error).message });
      }
    }

    // T15 N5-1: surface members skipped after repeated parse-worker failures.
    const parseQuarantined = deltaHooks
      ? (deltaHooks.quarantinedCount?.() ?? 0)
      : memberRows
        ? [...memberRows.values()].filter((r) => isQuarantinedRow(r)).length
        : 0;
    if (parseQuarantined > 0) {
      logger.warn(
        "live-ingest: members skipped after repeated parse-worker failures (until their content changes)",
        { count: parseQuarantined },
      );
    }

    // Graph ready: merges, resolvers and the dead-code cache are done. Only
    // embeddings may still be in flight.
    const graphReadyMs = Date.now() - startedAt;
    console.log(`graph ready in ${(graphReadyMs / 1000).toFixed(1)}s`);
    profiler.phase("graph-ready", graphReadyMs, true);

    let embeddings: LiveIngestEmbeddings | undefined;
    if (embedQueue) {
      const q = embedQueue;
      let pendingLeft = 0;
      if (opts.waitEmbeddings === false) {
        // Cache hits are cheap: write them before returning, so a warm no-wait
        // run still completes its vectors. Only model work is deferred.
        try {
          q.flushCached();
        } catch (e) {
          // Items may have been dropped mid-flush: keep the flag set.
          if (!embedError) embedError = e as Error;
          logger.warn("live-ingest: cached vector flush failed", { err: (e as Error).message });
        }
        pendingLeft = q.abandon() + q.stats.failed;
        const err = embedError as Error | null;
        if (pendingLeft > 0 || err) {
          console.log(
            `embeddings deferred: ${pendingLeft} texts pending (cached vectors written: ${q.stats.cached}); find_similar uses text search until an ingest that waits for embeddings fills them`,
          );
        } else {
          graph.setEmbeddingsPending?.(resolved.orgId, false);
        }
      } else {
        try {
          // drain() releases the held queue.
          await q.drain();
        } catch (e) {
          if (!embedError) embedError = e as Error;
        }
        const doneMs = Date.now() - startedAt;
        const err = embedError as Error | null;
        if (err) {
          pendingLeft = q.stats.failed;
          console.error(
            `embeddings failed: ${err.message} — ${q.stats.failed} texts left unembedded; they will be filled on the next ingest`,
          );
        } else {
          graph.setEmbeddingsPending?.(resolved.orgId, false);
          console.log(
            `embeddings done in ${(doneMs / 1000).toFixed(1)}s (cached ${q.stats.cached} / computed ${q.stats.computed})`,
          );
        }
        profiler.phase("embeddings", doneMs, true);
      }
      const err = embedError as Error | null;
      embeddings = {
        ...q.stats,
        pending: pendingLeft,
        backfilled,
        doneMs: Date.now() - startedAt,
        ...(err ? { error: err.message } : {}),
      };
    }

    if (opts.snapshotStore) {
      try {
        opts.snapshotStore.prune(resolved.orgId, opts.snapshotRetentionDays ?? 30);
      } catch (e) {
        logger.warn("live-ingest: snapshot prune failed", { err: (e as Error).message });
      }
    }

    return {
      orgId: resolved.orgId,
      capabilities: caps,
      mode,
      membersProcessed,
      parseErrors,
      deletions,
      durationMs: Date.now() - startedAt,
      crossFlavorEdges,
      arityResolved,
      parseQuarantined,
      interfaceRefsRetargeted,
      flowMethodsResolved,
      vlocityApex: vlocityApexResult,
      drRelationships: drRelationshipsResult,
      danglingEdges,
      reflectionEdges,
      overlap: overlapResult,
      warnings: [
        ...skipReport.skips.map((s) => `${s.label}: ${s.reason}`),
        // Phase 1.5 W1.5-02 namespaced wedge strings. Format documented in
        // PLAN.md: `wedge:<source>:<stage>:<detail>`. Forward-compatible
        // with Phase 1's structured-warnings refactor (W1-01).
        ...wedgeWarnings,
      ],
      graphReadyMs,
      ...(streamAborted ? { streamAborted: true } : {}),
      ...(embeddings ? { embeddings } : {}),
    };
  } catch (e) {
    embedQueue?.abandon();
    // Never leave a bulk window (open transaction, dropped indexes) or a
    // batch window (open transaction) behind.
    try {
      graph.endBatch?.();
    } catch {
      /* best-effort */
    }
    try {
      graph.endBulk?.();
    } catch {
      /* best-effort */
    }
    // W1.5-08: ingest threw before reaching markSyncComplete. Flip
    // sync_in_progress back to 0 (and clear sync_started_at) so concurrent
    // MCP readers don't see an orphaned in_progress flag forever. Generation
    // is intentionally NOT incremented — failed ingests don't count as
    // fresh graph data. Re-throw so callers (CLI / MCP job runner) see the
    // original error unchanged.
    try {
      graph.markSyncFailed(resolved.orgId);
    } catch (markErr) {
      logger.warn("live-ingest: markSyncFailed failed", {
        err: (markErr as Error).message,
      });
    }
    throw e;
  } finally {
    profiler.close();
    try {
      await ownedEmbedder?.close();
    } catch {
      /* best-effort */
    }
    try {
      embedCache?.close();
    } catch {
      /* best-effort */
    }
  }
}
