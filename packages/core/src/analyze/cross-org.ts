import type { OrgId } from "@ryanstark24/sfgraph-shared";
import type { NodeFact } from "../domain/index.js";
import { METADATA_CATEGORY } from "../domain/metadata-category.js";
import type { GraphStore } from "../storage/interfaces.js";

export interface CrossOrgDiff {
  onlyInA: NodeFact[];
  onlyInB: NodeFact[];
  changed: Array<{ a: NodeFact; b: NodeFact }>;
}

const ALL_LABELS = Object.values(METADATA_CATEGORY);

export interface DiffOrgsArgs {
  storeA: GraphStore;
  orgA: OrgId;
  storeB: GraphStore;
  orgB: OrgId;
  category?: string | "all";
}

/**
 * Compute the set-difference between two ingested orgs.
 *
 * Each org has its own SQLite file, so cross-org diffs MUST be passed two
 * `GraphStore` instances (one per org). Callers that historically passed a
 * single store + two orgIds still work via the back-compat positional
 * signature below, but that path is degenerate — both queries hit the same
 * DB and will return an empty `onlyInB` whenever the second org's rows
 * aren't present in store A.
 */
export function diffOrgs(args: DiffOrgsArgs): CrossOrgDiff;
export function diffOrgs(
  store: GraphStore,
  orgA: OrgId,
  orgB: OrgId,
  category?: string | "all",
): CrossOrgDiff;
export function diffOrgs(
  storeOrArgs: GraphStore | DiffOrgsArgs,
  maybeOrgA?: OrgId,
  maybeOrgB?: OrgId,
  maybeCategory: string | "all" = "all",
): CrossOrgDiff {
  let storeA: GraphStore;
  let storeB: GraphStore;
  let orgA: OrgId;
  let orgB: OrgId;
  let category: string | "all";
  if (
    typeof storeOrArgs === "object" &&
    storeOrArgs !== null &&
    "storeA" in storeOrArgs &&
    "storeB" in storeOrArgs
  ) {
    const a = storeOrArgs as DiffOrgsArgs;
    storeA = a.storeA;
    storeB = a.storeB;
    orgA = a.orgA;
    orgB = a.orgB;
    category = a.category ?? "all";
  } else {
    storeA = storeOrArgs as GraphStore;
    storeB = storeOrArgs as GraphStore;
    orgA = maybeOrgA as OrgId;
    orgB = maybeOrgB as OrgId;
    category = maybeCategory;
  }

  const labels = category === "all" ? ALL_LABELS : [category];
  const aMap = new Map<string, NodeFact>();
  const bMap = new Map<string, NodeFact>();
  for (const lbl of labels) {
    for (const n of storeA.listNodesByLabel(orgA, lbl, 10000)) {
      aMap.set(n.qualifiedName, n);
    }
    for (const n of storeB.listNodesByLabel(orgB, lbl, 10000)) {
      bMap.set(n.qualifiedName, n);
    }
  }
  const onlyInA: NodeFact[] = [];
  const onlyInB: NodeFact[] = [];
  const changed: Array<{ a: NodeFact; b: NodeFact }> = [];
  for (const [k, a] of aMap) {
    const b = bMap.get(k);
    if (!b) onlyInA.push(a);
    else if (a.sourceHash !== b.sourceHash) changed.push({ a, b });
  }
  for (const [k, b] of bMap) {
    if (!aMap.has(k)) onlyInB.push(b);
  }
  return { onlyInA, onlyInB, changed };
}
