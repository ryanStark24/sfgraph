import type { OrgId, QualifiedName } from "@ryanstark24/sfgraph-shared";
import { asQualifiedName } from "@ryanstark24/sfgraph-shared";
import type { NodeFact } from "../domain/index.js";
import { REL_TYPES } from "../domain/rel-types.js";
import type { GraphStore } from "../storage/interfaces.js";
import { componentOf, listMembers } from "./containment.js";
import { labelOfQname } from "./edge-filters.js";

/**
 * Labels a test class can exercise: `IS_TEST_FOR` only ever targets Apex
 * classes, and an ApexTrigger is exercised through DML from tests. Every
 * other label (LWC, Aura, Flow, FlowVersion, ...) can never be "covered", so
 * it is reported as not applicable rather than as a gap.
 */
export const COVERAGE_LABELS: ReadonlySet<string> = new Set(["ApexClass", "ApexTrigger"]);

/**
 * True when a test class targets `qname`'s component with IS_TEST_FOR. The
 * edge only targets classes, so a method is resolved to its owning class
 * first (containment.ts `componentOf`).
 */
export function hasTestCoverage(store: GraphStore, orgId: OrgId, qname: QualifiedName): boolean {
  const unit = componentOf(store, orgId, qname);
  if (store.listEdgesTo(orgId, unit, REL_TYPES.IS_TEST_FOR).length > 0) return true;
  return unit !== qname && store.listEdgesTo(orgId, qname, REL_TYPES.IS_TEST_FOR).length > 0;
}

/** Coverage verdict for one qname, decided on its component (`unit`). */
export interface CoverageVerdict {
  /** The component coverage is decided on (a method's class, a FlowVersion's Flow). */
  unit: string;
  /** Label of `unit` (node label, else the qname prefix). */
  label: string;
  /** `label` is in COVERAGE_LABELS. */
  applicable: boolean;
  /** `unit` is test code: an `@isTest` class, a class with a test member
   *  (TestMethod / `isTest`), or a class with IS_TEST_FOR out-edges. A test
   *  method's own node carries no IS_TEST_FOR, so the class decides, and a
   *  class and its members always get the same verdict. */
  isTest: boolean;
  /** A test class targets `unit` with IS_TEST_FOR. */
  covered: boolean;
}

/**
 * Facts from a local (not yet ingested) parse, consulted before the graph:
 * wip tools see added classes, methods and tests the graph does not hold.
 */
export interface LocalCoverageFacts {
  nodes?: ReadonlyMap<string, NodeFact>;
  /** member qname -> owner qname (local CONTAINS_METHOD edges). */
  owners?: ReadonlyMap<string, string>;
  /** Lower-cased IS_TEST_FOR targets of local test classes. */
  testTargets?: ReadonlySet<string>;
  /** Lower-cased sources of local IS_TEST_FOR edges. */
  testSources?: ReadonlySet<string>;
}

const flaggedTest = (n: NodeFact | null | undefined): boolean =>
  n != null &&
  (n.label === "TestMethod" ||
    (n.attributes as Record<string, unknown> | undefined)?.isTest === true);

/**
 * A memoised classifier: qname -> its coverage verdict. Used by
 * test_gap_intelligence_from_git_diff, what_broke and wip_test_gap so the
 * three agree on roll-up, test-ness and applicability.
 */
export function makeCoverageClassifier(
  store: GraphStore,
  orgId: OrgId,
  local: LocalCoverageFacts = {},
): (qname: string) => CoverageVerdict {
  // Verdicts are per unit (lower-cased), so a class and each of its
  // members get the same answer whichever is asked first.
  const unitMemo = new Map<string, CoverageVerdict>();
  const unitOf = new Map<string, string>();
  const nodeOf = (q: string): NodeFact | null =>
    local.nodes?.get(q) ?? store.getNode(orgId, asQualifiedName(q));
  const localMembers = (lowerUnit: string): string[] =>
    [...(local.owners ?? [])].filter(([, o]) => o.toLowerCase() === lowerUnit).map(([m]) => m);
  const verdictFor = (unit: string): CoverageVerdict => {
    const lowerUnit = unit.toLowerCase();
    const hit = unitMemo.get(lowerUnit);
    if (hit) return hit;
    const unitNode = nodeOf(unit);
    const unitQ = asQualifiedName(unit);
    const label = unitNode?.label ?? labelOfQname(unit);
    // Test-ness folds in the members' flags: a test method marks its class.
    const members = [...listMembers(store, orgId, unitQ).map(String), ...localMembers(lowerUnit)];
    const isTest =
      flaggedTest(unitNode) ||
      members.some((m) => flaggedTest(nodeOf(m))) ||
      local.testSources?.has(lowerUnit) === true ||
      store.listEdgesFrom(orgId, unitQ, REL_TYPES.IS_TEST_FOR).length > 0;
    const covered =
      local.testTargets?.has(lowerUnit) === true || hasTestCoverage(store, orgId, unitQ);
    const v: CoverageVerdict = {
      unit,
      label,
      applicable: COVERAGE_LABELS.has(label),
      isTest,
      covered,
    };
    unitMemo.set(lowerUnit, v);
    return v;
  };
  return (qname) => {
    let unit = unitOf.get(qname);
    if (unit === undefined) {
      const rawUnit =
        local.owners?.get(qname) ?? String(componentOf(store, orgId, asQualifiedName(qname)));
      // The stored spelling: qname lookups ignore case, listings should not
      // hold one component twice.
      const unitNode = nodeOf(rawUnit);
      unit = unitNode ? String(unitNode.qualifiedName) : rawUnit;
      unitOf.set(qname, unit);
    }
    return verdictFor(unit);
  };
}
