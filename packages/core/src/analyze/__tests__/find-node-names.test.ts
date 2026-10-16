import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NodeFact } from "../../domain/index.js";
import type { GraphStore } from "../../storage/interfaces.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { findNodeNamesByGlob, findNodesByGlob } from "../find-nodes.js";

/** findNodeNamesByGlob (names only) must equal findNodesByGlob's matches. */

const ORG = asOrgId("org_fn");
const OTHER = asOrgId("org_other");
function node(label: string, q: string, org = ORG): NodeFact {
  return {
    orgId: org,
    qualifiedName: asQualifiedName(q),
    label,
    attributes: { big: "x".repeat(200), q },
    sourceHash: asSha256(q),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
}

let store: SqliteGraphStore;
beforeEach(async () => {
  store = new SqliteGraphStore({ dbPath: ":memory:" });
  await store.init();
  const nodes: NodeFact[] = [];
  // Inserted in reverse name order, so row order differs from name order.
  for (let i = 60; i >= 0; i--) {
    nodes.push(node("ApexClass", `ApexClass:${i % 3 === 0 ? "acct" : "Acct"}Handler${i}`));
    nodes.push(node("ApexMethod", `ApexMethod:AcctHandler${i}.run(0)`));
    if (i % 5 === 0) nodes.push(node("CustomField", `CustomField:Account.F${i}__c`));
    if (i % 7 === 0) nodes.push(node("ApexClass", `ApexClass:OtherOrg${i}`, OTHER));
  }
  nodes.push(node("ApexClass", "ApexClass:Ünïcode"));
  store.mergeNodes(nodes);
});
afterEach(async () => {
  await store.close();
});

const names = (r: ReturnType<typeof findNodesByGlob>) => ({
  matches: r.matches.map((n) => ({ qualifiedName: n.qualifiedName, label: n.label })),
  truncated: r.truncated,
  total: r.total,
});

describe("findNodeNamesByGlob", () => {
  it("returns findNodesByGlob's matches, totals and truncation", () => {
    const cases: Array<[string, { label?: string; limit?: number }]> = [
      ["ApexClass:*", {}],
      ["*handler1*", {}],
      ["*", { limit: 25 }],
      ["*:acct*", { label: "apexclass", limit: 10 }],
      ["CustomField:Account.F{1,2}*", {}],
      ["*Ü*", {}],
      ["nothing*", {}],
      ["*", { label: "NoSuchLabel" }],
    ];
    for (const [pattern, opts] of cases) {
      expect(findNodeNamesByGlob(store, ORG, pattern, opts)).toEqual(
        names(findNodesByGlob(store, ORG, pattern, opts)),
      );
    }
  });

  it("falls back to node rows on a store without listQnamesByLabel", () => {
    const plain = new Proxy(store, {
      get(t, p, r) {
        if (p === "listQnamesByLabel") return undefined;
        const v = Reflect.get(t, p, r);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as GraphStore;
    expect(findNodeNamesByGlob(plain, ORG, "*Handler*", { limit: 30 })).toEqual(
      names(findNodesByGlob(store, ORG, "*Handler*", { limit: 30 })),
    );
  });

  it("listQnamesByLabel keeps listNodesByLabel's order and LIMIT subset", () => {
    for (const label of ["ApexClass", "ApexMethod", "CustomField"]) {
      for (const limit of [undefined, 1, 7, 40]) {
        expect(store.listQnamesByLabel(ORG, label, limit)).toEqual(
          store.listNodesByLabel(ORG, label, limit).map((n) => n.qualifiedName),
        );
      }
    }
  });
});
