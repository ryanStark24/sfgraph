import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { diffOrgs } from "../cross-org.js";
import { generateManifest } from "../deployment-manifest/generate.js";

// audit tools-05: category 'all' must cover every stored label (e.g. LWC,
// OmniScript, ApexMethod), not only METADATA_CATEGORY values.
const A = asOrgId("orgA_tools05");
const B = asOrgId("orgB_tools05");

function node(orgId: typeof A, label: string, qname: string, hash: string): NodeFact {
  return {
    orgId,
    qualifiedName: asQualifiedName(qname),
    label,
    attributes: {},
    sourceHash: asSha256(hash),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
}

describe("audit tools-05: cross-org diff 'all' covers stored labels", () => {
  it("reports a changed LWC and OmniScript with category 'all'", async () => {
    const storeA = new SqliteGraphStore({ dbPath: ":memory:" });
    await storeA.init();
    const storeB = new SqliteGraphStore({ dbPath: ":memory:" });
    await storeB.init();
    storeA.mergeNodes([
      node(A, "LWC", "LWC:foo", "v1"),
      node(A, "OmniScript", "OmniScript:Sales_Quote_English", "v1"),
    ]);
    storeB.mergeNodes([
      node(B, "LWC", "LWC:foo", "v2"),
      node(B, "OmniScript", "OmniScript:Sales_Quote_English", "v2"),
    ]);
    const diff = diffOrgs({ storeA, orgA: A, storeB, orgB: B, category: "all" });
    const changed = diff.changed.map((c) => String(c.a.qualifiedName)).sort();
    expect(changed).toEqual(["LWC:foo", "OmniScript:Sales_Quote_English"]);
    await storeA.close();
    await storeB.close();
  });
});

describe("audit tools-05: deployment manifest with category 'all'", () => {
  it("puts a changed LWC in package.xml and covers ApexMethods by their class", async () => {
    const storeA = new SqliteGraphStore({ dbPath: ":memory:" });
    await storeA.init();
    const storeB = new SqliteGraphStore({ dbPath: ":memory:" });
    await storeB.init();
    const contains = (orgId: typeof A, cls: string, m: string): EdgeFact => ({
      orgId,
      srcQualifiedName: asQualifiedName(cls),
      dstQualifiedName: asQualifiedName(m),
      relType: "CONTAINS_METHOD" as EdgeFact["relType"],
      attributes: {},
      firstSeenAt: 1,
      lastSeenAt: 1,
    });
    storeA.mergeNodes([
      node(A, "LWC", "LWC:foo", "v1"),
      node(A, "ApexClass", "ApexClass:Svc", "v1"),
      node(A, "ApexMethod", "ApexMethod:Svc.run(0)", "v1"),
      node(A, "ApexMethod", "ApexMethod:Svc.added(0)", "v1"),
    ]);
    storeA.mergeEdges([
      contains(A, "ApexClass:Svc", "ApexMethod:Svc.run(0)"),
      contains(A, "ApexClass:Svc", "ApexMethod:Svc.added(0)"),
    ]);
    storeB.mergeNodes([
      node(B, "LWC", "LWC:foo", "v2"),
      node(B, "ApexClass", "ApexClass:Svc", "v2"),
      node(B, "ApexMethod", "ApexMethod:Svc.run(0)", "v2"),
      node(B, "ApexMethod", "ApexMethod:Svc.dropped(0)", "v2"),
    ]);
    storeB.mergeEdges([
      contains(B, "ApexClass:Svc", "ApexMethod:Svc.run(0)"),
      contains(B, "ApexClass:Svc", "ApexMethod:Svc.dropped(0)"),
    ]);
    const m = generateManifest({ storeA, orgA: A, storeB, orgB: B, category: "all" });
    expect(m.packageXml).toContain("<members>foo</members>");
    expect(m.packageXml).toContain("<name>LightningComponentBundle</name>");
    expect(m.packageXml).toContain("<members>Svc</members>");
    expect(m.destructiveXml).not.toContain("Svc");
    expect(m.incomplete.unmappedLabels).toEqual({});
    await storeA.close();
    await storeB.close();
  });
});
