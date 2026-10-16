import type { OrgId, QualifiedName } from "@ryanstark24/sfgraph-shared";
import { METADATA_CATEGORY } from "../domain/metadata-category.js";
import { REL_TYPES } from "../domain/rel-types.js";
import { maskApex } from "../parsers/apex/dynamic-soql.js";
import { blankBracketGroups, findInlineQueries } from "../parsers/apex/soql-fields.js";
import type { BetterSqlite3Database, GraphStore } from "../storage/interfaces.js";
import { deadCodeCandidates, scoreDeadCode } from "./dead-code.js";

export interface PopulateCounts {
  findings: number;
  deadCode: number;
  governor: number;
  testCov: number;
}

/** Detect governor risks by scanning Apex source attribute (if available) plus parser-emitted flags. */
export function populateGovernorRisks(
  store: GraphStore,
  orgId: OrgId,
  db: BetterSqlite3Database,
): number {
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO _sfgraph_governor_risks
     (org_id, qualified_name, risk_type, evidence, line, computed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  let n = 0;
  const detect = (body: string): Array<{ type: string; evidence: string; line: number }> => {
    const out: Array<{ type: string; evidence: string; line: number }> = [];
    if (!body) return out;

    // Walk character by character, tracking brace depth at the entry-point of each loop.
    // While any loop is open, scan ahead for SOQL/DML patterns at each character position.
    const loopOpenDepths: number[] = []; // brace-depth at the moment the loop body { opens
    let depth = 0;
    let pendingLoop = false; // saw `for(` or `while(` waiting for `{`
    const inLoop = (): boolean => loopOpenDepths.length > 0;
    const lineOf = (idx: number): number => {
      let n = 1;
      for (let k = 0; k < idx; k++) if (body[k] === "\n") n += 1;
      return n;
    };
    const emit = (idx: number, type: string, evidence: string): void => {
      out.push({ type, evidence: evidence.trim().slice(0, 200), line: lineOf(idx) });
    };
    // Inline queries end at their depth-0 `]` outside string literals
    // (findInlineQueries, on the comment-masked body); evidence is raw text.
    const masked = maskApex(body);
    const queries = findInlineQueries(masked);
    const queryAt = new Map(queries.map((q) => [q.index, q]));
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      // loop keyword detection
      if (
        (ch === "f" && body.startsWith("for", i) && /\W/.test(body[i - 1] ?? " ")) ||
        (ch === "w" && body.startsWith("while", i) && /\W/.test(body[i - 1] ?? " "))
      ) {
        // ensure followed by `(`
        const after = body.indexOf("(", i);
        if (after !== -1 && after - i <= 6) {
          pendingLoop = true;
        }
      }
      if (ch === "{") {
        depth += 1;
        if (pendingLoop) {
          loopOpenDepths.push(depth);
          pendingLoop = false;
        }
      } else if (ch === "}") {
        if (loopOpenDepths.length && loopOpenDepths[loopOpenDepths.length - 1] === depth) {
          loopOpenDepths.pop();
        }
        depth -= 1;
      }
      // detect patterns at this position
      if (inLoop()) {
        const q = queryAt.get(i);
        if (q) {
          emit(i, "soql_in_loop", body.slice(i, i + q.text.length));
          i += q.text.length - 1;
          continue;
        }
        const dmlMatch = body
          .slice(i, i + 40)
          .match(/^(insert|update|upsert|delete|undelete)\s+\w/i);
        if (dmlMatch && /\W/.test(body[i - 1] ?? " ")) {
          emit(i, "dml_in_loop", dmlMatch[0] ?? "");
        }
      }
    }
    // unbounded query: search globally for SELECT without WHERE/LIMIT
    // (each query on its own: a query held in a bind is blanked out of its
    // outer query and checked separately)
    for (const q of queries) {
      const own = blankBracketGroups(q.inner);
      if (!/\bLIMIT\b/i.test(own) && !/\bWHERE\b/i.test(own)) {
        emit(q.index, "unbounded_query", body.slice(q.index, q.index + q.text.length));
      }
    }
    // simple no-bulkify: trigger with single-record DML pattern
    if (/trigger\s+\w+\s+on\s+\w+/i.test(body) && !/Trigger\.new/i.test(body)) {
      out.push({ type: "no_bulk", evidence: "trigger without Trigger.new iteration", line: -1 });
    }
    return out;
  };
  /**
   * Edge-based detection — the primary path for live-org ingests, where the
   * Apex body is parsed then discarded (node attrs carry no `body`/`source`,
   * so the char-scan above finds nothing). The Apex AST extractor stamps
   * EXECUTES_SOQL / EXECUTES_DML edges with `inLoop: true` when the
   * query/DML sits inside a for/while/do-while body, and records the query
   * text — enough to flag soql_in_loop, dml_in_loop, and unbounded_query
   * straight off the graph. These edges hang off ApexMethod nodes.
   */
  const detectFromEdges = (
    qname: QualifiedName,
  ): Array<{ type: string; evidence: string; line: number }> => {
    const out: Array<{ type: string; evidence: string; line: number }> = [];
    for (const e of store.listEdgesFrom(orgId, qname, REL_TYPES.EXECUTES_SOQL)) {
      const ea = (e.attributes ?? {}) as { inLoop?: unknown; query?: unknown };
      const query = typeof ea.query === "string" ? ea.query : "";
      if (ea.inLoop === true) {
        out.push({ type: "soql_in_loop", evidence: query || "SOQL in loop", line: -1 });
      }
      // NB: we deliberately do NOT flag "unbounded_query" (no WHERE/LIMIT)
      // from edges. Calibrated against a real org: ~100% of SOQL has no
      // WHERE/LIMIT in the captured query head (legit full reads of small
      // config objects like RecordType / CallCenter), so the heuristic
      // fires on every query and is pure noise. The body-scan path keeps it
      // for filesystem ingests where the full query text is available, but
      // SOQL/DML-in-loop is the high-signal governor risk we surface here.
    }
    for (const e of store.listEdgesFrom(orgId, qname, REL_TYPES.EXECUTES_DML)) {
      const ea = (e.attributes ?? {}) as { inLoop?: unknown };
      if (ea.inLoop === true) {
        out.push({ type: "dml_in_loop", evidence: String(e.dstQualifiedName), line: -1 });
      }
    }
    return out;
  };

  const writeRisks = (
    qname: QualifiedName,
    risks: Array<{ type: string; evidence: string; line: number }>,
  ): void => {
    const seen = new Set<string>();
    for (const r of risks) {
      const k = `${r.type}|${r.line}|${r.evidence.slice(0, 40)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      stmt.run(orgId, qname, r.type, r.evidence, r.line, now);
      n += 1;
    }
  };

  // Class / trigger: body char-scan (filesystem ingest) + attribute hints.
  for (const lbl of [METADATA_CATEGORY.APEX_CLASS, METADATA_CATEGORY.APEX_TRIGGER]) {
    for (const node of store.listNodesByLabel(orgId, lbl, 10000)) {
      const a = node.attributes as Record<string, unknown>;
      const body = String(a.source ?? a.body ?? "");
      const risks = detect(body);
      if (a.hasSoqlInLoop === true) {
        risks.push({ type: "soql_in_loop", evidence: "attribute hint", line: -1 });
      }
      if (a.hasDmlInLoop === true) {
        risks.push({ type: "dml_in_loop", evidence: "attribute hint", line: -1 });
      }
      // Edge-based detection on the class/trigger node itself (regex-mode
      // parser emits SOQL/DML edges at the trigger/class qname).
      risks.push(...detectFromEdges(node.qualifiedName));
      writeRisks(node.qualifiedName, risks);
    }
  }
  // Method-level edge detection — the live-ingest path (AST parser emits
  // EXECUTES_SOQL/DML edges per method). "ApexMethod" is a raw node label,
  // not a METADATA_CATEGORY member.
  for (const node of store.listNodesByLabel(orgId, "ApexMethod", 50000)) {
    writeRisks(node.qualifiedName, detectFromEdges(node.qualifiedName));
  }
  return n;
}

/**
 * Version of the dead-code algorithm (`deadCodeCandidates` + `scoreDeadCode`)
 * that wrote `_sfgraph_dead_code_scores`. Bump it on any change to which
 * nodes are candidates or how they are scored: rows stamped with another
 * version, or with none (written before the stamp existed), are stale, and
 * readers recompute live instead of serving pre-fix answers.
 *   2: member containment (method refs keep the class), @isTest classes
 *      excluded, test-only references do not keep a class alive.
 *   3: classes referenced only by tests carry `referenced_only_by_tests`
 *      instead of `no_incoming_edges`.
 *   4: an unambiguous Custom Metadata record -> ApexClass reflection edge
 *      (a CMDT field naming the class) is a real reference.
 *   5: test references count as references: dead = no inbound of any kind,
 *      unreferenced @isTest classes included (`test_class`); production code
 *      used only by tests is kept apart (`referenced_only_by_tests`).
 */
export const DEAD_CODE_ALGORITHM_VERSION = 5;

const DEAD_CODE_ANALYSIS = "dead_code";

function ensureVersionTable(db: BetterSqlite3Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _sfgraph_analysis_versions (
       org_id TEXT NOT NULL,
       analysis TEXT NOT NULL,
       version INTEGER NOT NULL,
       computed_at INTEGER NOT NULL,
       PRIMARY KEY (org_id, analysis)
     )`,
  );
}

/** The algorithm version stamped for `analysis`, or null when none is. */
function stampedVersion(db: BetterSqlite3Database, orgId: OrgId, analysis: string): number | null {
  try {
    const r = db
      .prepare("SELECT version FROM _sfgraph_analysis_versions WHERE org_id = ? AND analysis = ?")
      .get(orgId, analysis) as { version: number } | undefined;
    return r ? Number(r.version) : null;
  } catch {
    // No version table: written before stamps existed.
    return null;
  }
}

export function populateDeadCodeScores(
  store: GraphStore,
  orgId: OrgId,
  db: BetterSqlite3Database,
): number {
  const now = Date.now();
  ensureVersionTable(db);
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO _sfgraph_dead_code_scores
     (org_id, qualified_name, score, confidence, reasons, computed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  let n = 0;
  // Both deadCodeCandidates kinds: dead rows (`no_incoming_edges`) and
  // production code used only by tests (`referenced_only_by_tests`); readers
  // keep them apart by reason. A node with a production inbound edge is in
  // use, whatever its freshness.
  const write = db.transaction(() => {
    db.prepare("DELETE FROM _sfgraph_dead_code_scores WHERE org_id = ?").run(orgId);
    for (const { node, testOnlyRefs, isTest } of deadCodeCandidates(store, orgId)) {
      const { score, confidence, reasons } = scoreDeadCode(node, now, testOnlyRefs, isTest);
      stmt.run(orgId, node.qualifiedName, score, confidence, JSON.stringify(reasons), now);
      n += 1;
    }
    db.prepare(
      `INSERT OR REPLACE INTO _sfgraph_analysis_versions (org_id, analysis, version, computed_at)
       VALUES (?, ?, ?, ?)`,
    ).run(orgId, DEAD_CODE_ANALYSIS, DEAD_CODE_ALGORITHM_VERSION, now);
  });
  write();
  return n;
}

export interface DeadCodeScoreRow {
  qualifiedName: string;
  score: number;
  confidence: string;
  reasons: string[];
  computedAt: number;
}

/**
 * Rows of `_sfgraph_dead_code_scores` for `orgId`, ordered by score, or null
 * when the cache is stale for this algorithm: no version stamp (an older
 * scorer wrote it) or another version. An empty array is a current, valid
 * answer (no candidates). Freshness against the last sync is the caller's
 * check (`computedAt`).
 */
export function readDeadCodeScores(
  db: BetterSqlite3Database,
  orgId: OrgId,
): DeadCodeScoreRow[] | null {
  if (stampedVersion(db, orgId, DEAD_CODE_ANALYSIS) !== DEAD_CODE_ALGORITHM_VERSION) return null;
  try {
    const rows = db
      .prepare(
        `SELECT qualified_name, score, confidence, reasons, computed_at
         FROM _sfgraph_dead_code_scores WHERE org_id = ? ORDER BY score ASC, qualified_name ASC`,
      )
      .all(orgId) as Array<{
      qualified_name: string;
      score: number;
      confidence: string;
      reasons: string;
      computed_at: number;
    }>;
    return rows.map((r) => {
      let reasons: string[] = [];
      try {
        reasons = JSON.parse(r.reasons) as string[];
      } catch {
        // unparseable reasons: keep the row, no reasons
      }
      return {
        qualifiedName: r.qualified_name,
        score: r.score,
        confidence: r.confidence,
        reasons,
        computedAt: r.computed_at,
      };
    });
  } catch {
    return null;
  }
}

/**
 * Dead-code scores from the cache when it is current for this algorithm,
 * otherwise computed live (same candidates and scores the cache would hold).
 */
export function loadDeadCodeScores(
  store: GraphStore,
  orgId: OrgId,
  db: BetterSqlite3Database | null | undefined,
  now = Date.now(),
): { rows: DeadCodeScoreRow[]; source: "cache" | "live" } {
  const cached = db ? readDeadCodeScores(db, orgId) : null;
  if (cached) return { rows: cached, source: "cache" };
  const rows = deadCodeCandidates(store, orgId)
    .map(({ node, testOnlyRefs, isTest }) => ({
      qualifiedName: String(node.qualifiedName),
      ...scoreDeadCode(node, now, testOnlyRefs, isTest),
      computedAt: now,
    }))
    .sort((x, y) => x.score - y.score || x.qualifiedName.localeCompare(y.qualifiedName));
  return { rows, source: "live" };
}

export function populateTestCoverage(
  store: GraphStore,
  orgId: OrgId,
  db: BetterSqlite3Database,
): number {
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO _sfgraph_test_coverage
     (org_id, qualified_name, test_count, computed_at)
     VALUES (?, ?, ?, ?)`,
  );
  let n = 0;
  for (const node of store.listNodesByLabel(orgId, METADATA_CATEGORY.APEX_CLASS, 10000)) {
    const tests = store.listEdgesTo(orgId, node.qualifiedName, REL_TYPES.IS_TEST_FOR).length;
    stmt.run(orgId, node.qualifiedName, tests, now);
    n += 1;
  }
  return n;
}

export function populateSecurityFindings(
  store: GraphStore,
  orgId: OrgId,
  db: BetterSqlite3Database,
): number {
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO _sfgraph_findings
     (org_id, qualified_name, rule_id, line, severity, message, evidence, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let n = 0;
  for (const node of store.listNodesByLabel(orgId, METADATA_CATEGORY.SHARING_RULE, 10000)) {
    const a = node.attributes as Record<string, unknown>;
    if (a.accessLevel === "All" || a.access === "Edit" || a.accessLevel === "Edit") {
      stmt.run(
        orgId,
        node.qualifiedName,
        "sharing.full_access",
        -1,
        "high",
        "sharing rule grants full access (All/Edit)",
        JSON.stringify({ accessLevel: a.accessLevel ?? a.access ?? null }),
        now,
      );
      n += 1;
    }
  }
  return n;
}

const ANALYSIS_TABLES = [
  "_sfgraph_findings",
  "_sfgraph_dead_code_scores",
  "_sfgraph_governor_risks",
  "_sfgraph_test_coverage",
];

export async function populateAnalysisTables(
  store: GraphStore,
  orgId: OrgId,
  db: BetterSqlite3Database,
): Promise<PopulateCounts> {
  // One transaction for the whole repopulate: (1) atomic — a crash mid-run
  // can't leave half-populated analysis; (2) fast — collapses thousands of
  // per-node INSERTs (the old N+1 autocommit-per-row pattern) into a single
  // commit. First DELETE this org's prior rows so a node that no longer has a
  // risk/finding/dead-code score doesn't keep a stale row forever (these tables
  // used INSERT OR REPLACE, which only ever touches still-present nodes).
  const run = db.transaction((): PopulateCounts => {
    for (const t of ANALYSIS_TABLES) {
      db.prepare(`DELETE FROM ${t} WHERE org_id = ?`).run(orgId);
    }
    const findings = populateSecurityFindings(store, orgId, db);
    const deadCode = populateDeadCodeScores(store, orgId, db);
    const governor = populateGovernorRisks(store, orgId, db);
    const testCov = populateTestCoverage(store, orgId, db);
    return { findings, deadCode, governor, testCov };
  });
  return run();
}
