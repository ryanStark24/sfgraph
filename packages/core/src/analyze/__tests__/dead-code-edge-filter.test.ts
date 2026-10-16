import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type OrgId, asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { findDeadCode, realIncomingRefCount } from "../dead-code.js";

const ORG: OrgId = asOrgId("org1");
let workDir: string;
let store: SqliteGraphStore;

beforeEach(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-dc-"));
  store = new SqliteGraphStore({
    dbPath: path.join(workDir, "g.sqlite"),
    backupDir: path.join(workDir, "b"),
  });
  await store.init();
});
afterEach(async () => {
  await store.close();
  rmSync(workDir, { recursive: true, force: true });
});

// A very old (stale) class so freshness alone won't keep it alive.
function staleClass(qname: string): NodeFact {
  return {
    orgId: ORG,
    qualifiedName: asQualifiedName(qname),
    label: "ApexClass",
    attributes: {},
    sourceHash: asSha256("h"),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
}
function edge(
  rel: string,
  src: string,
  dst: string,
  attrs: Record<string, unknown> = {},
): EdgeFact {
  return {
    orgId: ORG,
    srcQualifiedName: asQualifiedName(src),
    dstQualifiedName: asQualifiedName(dst),
    relType: rel as EdgeFact["relType"],
    attributes: attrs,
    firstSeenAt: 1,
    lastSeenAt: 1,
  };
}

describe("dead-code incoming-edge filtering", () => {
  it("GRANTS_* and reflection edges do NOT count as real references", () => {
    const cls = "ApexClass:Orphan";
    store.mergeNodes([staleClass(cls)]);
    // Only a permission grant + a reflection-guessed reference point at it.
    store.mergeEdges([
      edge("GRANTS_APEX_ACCESS", "PermissionSet:PS", cls, { enabled: true }),
      edge("REFERENCES", "OmniScript:OS", cls, { source: "reflection" }),
    ]);
    expect(realIncomingRefCount(store, ORG, asQualifiedName(cls))).toBe(0);
    expect(findDeadCode(store, ORG).some((n) => String(n.qualifiedName) === cls)).toBe(true);
  });

  it("a real CALLS edge keeps the class out of the dead set", () => {
    const cls = "ApexClass:Used";
    store.mergeNodes([staleClass(cls)]);
    store.mergeEdges([edge("CALLS", "ApexMethod:Other.go(0)", cls)]);
    expect(realIncomingRefCount(store, ORG, asQualifiedName(cls))).toBe(1);
    expect(findDeadCode(store, ORG).some((n) => String(n.qualifiedName) === cls)).toBe(false);
  });
});

describe("compiled-OmniScript LWC liveness", () => {
  const os = "OmniScript:Sales_Wizard_English";
  const lwc = "LWC:salesWizardEnglish";
  const seed = () =>
    store.mergeEdges([
      edge("REFERENCES", lwc, os, { via: "compiled-omniscript" }),
      edge("CONTAINS_COMPONENT", "LWCBundle:salesWizardEnglish", lwc),
      edge("GRANTS_APEX_ACCESS", "PermissionSet:PS", lwc),
    ]);

  it("the compile edge alone does not keep the OmniScript alive", () => {
    seed();
    expect(realIncomingRefCount(store, ORG, asQualifiedName(os))).toBe(0);
  });

  it("an inbound launch of the compiled LWC keeps the OmniScript alive", () => {
    seed();
    store.mergeEdges([edge("REFERENCES", "LWC:launcher", lwc, { via: "c__target" })]);
    expect(realIncomingRefCount(store, ORG, asQualifiedName(os))).toBe(1);
  });

  it("an edge from the OmniScript itself to its compiled LWC does not count", () => {
    seed();
    store.mergeEdges([edge("OS_EMBEDS_LWC", os, lwc)]);
    expect(realIncomingRefCount(store, ORG, asQualifiedName(os))).toBe(0);
  });
});

describe("own-bundle containment is not usage", () => {
  const lwc = "LWC:orphanCard";
  const seed = () => store.mergeEdges([edge("CONTAINS_COMPONENT", "LWCBundle:orphanCard", lwc)]);

  it("a plain LWC with only its bundle edge is dead", () => {
    seed();
    expect(realIncomingRefCount(store, ORG, asQualifiedName(lwc))).toBe(0);
  });

  it("another bundle's containment edge still counts", () => {
    seed();
    store.mergeEdges([edge("CONTAINS_COMPONENT", "LWCBundle:otherCard", lwc)]);
    expect(realIncomingRefCount(store, ORG, asQualifiedName(lwc))).toBe(1);
  });

  it("a same-name containment from a non-paired bundle label still counts", () => {
    seed();
    store.mergeEdges([edge("CONTAINS_COMPONENT", "AuraBundle:orphanCard", lwc)]);
    expect(realIncomingRefCount(store, ORG, asQualifiedName(lwc))).toBe(1);
  });

  it.each([
    ["REFERENCES", { via: "import" }],
    ["EMBEDS_LWC", {}],
  ])("an inbound %s keeps the LWC alive", (rel, attrs) => {
    seed();
    store.mergeEdges([edge(rel, "LWC:parentCard", lwc, attrs)]);
    expect(realIncomingRefCount(store, ORG, asQualifiedName(lwc))).toBe(1);
  });
});

describe("findDeadCode scans LWC nodes", () => {
  const staleLwc = (qname: string): NodeFact => ({ ...staleClass(qname), label: "LWC" });
  const isDead = (q: string) => findDeadCode(store, ORG).some((n) => String(n.qualifiedName) === q);

  it("reports an unreferenced stale LWC", () => {
    store.mergeNodes([staleLwc("LWC:lonelyCard")]);
    expect(isDead("LWC:lonelyCard")).toBe(true);
  });

  it("reports an LWC whose only inbound edge is its own bundle", () => {
    store.mergeNodes([staleLwc("LWC:bundledCard")]);
    store.mergeEdges([edge("CONTAINS_COMPONENT", "LWCBundle:bundledCard", "LWC:bundledCard")]);
    expect(isDead("LWC:bundledCard")).toBe(true);
  });

  it("does not report an LWC embedded by another component", () => {
    store.mergeNodes([staleLwc("LWC:childCard")]);
    store.mergeEdges([
      edge("CONTAINS_COMPONENT", "LWCBundle:childCard", "LWC:childCard"),
      edge("EMBEDS_LWC", "LWC:parentCard", "LWC:childCard"),
    ]);
    expect(isDead("LWC:childCard")).toBe(false);
  });
});
