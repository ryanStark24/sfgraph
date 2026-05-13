import type { OrgId } from "@sfgraph/shared";
import type { NodeFact } from "../domain/index.js";
import { METADATA_CATEGORY } from "../domain/metadata-category.js";
import type { GraphStore } from "../storage/interfaces.js";

export interface CrossOrgDiff {
  onlyInA: NodeFact[];
  onlyInB: NodeFact[];
  changed: Array<{ a: NodeFact; b: NodeFact }>;
}

const ALL_LABELS = Object.values(METADATA_CATEGORY);

export function diffOrgs(
  store: GraphStore,
  orgA: OrgId,
  orgB: OrgId,
  category: string | "all" = "all",
): CrossOrgDiff {
  const labels = category === "all" ? ALL_LABELS : [category];
  const aMap = new Map<string, NodeFact>();
  const bMap = new Map<string, NodeFact>();
  for (const lbl of labels) {
    for (const n of store.listNodesByLabel(orgA, lbl, 10000)) {
      aMap.set(n.qualifiedName, n);
    }
    for (const n of store.listNodesByLabel(orgB, lbl, 10000)) {
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
