import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ParseResult } from "../parsers/contract.js";
import type { MemberParse } from "./parse-member.js";

/**
 * Task 11c: what a parsed member owns — the qnames of the nodes it emitted
 * and the sources of the edges it emitted. Delta ingest deletes and re-derives
 * exactly these when the member changes or disappears.
 */
export function ownedQnames(result: Pick<ParseResult, "nodes" | "edges">): string[] {
  const out = new Set<string>();
  for (const n of result.nodes) out.add(String(n.qualifiedName));
  for (const e of result.edges) out.add(String(e.srcQualifiedName));
  return [...out];
}

let generation: string | undefined;
/**
 * The generation stamped on member rows: the sfgraph-core version. A member's
 * hash covers only its content, not the parsers that read it, so a delta
 * under another build would keep the old build's output for every unchanged
 * member. Delta compares this to the stamp and rebuilds on a mismatch. Any
 * release can change parser output, so the version (not a hand-bumped salt)
 * is the safe key; "unknown" never matches, which errs towards a rebuild.
 */
export function memberRowsGeneration(): string {
  if (generation !== undefined) return generation;
  generation = "unknown";
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/ingest or dist/ingest → ../../package.json
  for (const p of [
    path.join(here, "..", "..", "package.json"),
    path.join(here, "..", "package.json"),
  ]) {
    try {
      const pkg = JSON.parse(readFileSync(p, "utf8")) as { name?: string; version?: string };
      if (pkg.name === "@ryanstark24/sfgraph-core" && pkg.version) {
        generation = `core@${pkg.version}`;
        break;
      }
    } catch {
      // try the next candidate
    }
  }
  return generation;
}

/** Content hash of a member (what its parse depends on). */
export function memberContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const PARSE_ERROR = "ParseError:";

/** The parse produced nothing but ParseError nodes (a malformed file). */
export function isParseFailureOnly(owned: readonly string[]): boolean {
  return owned.length > 0 && owned.every((q) => q.startsWith(PARSE_ERROR));
}

/**
 * A member that could not be read or parsed keeps the graph its last good
 * parse produced (a transient bad read must not lose data) — if that parse
 * owned anything but parse errors.
 */
export function hasGoodPriorOwned(prior: { owned: readonly string[] } | undefined): boolean {
  return !!prior && prior.owned.some((q) => !q.startsWith(PARSE_ERROR));
}

/**
 * The parser itself threw on the member's content (deterministic), as opposed
 * to the parse pool losing its worker (`phase: "worker"`, transient, N4-1).
 */
export function parseThrew(outcome: MemberParse): boolean {
  return outcome.kind === "error" && outcome.phase !== "worker" && outcome.phase !== "quarantined";
}

/**
 * T15 N5-1: consecutive worker crashes or stalls on the same content before
 * the member is quarantined (recorded as failed, skipped until it changes).
 */
export const WORKER_FAILURE_LIMIT = 3;
/** Row hash prefix of a quarantined member: `q:<content sha>`. */
const QUARANTINED = "q:";
/** Row hash of a member whose worker failed n (< limit) times: `w<n>:<sha>`. */
const WORKER_FAILED = /^w(\d+):([0-9a-f]{64})$/;

/** The row says this exact content is quarantined. */
export function isQuarantinedFor(row: { hash: string } | undefined, sha: string): boolean {
  return !!row && row.hash === `${QUARANTINED}${sha}`;
}
export function isQuarantinedRow(row: { hash: string }): boolean {
  return row.hash.startsWith(QUARANTINED);
}
/** Recorded hash `rowHash` stands for content `sha` (plain or quarantined). */
export function rowHashMatches(rowHash: string, sha: string): boolean {
  return rowHash !== "" && (rowHash === sha || rowHash === `${QUARANTINED}${sha}`);
}

/** The outcome the pool reports, without parsing, for a quarantined member. */
export function quarantinedOutcome(): MemberParse {
  return {
    kind: "error",
    phase: "quarantined",
    message: `parse workers failed ${WORKER_FAILURE_LIMIT} times in a row on this content; skipped until it changes`,
    parseMs: 0,
  };
}

/**
 * Fingerprint and hash for a member that failed (parse threw, merge failed,
 * worker lost, or quarantined). A worker failure counts up per content hash:
 * below the limit the row is retried by every delta (empty fingerprint), at
 * the limit it is quarantined (fingerprint kept, `q:<sha>`) and skipped until
 * its content changes. Everything else is failedMemberStamp.
 */
export function memberFailureStamp(
  member: { fingerprint?: string; content: string },
  outcome: MemberParse,
  errored: boolean,
  prior: { hash: string } | undefined,
): { fingerprint: string; hash: string } {
  if (outcome.kind === "error" && (outcome.phase === "worker" || outcome.phase === "quarantined")) {
    const sha = memberContentHash(member.content);
    const m = prior ? WORKER_FAILED.exec(prior.hash) : null;
    const n =
      outcome.phase === "quarantined"
        ? WORKER_FAILURE_LIMIT
        : (m && m[2] === sha ? Number(m[1]) : 0) + 1;
    if (n >= WORKER_FAILURE_LIMIT) {
      return { fingerprint: member.fingerprint ?? "", hash: `${QUARANTINED}${sha}` };
    }
    return { fingerprint: "", hash: `w${n}:${sha}` };
  }
  return failedMemberStamp(member, !errored || parseThrew(outcome));
}

/**
 * Fingerprint and hash recorded for a member whose parse or merge failed. A
 * parse that threw on content read fine is a function of that content: it
 * fails again until the file changes, so its fingerprint and hash are kept
 * and deltas skip it (as N2-1 does for a ParseError-only member). A failure
 * while merging a good parse, or a lost parse worker, may be transient: an
 * empty fingerprint and hash make every delta retry it.
 */
export function failedMemberStamp(
  member: { fingerprint?: string; content: string },
  parseThrew: boolean,
): { fingerprint: string; hash: string } {
  if (!parseThrew) return { fingerprint: "", hash: "" };
  return { fingerprint: member.fingerprint ?? "", hash: memberContentHash(member.content) };
}
