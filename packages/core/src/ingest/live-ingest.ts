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
import { bulkRetrieve } from "../extractors/live-org/bulk-retrieve.js";
import { type OrgCapabilities, probeCapabilities } from "../extractors/live-org/capabilities.js";
import { iterChanges } from "../extractors/live-org/source-member.js";
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

function adaptParserInput(
  ref: MemberRef,
  content: string,
): { type: string; input: unknown } | null {
  switch (ref.memberType) {
    case "ApexClass":
      return { type: "ApexClass", input: { className: ref.memberName, body: content } };
    case "ApexTrigger":
      return { type: "ApexTrigger", input: { triggerName: ref.memberName, body: content } };
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
    if (parsed.nodes.length) graph.mergeNodes(parsed.nodes);
    if (parsed.edges.length) graph.mergeEdges(parsed.edges);
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

  const processOne = async (ref: MemberRef, content: string): Promise<void> => {
    if (ref.obsolete) {
      // Build the qualified name same way parsers would: best-effort by member name.
      const qname = asQualifiedName(`${ref.memberType}:${ref.memberName}`);
      graph.deleteEdgesFor(resolved.orgId, qname);
      graph.deleteNode(resolved.orgId, qname);
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
      const result = await parser.parse(adapted.input, ctx);
      handleParsed(result);
      membersProcessed += 1;
    } catch (e) {
      parseErrors += 1;
      logger.warn("live-ingest: parser failure", {
        type: ref.memberType,
        name: ref.memberName,
        err: (e as Error).message,
      });
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
    for await (const member of bulkRetrieve(resolved.conn, caps, resolved.orgId)) {
      await processOne(member.ref, member.content);
    }
  }

  if (embedQueue) {
    try {
      await embedQueue.drain();
    } catch (e) {
      logger.warn("live-ingest: embed drain failed", { err: (e as Error).message });
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
