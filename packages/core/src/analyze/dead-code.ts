import type { OrgId, QualifiedName } from "@ryanstark24/sfgraph-shared";
import { type EdgeFact, type NodeFact, REL_TYPES } from "../domain/index.js";
import { METADATA_CATEGORY } from "../domain/metadata-category.js";
import type { GraphStore } from "../storage/interfaces.js";
import { isMemberContainmentEdge, listMembers, membersReader, ownerOf } from "./containment.js";
import { freshnessScore } from "./freshness.js";

/** The LWC parser (filesystem and live-org ingest alike) labels component
 *  nodes "LWC"; `METADATA_CATEGORY.LWC` is the member type
 *  "LightningComponentBundle", kept in case an older store uses it. */
export const LWC_NODE_LABEL = "LWC";

/** Labels the dead-code audit covers. One list for `findDeadCode` and the
 *  `_sfgraph_dead_code_scores` cache, so both produce the same candidates. */
export const DEAD_CODE_LABELS: readonly string[] = [
  METADATA_CATEGORY.APEX_CLASS,
  LWC_NODE_LABEL,
  METADATA_CATEGORY.LWC,
  METADATA_CATEGORY.FLOW,
  METADATA_CATEGORY.APEX_PAGE,
  METADATA_CATEGORY.APEX_COMPONENT,
];

const DEAD_CODE_NODE_CAP = 10000;

/** Bundle container label -> the component label it contains. */
const BUNDLE_COMPONENT_LABEL: Readonly<Record<string, string>> = {
  LWCBundle: LWC_NODE_LABEL,
};

type EdgeLike = {
  relType: unknown;
  attributes: unknown;
  srcQualifiedName: unknown;
  dstQualifiedName: unknown;
};

const nameOf = (q: unknown): string => {
  const s = String(q);
  return s.slice(s.indexOf(":") + 1);
};

/** ASCII-only lowercase: what the store's NOCASE qname columns fold. */
const nocase = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

const labelOf = (q: unknown): string => {
  const s = String(q);
  return s.slice(0, Math.max(0, s.indexOf(":")));
};

/** A component's own bundle container, e.g. `LWCBundle:x -CONTAINS_COMPONENT-> LWC:x`
 *  (paired labels from BUNDLE_COMPONENT_LABEL, same name). Structural, never usage.
 *  Any other bundle label containing the node is a real reference. */
function isOwnBundleEdge(e: EdgeLike): boolean {
  if (String(e.relType) !== "CONTAINS_COMPONENT") return false;
  const component = BUNDLE_COMPONENT_LABEL[labelOf(e.srcQualifiedName)];
  return (
    component !== undefined &&
    component === labelOf(e.dstQualifiedName) &&
    nameOf(e.srcQualifiedName) === nameOf(e.dstQualifiedName)
  );
}

/**
 * A Custom Metadata record field naming exactly one Apex class
 * (`Handler__c = 'MyHandler'`) is how metadata-driven dispatch
 * (`Type.forName(record.Handler__c)`) wires that class: the reflection
 * walker's unambiguous CustomMetadataRecord -> ApexClass edge is usage.
 */
function isCmdtClassReflection(e: EdgeLike): boolean {
  const a = (e.attributes as Record<string, unknown>) ?? {};
  return (
    a.ambiguous !== true &&
    labelOf(e.srcQualifiedName) === "CustomMetadataRecord" &&
    labelOf(e.dstQualifiedName) === "ApexClass"
  );
}

/** An object's edges to its own parts: the field, validation rule or record type exists on the
 *  object; nothing uses it through these. Counting them kept every field "in use". */
const OWNER_STRUCTURE_RELTYPES: ReadonlySet<string> = new Set([
  REL_TYPES.DEFINES_FIELD,
  REL_TYPES.HAS_VALIDATION_RULE,
  REL_TYPES.HAS_RECORD_TYPE,
]);

/** Grants, reflection guesses (bar CMDT-named classes), own-bundle and member
 *  containment, and an object's own structure are never usage. */
function isRealRef(e: EdgeLike): boolean {
  if (String(e.relType).startsWith("GRANTS_")) return false;
  if (OWNER_STRUCTURE_RELTYPES.has(String(e.relType))) return false;
  if (
    (e.attributes as Record<string, unknown>)?.source === "reflection" &&
    !isCmdtClassReflection(e)
  )
    return false;
  if (isOwnBundleEdge(e)) return false;
  if (isMemberContainmentEdge(e)) return false;
  return true;
}

/** `LWC:x -REFERENCES{via:compiled-omniscript}-> OmniScript:…`: the compiled
 *  runtime of the OmniScript (LWC parser, `_def.js`). */
function isCompileEdge(e: EdgeLike): boolean {
  return (
    String(e.relType) === "REFERENCES" &&
    (e.attributes as Record<string, unknown>)?.via === "compiled-omniscript"
  );
}

/** Is the edge's source test code? Memoised per audit run. */
export type TestSourceCheck = (src: QualifiedName) => boolean;

/**
 * A source is test code when its node is `@isTest` (an @isTest class, a
 * TestMethod) or it is a member of an @isTest class (an untagged helper method
 * inside a test class).
 */
export function makeTestSourceCheck(store: GraphStore, orgId: OrgId): TestSourceCheck {
  const memo = new Map<string, boolean>();
  // Memoised too: every method of a class asks about the same owner.
  const taggedMemo = new Map<string, boolean>();
  // Every `isTest: true` node of the org, read once (NOCASE keys, like
  // getNode's lookup). Null: the store cannot list them (or the read failed),
  // so each node is read on its own.
  let testTagged: Set<string> | null | undefined;
  const tagged = (q: QualifiedName): boolean => {
    const key = String(q);
    let v = taggedMemo.get(key);
    if (v === undefined) {
      if (testTagged === undefined) {
        try {
          const s = store.listNodesWithTrueAttribute?.(orgId, "isTest");
          testTagged = s ? new Set([...s].map(nocase)) : null;
        } catch {
          testTagged = null;
        }
      }
      if (testTagged) {
        v = testTagged.has(nocase(key));
      } else {
        const n = store.getNode(orgId, q);
        v = n !== null && isTestClass(n);
      }
      taggedMemo.set(key, v);
    }
    return v;
  };
  return (src) => {
    const key = String(src);
    let v = memo.get(key);
    if (v === undefined) {
      const owner = tagged(src) ? null : ownerOf(store, orgId, src);
      v = owner === null ? tagged(src) : tagged(owner);
      memo.set(key, v);
    }
    return v;
  };
}

export interface IncomingRefs {
  /** Real usage references from production code. */
  real: number;
  /** References that would be real but come from test code (or IS_TEST_FOR). */
  testOnly: number;
}

/**
 * Count incoming edges that represent a REAL usage reference. Excludes:
 *  - permission grants (`GRANTS_*`) — being readable by a profile is not usage;
 *  - reflection-sourced edges (`attributes.source === 'reflection'`) — these are
 *    low-confidence, pattern-matched guesses, not proof the node is invoked;
 *  - the component's own bundle `CONTAINS_COMPONENT` (every LWC has one);
 *  - member containment (`CONTAINS_METHOD`): a method's own class is structure;
 *  - an object's own structure (`DEFINES_FIELD`, `HAS_VALIDATION_RULE`,
 *    `HAS_RECORD_TYPE`): a field is not used by the object that defines it.
 * Counting any of these as a reference kept genuinely dead code "alive" in the audit.
 *
 * References from test code (`IS_TEST_FOR`, @isTest classes, test methods and
 * members of @isTest classes) are counted apart in `testOnly`. They are
 * references too (`deadCodeKind`): a class with test references only is not
 * dead but `referenced-only-by-tests`, listed apart from the dead code.
 *
 * A reference to a member is a reference to its owner (containment.ts): edges
 * into an ApexClass's methods count for the class. Edges from the node itself
 * or its own members (internal calls) do not.
 *
 * The compiled-LWC → OmniScript edge is not usage by itself: it counts only
 * when that LWC is itself launched by something real (same rules, and not
 * the OmniScript itself), so liveness follows the launch path.
 */
export function incomingRefs(
  store: GraphStore,
  orgId: OrgId,
  qname: QualifiedName,
  isTestSource: TestSourceCheck = makeTestSourceCheck(store, orgId),
): IncomingRefs {
  return countIncomingRefs(
    store,
    orgId,
    qname,
    [qname, ...listMembers(store, orgId, qname)],
    (target) => store.listEdgesTo(orgId, target),
    isTestSource,
  );
}

/**
 * incomingRefs over given `targets` (the node and its members), with every
 * target's incoming edges from `edgesTo` (the rows `listEdgesTo` returns,
 * in any order: only counts come out).
 */
function countIncomingRefs(
  store: GraphStore,
  orgId: OrgId,
  qname: QualifiedName,
  targets: readonly QualifiedName[],
  edgesTo: (target: QualifiedName) => readonly EdgeFact[],
  isTestSource: TestSourceCheck,
): IncomingRefs {
  const self = new Set<string>(targets);
  const out: IncomingRefs = { real: 0, testOnly: 0 };
  const fromTest = (e: EdgeLike & { srcQualifiedName: QualifiedName }) =>
    String(e.relType) === REL_TYPES.IS_TEST_FOR || isTestSource(e.srcQualifiedName);
  for (const target of targets) {
    for (const e of edgesTo(target)) {
      if (self.has(String(e.srcQualifiedName))) continue;
      if (!isRealRef(e)) continue;
      if (
        isCompileEdge(e) &&
        !store
          .listEdgesTo(orgId, e.srcQualifiedName)
          .some((x) => isRealRef(x) && String(x.srcQualifiedName) !== String(qname) && !fromTest(x))
      ) {
        continue;
      }
      if (fromTest(e)) out.testOnly += 1;
      else out.real += 1;
    }
  }
  return out;
}

/** Real (production) incoming references; see `incomingRefs`. */
export function realIncomingRefCount(
  store: GraphStore,
  orgId: OrgId,
  qname: QualifiedName,
): number {
  return incomingRefs(store, orgId, qname).real;
}

/** An `@isTest` class (or test method) node. */
export function isTestClass(n: NodeFact): boolean {
  return (n.attributes as Record<string, unknown> | undefined)?.isTest === true;
}

/**
 * `dead`: nothing references the node, test code included.
 * `referenced-only-by-tests`: production code whose only references come
 * from test code (delete-safety view: it goes together with its tests).
 */
export type DeadCodeKind = "dead" | "referenced-only-by-tests";

export interface DeadCodeCandidate {
  node: NodeFact;
  kind: DeadCodeKind;
  /** The node is an `@isTest` class. */
  isTest: boolean;
  /** References from test code (> 0 only for `referenced-only-by-tests`). */
  testOnlyRefs: number;
}

/**
 * The kind of a node with these incoming references, or null when it is in
 * use. Test references count as references (catalog contract: "test classes
 * do count as references"), so a class a test uses is not dead; an `@isTest`
 * class nothing references is dead like any other node (flagged `isTest`). A
 * production node referenced by tests only is listed apart; test code
 * referenced by other tests (a test utility) is in use.
 */
export function deadCodeKind(refs: IncomingRefs, isTest: boolean): DeadCodeKind | null {
  if (refs.real + refs.testOnly === 0) return "dead";
  if (refs.real === 0 && !isTest) return "referenced-only-by-tests";
  return null;
}

/**
 * Dead-code candidates of DEAD_CODE_LABELS, both kinds (`deadCodeKind`):
 * the score cache holds both and readers keep them apart. Freshness does not
 * decide membership; it grades confidence in the score cache
 * (`populateDeadCodeScores`: stale = high, recently modified = low). A
 * filesystem ingest stamps every node with its checkout mtime, so a freshness
 * gate here would hide every unreferenced node.
 */
export function deadCodeCandidates(store: GraphStore, orgId: OrgId): DeadCodeCandidate[] {
  const isTestSource = makeTestSourceCheck(store, orgId);
  const out: DeadCodeCandidate[] = [];
  for (const lbl of DEAD_CODE_LABELS) {
    const nodes = store.listNodesByLabel(orgId, lbl, DEAD_CODE_NODE_CAP);
    for (let i = 0; i < nodes.length; i += INCOMING_CHUNK) {
      const chunk = nodes.slice(i, i + INCOMING_CHUNK);
      const membersOf = membersReader(
        store,
        orgId,
        chunk.map((n) => n.qualifiedName),
      );
      const targetsOf = chunk.map((n) => [n.qualifiedName, ...membersOf(n.qualifiedName)]);
      const edgesTo = incomingEdgeReader(store, orgId, targetsOf.flat());
      chunk.forEach((n, j) => {
        const isTest = isTestClass(n);
        const refs = countIncomingRefs(
          store,
          orgId,
          n.qualifiedName,
          targetsOf[j] as QualifiedName[],
          edgesTo,
          isTestSource,
        );
        const kind = deadCodeKind(refs, isTest);
        if (kind) out.push({ node: n, kind, isTest, testOnlyRefs: refs.testOnly });
      });
    }
  }
  return out;
}

/** Candidates whose incoming edges are read together (one read per edge table). */
const INCOMING_CHUNK = 256;

/**
 * `target -> listEdgesTo(target)` for a set of targets, from one batched read
 * (`listEdgesToAny`: `dst IN (...)`, NOCASE like `dst = ?`) grouped by the
 * NOCASE dst, so each target gets exactly the rows its own `listEdgesTo`
 * would. Stores without the batched read fall back to per-target reads.
 */
function incomingEdgeReader(
  store: GraphStore,
  orgId: OrgId,
  targets: readonly QualifiedName[],
): (target: QualifiedName) => readonly EdgeFact[] {
  if (typeof store.listEdgesToAny !== "function") {
    return (target) => store.listEdgesTo(orgId, target);
  }
  const byDst = new Map<string, EdgeFact[]>();
  for (const e of store.listEdgesToAny(orgId, new Set(targets.map(String)))) {
    const k = nocase(String(e.dstQualifiedName));
    const list = byDst.get(k);
    if (list) list.push(e);
    else byDst.set(k, [e]);
  }
  return (target) => byDst.get(nocase(String(target))) ?? [];
}

/** The dead nodes of `deadCodeCandidates` (no inbound reference of any kind). */
export function findDeadCode(store: GraphStore, orgId: OrgId): NodeFact[] {
  return deadCodeCandidates(store, orgId)
    .filter((c) => c.kind === "dead")
    .map((c) => c.node);
}

export type DeadCodeConfidence = "high" | "medium" | "low";

export interface DeadCodeScore {
  score: number;
  confidence: DeadCodeConfidence;
  reasons: string[];
}

/**
 * Score a dead-code candidate (a node `findDeadCode` returned). Lower = more
 * dead. With zero inbound the incoming term (0.4 weight) is 0, so the score is
 * 0.6 * freshness: older than 180 days = high, 31-180 days or no timestamp =
 * medium, 30 days or newer = low. Shared by the score cache and the live path.
 * `testOnlyRefs` > 0 (a `deadCodeCandidates` count) gives the reason
 * `referenced_only_by_tests` in place of `no_incoming_edges`; `isTest` adds
 * `test_class` (an unreferenced `@isTest` class).
 */
export function scoreDeadCode(
  node: NodeFact,
  now = Date.now(),
  testOnlyRefs = 0,
  isTest = false,
): DeadCodeScore {
  const fresh = freshnessScore(node, now);
  // A class with only test references has incoming edges, so it is
  // `referenced_only_by_tests`, never `no_incoming_edges`.
  const reasons = [testOnlyRefs > 0 ? "referenced_only_by_tests" : "no_incoming_edges"];
  if (isTest) reasons.push("test_class");
  if (fresh < 0.4) reasons.push("stale_freshness");
  const score = 0.6 * fresh;
  const confidence: DeadCodeConfidence = score < 0.2 ? "high" : score < 0.45 ? "medium" : "low";
  return { score, confidence, reasons };
}
