import type { OrgId } from "@ryanstark24/sfgraph-shared";
import type { NodeFact } from "../domain/index.js";
import { METADATA_CATEGORY } from "../domain/metadata-category.js";
import type { GraphStore } from "../storage/interfaces.js";
import { namespaceOfApiName } from "./field-scope.js";

export interface CrossOrgDiff {
  onlyInA: NodeFact[];
  onlyInB: NodeFact[];
  changed: Array<{ a: NodeFact; b: NodeFact }>;
  /**
   * True when at least one label-scan hit the per-label result cap
   * (`CROSS_ORG_PER_LABEL_CAP`). Callers should warn the user and
   * narrow the scope or paginate before drawing conclusions.
   */
  truncated?: boolean;
}

/**
 * Per-label cap on cross-org node scans. Exported so callers can surface it
 * verbatim in user-facing summaries.
 */
export const CROSS_ORG_PER_LABEL_CAP = 10000;

/**
 * Labels `category: "all"` covers: every label stored in either graph (parsers
 * emit labels such as LWC, ApexMethod, DataRaptor or OmniScript that are not
 * METADATA_CATEGORY values), plus the category names for stores that predate
 * the label cache.
 */
function allLabels(storeA: GraphStore, storeB: GraphStore): string[] {
  return [
    ...new Set([
      ...storeA.listAllLabels(),
      ...storeB.listAllLabels(),
      ...Object.values(METADATA_CATEGORY),
    ]),
  ];
}

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

  const labels = category === "all" ? allLabels(storeA, storeB) : [category];
  const aMap = new Map<string, NodeFact>();
  const bMap = new Map<string, NodeFact>();
  let truncated = false;
  for (const lbl of labels) {
    const aRows = storeA.listNodesByLabel(orgA, lbl, CROSS_ORG_PER_LABEL_CAP);
    for (const n of aRows) aMap.set(n.qualifiedName, n);
    if (aRows.length >= CROSS_ORG_PER_LABEL_CAP) truncated = true;
    const bRows = storeB.listNodesByLabel(orgB, lbl, CROSS_ORG_PER_LABEL_CAP);
    for (const n of bRows) bMap.set(n.qualifiedName, n);
    if (bRows.length >= CROSS_ORG_PER_LABEL_CAP) truncated = true;
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
  return { onlyInA, onlyInB, changed, truncated };
}

/** The item's own name: the last dotted part of the qname (`Tier__c` for `CustomField:Account.Tier__c`). */
function ownName(n: NodeFact): string {
  const q = String(n.qualifiedName);
  const local = q.slice(q.indexOf(":") + 1);
  return local.slice(local.lastIndexOf(".") + 1);
}

/**
 * True for a managed-package item: its own name carries a namespace prefix by the API-name
 * grammar (`namespaceOfApiName`: `acme__Invoice__c`, `acme__Loc__Latitude__s`), or it is Apex
 * whose code the org does not show. The org returns managed Apex with an empty body, which the
 * class parser stores as a stub marked `bodyUnavailable`. Graphs built before that marker hold the
 * same stub as a class with no modifiers and no parse failure (a parsed top-level class or enum
 * always declares an access modifier); a trigger stub has no object and no events.
 */
export function isManagedItem(n: NodeFact): boolean {
  if (namespaceOfApiName(ownName(n)) !== null) return true;
  const a = n.attributes ?? {};
  if (n.label === "ApexClass") {
    if (a.bodyUnavailable === true) return true;
    return (
      a.bodyUnavailable === undefined &&
      Array.isArray(a.modifiers) &&
      a.modifiers.length === 0 &&
      !a.parseFailed &&
      !a.isTest
    );
  }
  if (n.label === "ApexTrigger")
    return Array.isArray(a.events) && a.events.length === 0 && a.object == null;
  return false;
}

/** True for a standard Salesforce object or field: one without a custom suffix. */
export function isStandardItem(n: NodeFact): boolean {
  if (n.label !== "CustomObject" && n.label !== "CustomField") return false;
  return !ownName(n).includes("__");
}

export interface HiddenCounts {
  managed: number;
  standard: number;
}

/**
 * Drop managed-package and standard items that are in one org only. Such an item
 * is almost always a difference in what was installed or retrieved (every org has
 * the standard objects; a package brings its own pieces), not work someone did.
 * The same items in both orgs with different source stay: that is a real change.
 * A managed item that is also standard counts once, as managed.
 */
export function hideOneSided(
  diff: CrossOrgDiff,
  opts: { includeManaged: boolean; includeStandard: boolean },
): CrossOrgDiff & { hidden: HiddenCounts } {
  const hidden: HiddenCounts = { managed: 0, standard: 0 };
  const keep = (n: NodeFact): boolean => {
    if (!opts.includeManaged && isManagedItem(n)) {
      hidden.managed++;
      return false;
    }
    if (!opts.includeStandard && isStandardItem(n)) {
      hidden.standard++;
      return false;
    }
    return true;
  };
  return {
    ...diff,
    onlyInA: diff.onlyInA.filter(keep),
    onlyInB: diff.onlyInB.filter(keep),
    hidden,
  };
}
