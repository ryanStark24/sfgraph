import { ErrorCode, type OrgId, SfgraphError, asQualifiedName } from "@ryanstark24/sfgraph-shared";
import type { Logger } from "@ryanstark24/sfgraph-shared";
import type { ParseContext, ParseResult } from "../parsers/contract.js";
import { parserRegistry } from "../parsers/registry.js";
// Ensure all parsers are registered before we look them up.
import "../parsers/index.js";
import { populateAnalysisTables } from "../analyze/populate.js";
import { EmbeddingQueue, type VectorSink } from "../embedding/index.js";
import type { MemberRef, RawMember } from "../extractors/interfaces/metadata-source.js";
import { type ResolveOrgDeps, type ResolvedOrg, resolveOrg } from "../extractors/live-org/auth.js";
import { type IngestSkipReport, bulkRetrieve } from "../extractors/live-org/bulk-retrieve.js";
import { type OrgCapabilities, probeCapabilities } from "../extractors/live-org/capabilities.js";
import { iterChanges } from "../extractors/live-org/source-member.js";
import { dataPool, metadataPool, toolingPool } from "../extractors/live-org/rate-limit.js";
import { loadAllRules } from "../parsers/rules/_loader.js";
import type { BetterSqlite3Database, GraphStore } from "../storage/interfaces.js";
import type { SnapshotStore } from "../storage/interfaces.js";

export type IngestMode = "full" | "incremental" | "auto";

export interface LiveIngestOpts {
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
   * Where to persist the skip report at end of run. When set, the report is
   * written as JSON so --retry-skipped can read it on the next run.
   */
  skipReportPath?: string;
}

export interface LiveIngestResult {
  orgId: OrgId;
  capabilities: OrgCapabilities;
  mode: IngestMode;
  membersProcessed: number;
  parseErrors: number;
  deletions: number;
  durationMs: number;
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
function printSkipSummary(report: IngestSkipReport, orgAlias: string): void {
  const byCategory = new Map<string, Array<{ label: string; reason: string }>>();
  for (const s of report.skips) {
    const arr = byCategory.get(s.category) ?? [];
    arr.push({ label: s.label, reason: s.reason });
    byCategory.set(s.category, arr);
  }

  const total = report.skips.length;
  console.log("");
  console.log(
    `⚠ ${total} metadata ${total === 1 ? "type was" : "types were"} skipped during this ingest.`,
  );
  console.log("  The rest of the graph completed successfully — these types are simply absent.");

  if (byCategory.has("insufficient_access")) {
    const list = byCategory.get("insufficient_access") ?? [];
    console.log("");
    console.log(`  Insufficient access (${list.length}):`);
    for (const s of list) console.log(`    • ${s.label}: ${s.reason}`);
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
    for (const s of list) console.log(`    • ${s.label}: ${s.reason}`);
    console.log("    How to fix: check connectivity to your org and re-run.");
  }

  if (byCategory.has("unknown")) {
    const list = byCategory.get("unknown") ?? [];
    console.log("");
    console.log(`  Other (${list.length}):`);
    for (const s of list) console.log(`    • ${s.label}: ${s.reason}`);
  }
  console.log("");
}

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

function adaptParserInput(
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
    case "Flow":
      return { type: "Flow", input: { fullName: ref.memberName, xml: content } };
    case "CustomObject":
      return { type: "CustomObject", input: { apiName: ref.memberName, objectXml: content } };
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
    case "VlocityDataRaptor":
    case "VlocityIntegrationProcedure":
    case "VlocityCard":
    case "VlocityOmniScript": {
      let datapack: unknown = content;
      try {
        datapack = JSON.parse(content);
      } catch {
        /* keep raw */
      }
      return { type: ref.memberType, input: { name: ref.memberName, datapack } };
    }
    default:
      return null;
  }
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

  const caps = await probeCapabilities(resolved.conn);
  logger.info("live-ingest: probed capabilities", { caps });

  // Discovery is also invoked implicitly inside bulkRetrieve, but logging the
  // type-count up-front gives operators a quick coverage signal.
  try {
    const { discoverMetadataTypes } = await import("../extractors/live-org/discovery.js");
    const discovered = await discoverMetadataTypes(resolved.conn, apiVersion);
    logger.info("live-ingest: discovered metadata types", { count: discovered.length });
  } catch (e) {
    logger.warn("live-ingest: metadata.describe failed", { err: (e as Error).message });
  }

  const existing = graph.getOrg(resolved.orgId);
  const requestedMode = opts.mode ?? "auto";
  let mode: IngestMode;
  if (requestedMode === "auto") {
    mode = existing?.lastSyncedAt && caps.sourceTracking ? "incremental" : "full";
  } else {
    mode = requestedMode;
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
  // Set in the full-sync branch if the bulkRetrieve stream itself throws.
  // Detect-deletions reads it post-fan-out to bail out instead of mass-
  // wiping nodes that were never visited due to the abort.
  let streamAborted = false;
  const touchedQnames = new Set<string>();

  const parseCtxBase: Omit<ParseContext, "sourceUri"> = {
    orgId: resolved.orgId,
    parseTimestamp: new Date(now).toISOString(),
    namespace: null,
    logger,
  };

  const embedQueue = opts.vectorStore
    ? new EmbeddingQueue({
        vectorStore: opts.vectorStore,
        onError: (err) => logger.warn("live-ingest: embedding batch failed", { err: err.message }),
      })
    : null;

  const handleParsed = (parsed: ParseResult): void => {
    if (parsed.nodes.length) {
      graph.mergeNodes(parsed.nodes);
      for (const n of parsed.nodes) touchedQnames.add(String(n.qualifiedName));
    }
    if (parsed.edges.length) graph.mergeEdges(parsed.edges);
    if (parsed.snippets?.length) {
      graph.transaction(() => {
        for (const s of parsed.snippets ?? []) {
          graph.upsertSnippet(s);
        }
      });
    }
    if (embedQueue) {
      for (const n of parsed.nodes) {
        const desc = (n.attributes as Record<string, unknown>)?.description;
        const text = `${n.label}: ${n.qualifiedName}\n${typeof desc === "string" ? desc : ""}`;
        embedQueue.push({
          qname: String(n.qualifiedName),
          text,
          orgId: String(n.orgId),
          label: n.label,
        });
      }
    }
  };

  const debugProcess = process.env.SFGRAPH_DEBUG_INGEST === "1";
  const processOne = async (ref: MemberRef, content: string): Promise<void> => {
    const qnameForLog = `${ref.memberType}:${ref.memberName}`;
    if (ref.obsolete) {
      // Build the qualified name same way parsers would: best-effort by member name.
      const qname = asQualifiedName(`${ref.memberType}:${ref.memberName}`);
      if (debugProcess) console.log(`ingest: [trace] delete ← ${qnameForLog}`);
      graph.deleteEdgesFor(resolved.orgId, qname);
      graph.deleteNode(resolved.orgId, qname);
      if (debugProcess) console.log(`ingest: [trace] delete ✓ ${qnameForLog}`);
      deletions += 1;
      return;
    }
    const adapted = adaptParserInput(ref, content);
    if (!adapted) return;
    const parser = parserRegistry.for(adapted.type);
    if (!parser) return;
    try {
      const ctx: ParseContext = {
        ...parseCtxBase,
        sourceUri: ref.sourceUri,
        namespace: ref.namespace ?? null,
      };
      if (debugProcess) console.log(`ingest: [trace] parse ← ${qnameForLog}`);
      const result = await parser.parse(adapted.input, ctx);
      if (debugProcess)
        console.log(
          `ingest: [trace] parse ✓ ${qnameForLog} (nodes=${result.nodes.length} edges=${result.edges.length})`,
        );
      if (debugProcess) console.log(`ingest: [trace] graph-merge ← ${qnameForLog}`);
      handleParsed(result);
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

  if (mode === "incremental") {
    const sinceIso = existing?.lastSyncedAt
      ? new Date(existing.lastSyncedAt).toISOString()
      : new Date(now - 24 * 3600 * 1000).toISOString();
    for await (const ref of iterChanges(resolved.conn, resolved.orgId, sinceIso)) {
      // For incremental, content is best fetched on-demand; for deletions we skip content.
      await processOne(ref, "");
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
    const tCap =
      (toolingPool as unknown as { _store: { storeOptions: { maxConcurrent: number } } })._store
        .storeOptions.maxConcurrent;
    const mCap =
      (metadataPool as unknown as { _store: { storeOptions: { maxConcurrent: number } } })._store
        .storeOptions.maxConcurrent;
    const dCap =
      (dataPool as unknown as { _store: { storeOptions: { maxConcurrent: number } } })._store
        .storeOptions.maxConcurrent;
    console.log(
      `ingest: starting full sync (Tooling pool ${tCap} / Metadata pool ${mCap} / Data pool ${dCap} concurrent)`,
    );
    const fanOutStart = Date.now();
    let progressCount = 0;
    let lastTickAt = Date.now();
    let lastActivityAt = Date.now();
    let lastMemberLabel = "(none)";
    const PROGRESS_TICK_MS = 5000; // emit a heartbeat at least every 5s
    const skipReport: IngestSkipReport = { skips: [] };
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
            p.currentReservoir().then((reservoir) => {
              console.log(
                `ingest: [pool ${name}] running=${c.RUNNING} executing=${c.EXECUTING} queued=${c.QUEUED} received=${c.RECEIVED} reservoir=${reservoir}`,
              );
            }, () => {
              /* swallow — never let a diag failure kill ingest */
            });
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
        for await (const member of bulkRetrieve(resolved.conn, caps, resolved.orgId, {
          skipReport,
          ...(opts.onlyLabels ? { onlyLabels: opts.onlyLabels } : {}),
        })) {
          try {
            await processOne(member.ref, member.content);
          } catch (e) {
            parseErrors += 1;
            logger.warn("live-ingest: processOne failed", {
              qname: `${member.ref.memberType}:${member.ref.memberName}`,
              error: (e as Error).message,
            });
          }
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
      }
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (keepAlive) clearInterval(keepAlive);
      for (const h of installedSignalHandlers) process.off(h.sig, h.fn);
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
          JSON.stringify({ recordedAt: Date.now(), orgId: resolved.orgId, ...skipReport }, null, 2),
          "utf8",
        );
      } catch (e) {
        logger.warn("live-ingest: skip report write failed", { err: (e as Error).message });
      }
    }
  }

  if (embedQueue) {
    try {
      await embedQueue.drain();
    } catch (e) {
      logger.warn("live-ingest: embed drain failed", { err: (e as Error).message });
    }
  }

  // Full-sync deletion detection: compute previously-known minus touched and
  // delete the difference. Skipped on incremental (SourceMember handles it),
  // skipped if any parse error occurred this run (avoid mass-wipe on
  // transient SF errors).
  if (opts.detectDeletions && mode === "full") {
    if (streamAborted) {
      logger.warn(
        "live-ingest: detect-deletions skipped because bulkRetrieve stream aborted — touchedQnames is incomplete and a full deletion sweep would wrongly wipe untouched-but-still-present nodes",
      );
    } else if (parseErrors > 0) {
      logger.warn("live-ingest: detect-deletions skipped due to parseErrors", { parseErrors });
    } else {
      try {
        const persisted = graph.listAllQnames(resolved.orgId);
        const stale: string[] = [];
        for (const q of persisted) {
          if (!touchedQnames.has(String(q))) stale.push(String(q));
        }
        for (const q of stale) {
          graph.deleteEdgesFor(resolved.orgId, asQualifiedName(q));
          graph.deleteNode(resolved.orgId, asQualifiedName(q));
          deletions += 1;
        }
        if (stale.length > 0) {
          logger.info("live-ingest: detect-deletions removed stale qnames", {
            count: stale.length,
          });
        }
      } catch (e) {
        logger.warn("live-ingest: detect-deletions failed", { err: (e as Error).message });
      }
    }
  }

  const completedIso = new Date().toISOString();
  try {
    graph.touchSync(resolved.orgId, completedIso);
  } catch (e) {
    logger.warn("live-ingest: touchSync failed", { err: (e as Error).message });
  }

  if (opts.analysisDb) {
    try {
      await populateAnalysisTables(graph, resolved.orgId, opts.analysisDb);
    } catch (e) {
      logger.warn("live-ingest: populate analysis tables failed", {
        err: (e as Error).message,
      });
    }
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
  };
}

export function rethrowAsIngestError(e: unknown, ctx: string): never {
  if (e instanceof SfgraphError) throw e;
  throw new SfgraphError(ErrorCode.E_SF_INGEST, `${ctx}: ${(e as Error).message ?? String(e)}`);
}
