import type { OrgId } from "@sfgraph/shared";
import { METADATA_CATEGORY } from "../domain/metadata-category.js";
import { REL_TYPES } from "../domain/rel-types.js";
import type { BetterSqlite3Database, GraphStore } from "../storage/interfaces.js";
import { freshnessScore } from "./freshness.js";

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
        if (body.startsWith("[", i)) {
          const close = body.indexOf("]", i);
          const seg = close !== -1 ? body.slice(i, close + 1) : body.slice(i, i + 80);
          if (/^\[\s*SELECT\b/i.test(seg)) {
            emit(i, "soql_in_loop", seg);
            i = close === -1 ? i : close;
            continue;
          }
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
    for (const m of body.matchAll(/\[\s*SELECT\b[\s\S]*?\]/gi)) {
      const seg = m[0] ?? "";
      if (!/\bLIMIT\b/i.test(seg) && !/\bWHERE\b/i.test(seg)) {
        emit(m.index ?? 0, "unbounded_query", seg);
      }
    }
    // simple no-bulkify: trigger with single-record DML pattern
    if (/trigger\s+\w+\s+on\s+\w+/i.test(body) && !/Trigger\.new/i.test(body)) {
      out.push({ type: "no_bulk", evidence: "trigger without Trigger.new iteration", line: -1 });
    }
    return out;
  };
  for (const lbl of [METADATA_CATEGORY.APEX_CLASS, METADATA_CATEGORY.APEX_TRIGGER]) {
    for (const node of store.listNodesByLabel(orgId, lbl, 10000)) {
      const a = node.attributes as Record<string, unknown>;
      const body = String(a.source ?? a.body ?? "");
      const risks = detect(body);
      // Attribute hints from earlier phases
      if (a.hasSoqlInLoop === true) {
        risks.push({ type: "soql_in_loop", evidence: "attribute hint", line: -1 });
      }
      if (a.hasDmlInLoop === true) {
        risks.push({ type: "dml_in_loop", evidence: "attribute hint", line: -1 });
      }
      const seen = new Set<string>();
      for (const r of risks) {
        const k = `${r.type}|${r.line}`;
        if (seen.has(k)) continue;
        seen.add(k);
        stmt.run(orgId, node.qualifiedName, r.type, r.evidence, r.line, now);
        n += 1;
      }
    }
  }
  return n;
}

export function populateDeadCodeScores(
  store: GraphStore,
  orgId: OrgId,
  db: BetterSqlite3Database,
): number {
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO _sfgraph_dead_code_scores
     (org_id, qualified_name, score, confidence, reasons, computed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  let n = 0;
  const labels = [
    METADATA_CATEGORY.APEX_CLASS,
    METADATA_CATEGORY.LWC,
    METADATA_CATEGORY.FLOW,
    METADATA_CATEGORY.APEX_PAGE,
    METADATA_CATEGORY.APEX_COMPONENT,
  ];
  for (const lbl of labels) {
    for (const node of store.listNodesByLabel(orgId, lbl, 10000)) {
      const incoming = store.listEdgesTo(orgId, node.qualifiedName).length;
      const fresh = freshnessScore(node, now);
      const reasons: string[] = [];
      // Score formula: lower = more dead. weight 0.6 freshness + 0.4 incoming.
      const incomingScore = incoming === 0 ? 0 : Math.min(1, incoming / 5);
      if (incoming === 0) reasons.push("no_incoming_edges");
      if (fresh < 0.4) reasons.push("stale_freshness");
      const score = 0.6 * fresh + 0.4 * incomingScore;
      let confidence: "high" | "medium" | "low";
      if (score < 0.2) confidence = "high";
      else if (score < 0.45) confidence = "medium";
      else confidence = "low";
      // Only persist potentially-dead candidates
      if (incoming > 0 && fresh >= 0.5) continue;
      stmt.run(orgId, node.qualifiedName, score, confidence, JSON.stringify(reasons), now);
      n += 1;
    }
  }
  return n;
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

export async function populateAnalysisTables(
  store: GraphStore,
  orgId: OrgId,
  db: BetterSqlite3Database,
): Promise<PopulateCounts> {
  const findings = populateSecurityFindings(store, orgId, db);
  const deadCode = populateDeadCodeScores(store, orgId, db);
  const governor = populateGovernorRisks(store, orgId, db);
  const testCov = populateTestCoverage(store, orgId, db);
  return { findings, deadCode, governor, testCov };
}
