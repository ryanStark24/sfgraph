import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import {
  COMPONENT_LABELS,
  COMPONENT_LABEL_REASONS,
  RECORD_CONFIG_LABELS,
  RECORD_CONFIG_LABEL_REASONS,
  changeScopeOfLabel,
  changeUnitOf,
  componentByName,
} from "../component-scope.js";
import { TRAVERSAL_CONTAINMENT_RULES } from "../containment.js";

const ORG = asOrgId("org_scope");

function node(label: string, qname: string): NodeFact {
  return {
    orgId: ORG,
    qualifiedName: asQualifiedName(qname),
    label,
    attributes: {},
    sourceHash: asSha256(qname),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
}
function edge(rel: string, src: string, dst: string): EdgeFact {
  return {
    orgId: ORG,
    srcQualifiedName: asQualifiedName(src),
    dstQualifiedName: asQualifiedName(dst),
    relType: rel as EdgeFact["relType"],
    attributes: {},
    firstSeenAt: 1,
    lastSeenAt: 1,
  };
}

let store: SqliteGraphStore;
beforeEach(async () => {
  store = new SqliteGraphStore({ dbPath: ":memory:" });
  await store.init();
});
afterEach(async () => {
  await store.close();
});

describe("component / record-config label split", () => {
  it("the two sides are disjoint and every label carries a reason", () => {
    for (const l of COMPONENT_LABELS) expect(RECORD_CONFIG_LABELS.has(l)).toBe(false);
    for (const [l, why] of Object.entries(COMPONENT_LABEL_REASONS)) expect(why, l).toBeTruthy();
    for (const [l, why] of Object.entries(RECORD_CONFIG_LABEL_REASONS))
      expect(why, l).toBeTruthy();
  });

  it("every traversal containment label is a component", () => {
    for (const r of TRAVERSAL_CONTAINMENT_RULES) {
      expect(changeScopeOfLabel(r.ownerLabel)).toBe("component");
      expect(changeScopeOfLabel(r.memberLabel)).toBe("component");
    }
  });

  it("records, access/UI config and opaque-fallback labels are record-config", () => {
    for (const l of ["CustomMetadataRecord", "Profile", "PermissionSet", "Layout", "CustomLabel"]) {
      expect(changeScopeOfLabel(l)).toBe("record-config");
    }
    // A label no dedicated parser emits (opaque DataPack / metadata type).
    expect(changeScopeOfLabel("SomeDataPackType")).toBe("record-config");
    expect(changeScopeOfLabel("ApexClass")).toBe("component");
  });
});

describe("member roll-up for change units", () => {
  it("folds members by name grammar when no live edge exists", () => {
    expect(componentByName("ApexMethod:Svc.run(2)")).toBe("ApexClass:Svc");
    expect(componentByName("FlowVersion:My_Flow.v49")).toBe("Flow:My_Flow");
    expect(componentByName("LWCBundle:tile")).toBe("LWC:tile");
    expect(componentByName("ApexClass:Svc")).toBe("ApexClass:Svc");
    expect(componentByName("CustomMetadataRecord:T.r1")).toBe("CustomMetadataRecord:T.r1");
  });

  it("prefers the live containment edge", () => {
    store.mergeNodes([
      node("Flow", "Flow:Real_Owner"),
      node("FlowVersion", "FlowVersion:Odd_Name.v3"),
    ]);
    store.mergeEdges([edge("CONTAINS", "Flow:Real_Owner", "FlowVersion:Odd_Name.v3")]);
    expect(changeUnitOf(store, ORG, "FlowVersion:Odd_Name.v3")).toBe("Flow:Real_Owner");
    // Removed (no node, no edge): name grammar.
    expect(changeUnitOf(store, ORG, "ApexMethod:Gone.m(0)")).toBe("ApexClass:Gone");
  });
});
