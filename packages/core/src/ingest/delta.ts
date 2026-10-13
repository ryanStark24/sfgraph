import { type Logger, type OrgId, asQualifiedName } from "@ryanstark24/sfgraph-shared";
import type {
  IndexedMember,
  MetadataSource,
  RawMember,
} from "../extractors/interfaces/metadata-source.js";
import type { MemberRow } from "../storage/interfaces.js";
import type { DeletedEdge, NodeStamp, SqliteGraphStore } from "../storage/sqlite/graph-store.js";
import { type LiveIngestOpts, type LiveIngestResult, liveIngest } from "./live-ingest.js";
import { acquireIngestLock } from "./lock.js";
import {
  failedMemberStamp,
  hasGoodPriorOwned,
  isParseFailureOnly,
  isQuarantinedRow,
  memberContentHash,
  memberFailureStamp,
  memberRowsGeneration,
  ownedQnames,
  rowHashMatches,
} from "./member-rows.js";
import { parseMember } from "./parse-member.js";

/**
 * Task 11c: project delta ingestion.
 *
 * A full `--project` ingest records, per member, its fingerprint (file sizes
 * + mtimes), content hash and the qnames it owns (`_sfgraph_members`). A delta
 * compares the tree against those rows (`planDelta`) and re-derives only what
 * changed (`applyDelta`), producing the graph a full rebuild of the tree
 * would. The judge is the same-output test (delta.test.ts).
 *
 * applyDelta:
 *  1. Replay set R: the changed / added / deleted members, closed over shared
 *     ownership (two members emitting the same qname are re-merged together,
 *     in source order, so last-merge-wins matches a rebuild), plus members
 *     whose edges a resolver moved onto a qname that changed (arity,
 *     interface retarget, formula hop, CANONICAL_OF).
 *  2. Delete every outgoing edge of R's qnames and mark R's old nodes with a
 *     sentinel source hash; re-parse and merge R through liveIngest. Nodes
 *     still carrying the sentinel were not re-emitted: they (and the
 *     reflection edges into them) are deleted. Incoming parser edges stay and
 *     dangle, exactly as in a rebuild.
 *  3. Resolvers: the self-pruning ones (flow, vlocity-apex, DR, LWC,
 *     name-match) and cross-flavor / overlap run over the graph (they are
 *     cheap and re-derive their own output); interface retarget, arity,
 *     formula hop and the reflection walker run scoped to what can have
 *     changed. The audit (report only) is skipped.
 *  4. Dead code is recomputed (populate).
 *  5. The member rows are updated and the pending marker cleared.
 *
 * `_sfgraph_delta_pending` holds the qnames being rewritten from step 2 until
 * step 5: an interrupted delta leaves it set, and the next delta replays
 * their owners with every resolver at full scope.
 */

const SENTINEL = "\u0000stale";
const SILENT: Logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
/** Above this many added/removed bare names, re-walk reflection fully. */
const MAX_REFLECTION_NEEDLES = 25;

export interface DeltaPlan {
  added: string[];
  changed: string[];
  deleted: string[];
  unchanged: number;
  /** The graph has no member rows (built by an older sfgraph, or interrupted). */
  legacy: boolean;
  /**
   * The member rows were written by another sfgraph build (or by one that did
   * not record its build): unchanged members still carry that build's parser
   * output, so only a full rebuild gives the graph a rebuild would.
   */
  staleGeneration: { recorded: string | null; current: string } | null;
  /** Every present member, in source order. */
  members: IndexedMember[];
  /** Loaded content of the added / changed members. */
  loaded: Map<string, RawMember>;
  /** Rows of members whose fingerprint moved but content did not. */
  refreshed: MemberRow[];
  /**
   * Present members that could not be read or parsed: they keep their
   * previous graph and row (fingerprint cleared, so the next delta retries).
   */
  kept: string[];
  /** The rows the plan was made against. */
  rows: Map<string, MemberRow>;
}

function keep(plan: DeltaPlan, m: IndexedMember, row: MemberRow): void {
  if (!plan.members.includes(m)) plan.members.push(m);
  plan.kept.push(m.key);
  plan.unchanged += 1;
  plan.refreshed.push({ ...row, fingerprint: "" });
}

/** Compare the source against the recorded member rows. */
export async function planDelta(
  store: SqliteGraphStore,
  orgId: OrgId,
  source: MetadataSource,
  generation: string = memberRowsGeneration(),
): Promise<DeltaPlan> {
  if (!source.iterIndexed) throw new Error("delta: the metadata source cannot be indexed");
  const rows = new Map(store.listMemberRows(orgId).map((r) => [r.key, r]));
  const plan: DeltaPlan = {
    added: [],
    changed: [],
    deleted: [],
    unchanged: 0,
    legacy: rows.size === 0,
    staleGeneration: null,
    members: [],
    loaded: new Map(),
    refreshed: [],
    kept: [],
    rows,
  };
  if (plan.legacy) return plan;
  const recorded = store.getMemberRowsGeneration(orgId);
  if (recorded !== generation) {
    plan.staleGeneration = { recorded, current: generation };
    return plan;
  }
  const seen = new Set<string>();
  for await (const m of source.iterIndexed()) {
    if (seen.has(m.key)) continue;
    const row = rows.get(m.key);
    if (row && row.fingerprint !== "" && row.fingerprint === m.fingerprint) {
      seen.add(m.key);
      plan.members.push(m);
      plan.unchanged += 1;
      continue;
    }
    const raw = await m.load();
    if (!raw || raw.unreadable) {
      // Unreadable / malformed. New: absent, as in a rebuild. Known: a
      // transient bad read must not lose data — keep its previous graph.
      if (row) {
        seen.add(m.key);
        keep(plan, m, row);
      }
      continue;
    }
    seen.add(m.key);
    plan.members.push(m);
    const hash = memberContentHash(raw.content);
    // A quarantined row (T15 N5-1) matches its content too: skipped until it changes.
    if (row && rowHashMatches(row.hash, hash)) {
      plan.unchanged += 1;
      plan.refreshed.push({ ...row, fingerprint: m.fingerprint });
      continue;
    }
    plan.loaded.set(m.key, raw);
    (row ? plan.changed : plan.added).push(m.key);
  }
  for (const key of rows.keys()) if (!seen.has(key)) plan.deleted.push(key);
  return plan;
}

export type DeltaLiveOpts = Omit<LiveIngestOpts, "mode" | "rebuild" | "delta" | "graphStore"> & {
  graphStore: SqliteGraphStore;
  preResolved: NonNullable<LiveIngestOpts["preResolved"]>;
  metadataSource: MetadataSource;
};

const lower = (q: string): string => q.toLowerCase();
const METHOD_CLASS = /^ApexMethod:(.+)\.[^.(]+\(/i;

function bareName(q: string): string {
  const i = q.indexOf(":");
  return i >= 0 ? q.slice(i + 1) : q;
}

/** LIKE matching is ASCII-case-insensitive only: re-walk fully otherwise. */
function nonAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return true;
  return false;
}

function pairDiff(a: Set<string>, b: Set<string>): string[] {
  const out: string[] = [];
  for (const k of a) if (!b.has(k)) out.push(k);
  for (const k of b) if (!a.has(k)) out.push(k);
  return out;
}

/**
 * Apply a plan. Returns null when nothing had to be re-derived (no-op: only
 * fingerprints were refreshed), else the merge step's LiveIngestResult.
 */
export async function applyDelta(
  plan: DeltaPlan,
  opts: DeltaLiveOpts,
): Promise<LiveIngestResult | null> {
  const store = opts.graphStore;
  const orgId = opts.preResolved.orgId;
  const pending = store.getDeltaPending(orgId);
  const recovering = pending !== null;
  const log = opts.logger ?? SILENT;

  // New owned qnames of the added / changed members (main-thread pre-parse).
  // A known member that no longer parses (error, or only ParseError nodes)
  // keeps its previous graph, like an unreadable one. A ParseError-only one
  // is still merged, as a full ingest does (N-4): its ParseError nodes land
  // and its row owns prior + ParseError.
  const parseBase = { orgId: String(orgId), parseTimestamp: new Date().toISOString() };
  const newOwned = new Map<string, string[]>();
  const mergeOnly: string[] = [];
  for (const key of [...plan.added, ...plan.changed]) {
    const raw = plan.loaded.get(key);
    if (!raw) continue;
    const out = await parseMember(raw.ref, raw.content, parseBase, log);
    const owned = out.kind === "parsed" ? ownedQnames(out.result) : [];
    const row = plan.rows.get(key);
    if ((out.kind === "error" || isParseFailureOnly(owned)) && row && hasGoodPriorOwned(row)) {
      plan.changed = plan.changed.filter((k) => k !== key);
      plan.kept.push(key);
      plan.unchanged += 1;
      if (out.kind === "error") {
        // The parse threw on content read fine: it keeps its graph, and its
        // row the hash of the broken content (skipped until it changes).
        plan.loaded.delete(key);
        plan.refreshed.push({ ...row, ...failedMemberStamp(raw, true) });
      } else {
        mergeOnly.push(key);
        newOwned.set(key, owned);
      }
      continue;
    }
    newOwned.set(key, owned);
  }
  if (plan.kept.length) {
    log.warn("delta: unreadable / unparseable members keep their previous graph", {
      members: plan.kept.slice(0, 20),
    });
  }
  const nothingChanged =
    plan.added.length === 0 &&
    plan.changed.length === 0 &&
    plan.deleted.length === 0 &&
    mergeOnly.length === 0;
  if (nothingChanged && !recovering) {
    if (plan.refreshed.length) store.upsertMemberRows(orgId, plan.refreshed);
    return null;
  }
  const ownedOf = (key: string): string[] => [
    ...(plan.rows.get(key)?.owned ?? []),
    ...(newOwned.get(key) ?? []),
  ];

  // ── 1. Replay set R ────────────────────────────────────────────────────
  const owners = new Map<string, Set<string>>();
  const addOwner = (q: string, key: string): void => {
    let s = owners.get(lower(q));
    if (!s) {
      s = new Set();
      owners.set(lower(q), s);
    }
    s.add(key);
  };
  for (const [key, row] of plan.rows) for (const q of row.owned) addOwner(q, key);
  for (const [key, qs] of newOwned) for (const q of qs) addOwner(q, key);

  const D = new Set<string>();
  for (const key of [...plan.changed, ...plan.deleted]) {
    for (const q of plan.rows.get(key)?.owned ?? []) D.add(q);
  }
  for (const qs of newOwned.values()) {
    for (const q of qs) if (q.startsWith("ApexClass:")) D.add(`ApexInterface:${bareName(q)}`);
  }
  for (const q of pending ?? []) D.add(q);

  const kept = new Set(plan.kept);
  const R = new Set<string>();
  const queue: string[] = [];
  const enqueue = (key: string): void => {
    if (R.has(key) || kept.has(key)) return;
    R.add(key);
    queue.push(key);
  };
  for (const key of [...plan.added, ...plan.changed, ...plan.deleted]) enqueue(key);
  for (const q of pending ?? []) for (const k of owners.get(lower(q)) ?? []) enqueue(k);
  // Dependents: sources of edges a resolver moved onto (or paired with) a
  // qname in D.
  for (const e of store.listEdgesToAny(orgId, D)) {
    const a = (e.attributes ?? {}) as Record<string, unknown>;
    const moved =
      e.relType === "CANONICAL_OF" ||
      a.arityResolvedFrom != null ||
      a.retargetedFrom != null ||
      a.hopResolvedFrom != null;
    if (!moved) continue;
    for (const k of owners.get(lower(String(e.srcQualifiedName))) ?? []) enqueue(k);
  }
  while (queue.length) {
    const key = queue.pop() as string;
    for (const q of ownedOf(key)) for (const k of owners.get(lower(q)) ?? []) enqueue(k);
  }
  // Merged for their ParseError nodes only; their prior graph is protected below.
  for (const key of mergeOnly) R.add(key);

  // What a kept member owns is left exactly as it is.
  const keptOwned = new Set<string>();
  for (const key of kept) for (const q of plan.rows.get(key)?.owned ?? []) keptOwned.add(lower(q));
  const oldOwnedR = new Set<string>();
  const newOwnedR = new Set<string>();
  const presentKeys = new Set(plan.members.map((m) => m.key));
  for (const key of R) {
    for (const q of plan.rows.get(key)?.owned ?? []) if (!keptOwned.has(lower(q))) oldOwnedR.add(q);
    if (!presentKeys.has(key)) continue;
    for (const q of newOwned.get(key) ?? plan.rows.get(key)?.owned ?? []) {
      if (!keptOwned.has(lower(q))) newOwnedR.add(q);
    }
  }
  const touched = new Set([...oldOwnedR, ...newOwnedR]);
  // A node re-emitted in another case (`Util` -> `UTIL`) is the same row
  // (NOCASE), and a merge keeps the stored spelling; a rebuild has the new
  // one. Such nodes are deleted before the merge so it inserts them afresh.
  const newSpellings = new Map<string, Set<string>>();
  for (const q of newOwnedR) {
    let set = newSpellings.get(lower(q));
    if (!set) {
      set = new Set();
      newSpellings.set(lower(q), set);
    }
    set.add(q);
  }
  const respelled = [...oldOwnedR].filter((q) => {
    const set = newSpellings.get(lower(q));
    return set !== undefined && !set.has(q);
  });

  // ── 2. Clear R's old output ────────────────────────────────────────────
  const resolverPairsBefore = store.listResolverReferencePairs(orgId);
  const canonBefore = store.listCanonicalPairs(orgId);
  const existedBefore = store.existingQnames(orgId, newOwnedR);
  store.setDeltaPending(orgId, [...new Set([...touched, ...(pending ?? [])])]);
  const carried: DeletedEdge[] = store.deleteEdgesFrom(orgId, touched);
  const stamps = store.getNodeStamps(orgId, oldOwnedR);
  store.setNodeSourceHash(orgId, oldOwnedR, SENTINEL);
  const vectorStore = opts.vectorStore as
    | { deleteNodeVector?: (o: OrgId, q: ReturnType<typeof asQualifiedName>) => void }
    | undefined;
  const dropNodes = (qs: readonly string[]): void => {
    store.transaction(() => {
      for (const q of qs) {
        const qn = asQualifiedName(q);
        store.deleteNode(orgId, qn);
        try {
          vectorStore?.deleteNodeVector?.(orgId, qn);
        } catch {
          /* a missing vector is fine */
        }
      }
    });
  };
  if (respelled.length) dropNodes(respelled);
  if (process.env.SFGRAPH_DELTA_ABORT_AFTER === "clear") {
    throw new Error("delta: aborted after clearing (SFGRAPH_DELTA_ABORT_AFTER=clear)");
  }

  const rowsOut = new Map<string, MemberRow>();
  let removed: string[] = [];
  const members = async function* (): AsyncIterable<RawMember> {
    for (const m of plan.members) {
      if (!R.has(m.key)) continue;
      const raw = plan.loaded.get(m.key) ?? (await m.load());
      if (raw) yield raw;
    }
  };
  // Prior owned of members whose merge-time parse failed (the pre-parse
  // passed): their nodes keep the stamps they had.
  const keepInMerge = new Map<string, NodeStamp>();

  const result = await liveIngest({
    ...opts,
    mode: "full",
    rebuild: false,
    // I-4: a delta never copies the whole graph into a snapshot.
    skipSnapshot: true,
    delta: {
      members: members(),
      onMember(member, outcome, errored) {
        const key = member.ref.sourceUri;
        const owned = outcome.kind === "parsed" ? ownedQnames(outcome.result) : [];
        const prior = plan.rows.get(key);
        if ((errored || isParseFailureOnly(owned)) && hasGoodPriorOwned(prior)) {
          const ownedKept = [...new Set([...(prior?.owned ?? []), ...owned])];
          // N2-1: a ParseError-only member, or one whose parse threw, records
          // the hash of its broken content (skipped until it changes); one
          // whose merge failed retries.
          rowsOut.set(key, {
            key,
            ...memberFailureStamp(member, outcome, errored, prior),
            owned: ownedKept,
          });
          for (const q of prior?.owned ?? []) {
            for (const [sq, st] of stamps) if (lower(sq) === lower(q)) keepInMerge.set(sq, st);
          }
          return;
        }
        rowsOut.set(
          key,
          errored
            ? { key, ...memberFailureStamp(member, outcome, true, prior), owned: [] }
            : {
                key,
                fingerprint: member.fingerprint ?? "",
                hash: memberContentHash(member.content),
                owned,
              },
        );
      },
      afterMerge() {
        if (keepInMerge.size) {
          store.restoreNodeStamps(orgId, keepInMerge, { when: "hash-is", hash: SENTINEL });
        }
        removed = store.listNodesWithSourceHash(orgId, SENTINEL);
        if (removed.length) {
          store.transaction(() => {
            store.deleteEdgesFrom(orgId, removed);
            store.deleteReflectionEdges(orgId, { dsts: removed });
          });
          dropNodes(removed);
        }
        // M-2: a node re-merged with identical content was not modified.
        store.restoreNodeStamps(orgId, stamps, { when: "unchanged" });
        if (process.env.SFGRAPH_DELTA_ABORT_AFTER === "merge") {
          throw new Error("delta: aborted after merge (SFGRAPH_DELTA_ABORT_AFTER=merge)");
        }
      },
      quarantinedCount() {
        const refreshed = new Map(plan.refreshed.map((r) => [r.key, r]));
        const deleted = new Set(plan.deleted);
        let n = 0;
        for (const [key, row] of plan.rows) {
          if (deleted.has(key) && !rowsOut.has(key)) continue;
          if (isQuarantinedRow(rowsOut.get(key) ?? refreshed.get(key) ?? row)) n += 1;
        }
        for (const [key, row] of rowsOut) if (!plan.rows.has(key) && isQuarantinedRow(row)) n += 1;
        return n;
      },
      arityScope() {
        if (recovering) return undefined;
        const classNames = new Set<string>();
        for (const q of touched) {
          const m = METHOD_CLASS.exec(q);
          if (m?.[1]) classNames.add(m[1]);
        }
        return { srcs: newOwnedR, classNames };
      },
      retargetInterfaceNames() {
        if (recovering) return undefined;
        const names = new Set<string>();
        for (const q of touched) {
          if (q.startsWith("ApexClass:") || q.startsWith("ApexInterface:")) {
            names.add(lower(bareName(q)));
          }
        }
        // Guesses the re-parsed members emitted at `ApexClass:X`.
        for (const src of newOwnedR) {
          for (const e of store.listEdgesFrom(orgId, asQualifiedName(src))) {
            const d = String(e.dstQualifiedName);
            if (d.startsWith("ApexClass:")) names.add(lower(bareName(d)));
          }
        }
        return names;
      },
      hopSources() {
        if (recovering) return undefined;
        for (const q of touched) if (q.startsWith("CustomField:")) return undefined;
        return newOwnedR;
      },
      reflectionSources() {
        const full = (): undefined => {
          store.deleteReflectionEdges(orgId);
          return undefined;
        };
        if (recovering) return full();
        const addedNow = [...store.existingQnames(orgId, newOwnedR)].filter(
          (q) => !existedBefore.has(q),
        );
        const needles = [...new Set([...addedNow, ...removed].map(bareName))].filter(
          (n) => n.length > 0,
        );
        if (needles.length > MAX_REFLECTION_NEEDLES || needles.some(nonAscii)) {
          return full();
        }
        const srcs = new Set<string>(store.existingQnames(orgId, newOwnedR));
        for (const q of store.findNodesMentioning(orgId, needles)) srcs.add(q);
        const changedPairs = [
          ...pairDiff(resolverPairsBefore, store.listResolverReferencePairs(orgId)),
          ...pairDiff(canonBefore, store.listCanonicalPairs(orgId)),
        ];
        const sep = String.fromCharCode(31);
        const endpoints = new Set<string>();
        for (const p of changedPairs) {
          const i = p.indexOf(sep);
          endpoints.add(p.slice(0, i));
          // CANONICAL_OF adds `flavors` to both ends' attributes.
          endpoints.add(p.slice(i + 1));
        }
        // Pairs are lower-cased: map back to stored spelling.
        for (const q of store.existingQnamesNocase(orgId, endpoints)) srcs.add(q);
        store.deleteReflectionEdges(orgId, { srcs });
        return srcs;
      },
      finalize() {
        const keep = [...rowsOut.values(), ...plan.refreshed];
        store.upsertMemberRows(orgId, keep);
        store.deleteMemberRows(
          orgId,
          plan.deleted.filter((k) => !rowsOut.has(k)),
        );
        store.restoreEdgeFirstSeen(orgId, carried);
        store.clearDeltaPending(orgId);
      },
    },
  });
  return result;
}

export interface RunDeltaOpts extends DeltaLiveOpts {
  /** Take `<lockDir>/<orgId>.ingest.lock` for the run (the CLI holds its own). */
  lockDir?: string;
  /** A full rebuild of the project (legacy graph). */
  fullRebuild: () => Promise<unknown>;
  /**
   * Where the one-line run summary goes (default console.log, which the CLI and the bench
   * scripts read). A caller that must keep member counts out of its output passes a no-op.
   */
  report?: (line: string) => void;
}

export interface RunDeltaResult {
  kind: "delta" | "full";
  added: number;
  changed: number;
  deleted: number;
  unchanged: number;
  elapsedMs: number;
  result?: LiveIngestResult;
}

/** `sfgraph ingest --project <p> --delta`: plan, apply, report. */
export async function runDeltaIngest(opts: RunDeltaOpts): Promise<RunDeltaResult> {
  const t0 = Date.now();
  const orgId = opts.preResolved.orgId;
  const lock = opts.lockDir
    ? acquireIngestLock({ dir: opts.lockDir, orgId: String(orgId), orgLabel: opts.alias })
    : null;
  try {
    const { lockDir: _l, fullRebuild, report = console.log, ...live } = opts;
    const plan = await planDelta(opts.graphStore, orgId, opts.metadataSource);
    if (plan.legacy || plan.staleGeneration) {
      const g = plan.staleGeneration;
      report(
        g
          ? `delta: graph was built by ${g.recorded ?? "an earlier sfgraph build"}, not ${g.current}; running full rebuild so every member gets the current parsers`
          : "delta: graph has no member hashes (built by an older sfgraph); running full rebuild",
      );
      await fullRebuild();
      return {
        kind: "full",
        added: 0,
        changed: 0,
        deleted: 0,
        unchanged: 0,
        elapsedMs: Date.now() - t0,
      };
    }
    const result = await applyDelta(plan, live);
    const elapsedMs = Date.now() - t0;
    report(
      `delta: +${plan.added.length} ~${plan.changed.length} -${plan.deleted.length} (=${plan.unchanged} unchanged) in ${(elapsedMs / 1000).toFixed(1)}s`,
    );
    return {
      kind: "delta",
      added: plan.added.length,
      changed: plan.changed.length,
      deleted: plan.deleted.length,
      unchanged: plan.unchanged,
      elapsedMs,
      ...(result ? { result } : {}),
    };
  } finally {
    lock?.release();
  }
}
