import { type NodeFact, analyze } from "@ryanstark24/sfgraph-core";
import type { ToolContext } from "../context.js";

/**
 * Shared readers for the analysis cache tables that `populateAnalysisTables`
 * fills at the end of an ingest (`_sfgraph_governor_risks`,
 * `_sfgraph_dead_code_scores`). Used by governor_risk_check, dead_code_audit
 * and export_sarif so the three tools agree on the same results.
 */

type Stmt = { all: (...a: unknown[]) => unknown[]; get: (...a: unknown[]) => unknown };
type Db = { prepare: (s: string) => Stmt };

function dbOf(ctx: ToolContext): Db | null {
  const db = ctx.db as Db | undefined;
  return db && typeof db.prepare === "function" ? db : null;
}

export type CacheState = "absent" | "fresh" | "stale" | "unknown";

/**
 * How trustworthy an analysis table is for this org:
 * - `absent`: no rows (never populated, or the table is missing).
 * - `stale`: a sync is in progress, or the rows were computed before the
 *   org's last completed sync (populate runs right after markSyncComplete, so
 *   a fresh cache is never older than `last_synced_at`).
 * - `unknown`: rows exist but the org has no recorded sync to compare with.
 * - `fresh`: otherwise.
 * Only `fresh` caches are read (review M1); every other state means live.
 */
export interface CacheFreshness {
  state: CacheState;
  rows: number;
  computedAt: number | null;
  lastSyncedAt: number | null;
  reason?: string;
}

export function cacheFreshness(
  ctx: ToolContext,
  table: "_sfgraph_governor_risks" | "_sfgraph_dead_code_scores",
): CacheFreshness {
  const absent: CacheFreshness = { state: "absent", rows: 0, computedAt: null, lastSyncedAt: null };
  const db = dbOf(ctx);
  if (!db) return absent;
  let rows = 0;
  let computedAt: number | null = null;
  try {
    const r = db
      .prepare(`SELECT COUNT(*) AS c, MIN(computed_at) AS m FROM ${table} WHERE org_id = ?`)
      .get(String(ctx.orgId)) as { c: number; m: number | null } | undefined;
    rows = r?.c ?? 0;
    computedAt = r?.m ?? null;
  } catch {
    return absent;
  }
  if (rows === 0) return absent;
  let lastSyncedAt: number | null = null;
  let inProgress = false;
  try {
    const o = db
      .prepare("SELECT last_synced_at AS l, sync_in_progress AS p FROM _sfgraph_orgs WHERE id = ?")
      .get(String(ctx.orgId)) as { l: number | null; p: number | null } | undefined;
    lastSyncedAt = o?.l ?? null;
    inProgress = o?.p === 1;
  } catch {
    // Older schema without the sync columns: freshness can't be judged.
  }
  // review I3: the raw flag stays 1 after a killed ingest; the store's status
  // checks the recorded owner (rel-02) and reports a dead one as not running.
  if (inProgress && typeof ctx.graphStore.getSyncStatus === "function") {
    try {
      inProgress = ctx.graphStore.getSyncStatus(ctx.orgId).in_progress;
    } catch {
      /* keep the raw flag */
    }
  }
  if (inProgress) {
    return { state: "stale", rows, computedAt, lastSyncedAt, reason: "a sync is in progress" };
  }
  if (lastSyncedAt === null || computedAt === null) {
    return { state: "unknown", rows, computedAt, lastSyncedAt, reason: "no recorded sync" };
  }
  if (computedAt < lastSyncedAt) {
    return {
      state: "stale",
      rows,
      computedAt,
      lastSyncedAt,
      reason: "computed before the last sync",
    };
  }
  return { state: "fresh", rows, computedAt, lastSyncedAt };
}

/** One-line human description of where an audit's results came from. */
export function describeSource(source: string, f: CacheFreshness): string {
  if (f.state === "stale") return `${source} (cache stale: ${f.reason}; recomputed live)`;
  if (f.state === "unknown") return `${source} (cache unverified: ${f.reason}; recomputed live)`;
  return source;
}

// ---------------------------------------------------------------------------
// Governor risks
// ---------------------------------------------------------------------------

export interface GovernorRiskRow {
  qualifiedName: string;
  risk: analyze.GovernorRisk["risk"];
  evidence: string;
}

export interface GovernorCollection {
  risks: GovernorRiskRow[];
  /** "live" or "live+cache" (cache rows added for risks the edge scan can't see). */
  source: "live" | "live+cache";
  cache: CacheFreshness;
  excludedTests: number;
}

function readGovernorCache(db: Db, orgId: string): GovernorRiskRow[] {
  try {
    const rows = db
      .prepare(
        "SELECT qualified_name, risk_type, evidence FROM _sfgraph_governor_risks WHERE org_id = ?",
      )
      .all(orgId) as Array<{ qualified_name: string; risk_type: string; evidence: string | null }>;
    return rows.map((r) => ({
      qualifiedName: r.qualified_name,
      risk: r.risk_type as GovernorRiskRow["risk"],
      evidence: r.evidence ?? "",
    }));
  } catch {
    return [];
  }
}

function isTestNode(n: NodeFact | null): boolean {
  if (!n) return false;
  if (n.label === "TestMethod") return true;
  return (n.attributes as Record<string, unknown> | undefined)?.isTest === true;
}

/**
 * Governor risks for an org, identical for every tool that reports them.
 *
 * The live edge scan (`findGovernorRisks`) is the source of truth for
 * SOQL/DML-in-loop: the cache table keys rows by (qname, risk_type, line) with
 * line always -1 for edge detections, so several in-loop queries in one method
 * collapse into one cached row. Cached rows are only used to ADD
 * (qname, risk) pairs the edge scan cannot produce (body-scan risks from a
 * filesystem ingest, class-level edges), and only when the cache is fresh.
 *
 * Test code (`TestMethod` nodes and `isTest` classes/methods) is excluded
 * from both sources unless `includeTests` is set. Sorted by qname, risk,
 * evidence so the output is deterministic.
 */
export function collectGovernorRisks(
  ctx: ToolContext,
  opts: { includeTests?: boolean } = {},
): GovernorCollection {
  const live: GovernorRiskRow[] = analyze.findGovernorRisks(ctx.graphStore, ctx.orgId);
  const cache = cacheFreshness(ctx, "_sfgraph_governor_risks");
  const db = dbOf(ctx);
  let all = live;
  let source: GovernorCollection["source"] = "live";
  if (db && cache.state === "fresh") {
    const covered = new Set(live.map((r) => `${r.qualifiedName}\u0000${r.risk}`));
    const extra = readGovernorCache(db, String(ctx.orgId)).filter(
      (r) => !covered.has(`${r.qualifiedName}\u0000${r.risk}`),
    );
    if (extra.length > 0) {
      all = [...live, ...extra];
      source = "live+cache";
    }
  }
  let excludedTests = 0;
  if (!opts.includeTests) {
    const testByQname = new Map<string, boolean>();
    all = all.filter((r) => {
      let t = testByQname.get(r.qualifiedName);
      if (t === undefined) {
        t = isTestNode(ctx.graphStore.getNode(ctx.orgId, r.qualifiedName as never));
        testByQname.set(r.qualifiedName, t);
      }
      if (t) excludedTests += 1;
      return !t;
    });
  }
  // T15 I-5: the documented priority order (analyze.compareGovernorRisks:
  // risk kind by severity, then qname, then evidence), so a `limit` keeps the
  // most severe risks.
  all = [...all].sort(analyze.compareGovernorRisks);
  return { risks: all, source, cache, excludedTests };
}

// ---------------------------------------------------------------------------
// Dead code
// ---------------------------------------------------------------------------

/**
 * A score-cache row the current scorer can write: every candidate carries
 * `no_incoming_edges`, or `referenced_only_by_tests` in its place when only
 * test code references it (core e32f861). The version stamp already rejects
 * old-scorer tables; this only keeps a stray hand-written row out.
 */
export function isDeadCodeCacheRow(reasons: readonly string[]): boolean {
  return reasons.includes("no_incoming_edges") || reasons.includes("referenced_only_by_tests");
}

/**
 * Dead-code candidates for SARIF. Reads `_sfgraph_dead_code_scores` (through
 * core's version-stamped `readDeadCodeScores`) only when it is fresh: populateDeadCodeScores writes the
 * `deadCodeCandidates` rows (see `isDeadCodeCacheRow`); the dead ones are the `findDeadCode` set
 * (`referenced_only_by_tests` rows are skipped: not dead), so the rows are
 * equivalent to the live scan at compute time, without one listEdgesTo per
 * node. Falls back to the live scan when the cache is absent, stale or unknown.
 */
export function collectDeadCode(ctx: ToolContext): {
  nodes: NodeFact[];
  source: "cache" | "live";
  cache: CacheFreshness;
} {
  const cache = cacheFreshness(ctx, "_sfgraph_dead_code_scores");
  const db = dbOf(ctx);
  if (db && cache.state === "fresh") {
    try {
      // Core's version-stamped reader: unstamped / older-version rows read
      // as null, so pre-fix legacy rows are never served.
      const rows = analyze.readDeadCodeScores(db as never, ctx.orgId);
      const nodes: NodeFact[] = [];
      let legacy = rows === null;
      for (const r of rows ?? []) {
        if (!isDeadCodeCacheRow(r.reasons)) {
          legacy = true;
          break;
        }
        // Production code only tests use is listed apart, not dead (Batch R / S6).
        if (r.reasons.includes("referenced_only_by_tests")) continue;
        const n = ctx.graphStore.getNode(ctx.orgId, r.qualifiedName as never);
        // A cached candidate whose node is gone means the cache predates the
        // graph: don't trust any of it.
        if (!n) {
          legacy = true;
          break;
        }
        nodes.push(n);
      }
      if (!legacy) {
        nodes.sort((a, b) => String(a.qualifiedName).localeCompare(String(b.qualifiedName)));
        return { nodes, source: "cache", cache };
      }
    } catch {
      // fall through to live
    }
  }
  return { nodes: analyze.findDeadCode(ctx.graphStore, ctx.orgId), source: "live", cache };
}
