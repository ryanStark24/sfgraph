import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type OrgId, asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { securityAudit } from "../security.js";

const ORG: OrgId = asOrgId("org1");

let workDir: string;
let store: SqliteGraphStore;

beforeEach(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-sec-"));
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

function node(label: string, qname: string): NodeFact {
  return {
    orgId: ORG,
    qualifiedName: asQualifiedName(qname),
    label,
    attributes: {},
    sourceHash: asSha256("h"),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
}

function grant(src: string, field: string): EdgeFact {
  return {
    orgId: ORG,
    srcQualifiedName: asQualifiedName(src),
    dstQualifiedName: asQualifiedName(field),
    relType: "GRANTS_FIELD_ACCESS" as EdgeFact["relType"],
    attributes: {},
    firstSeenAt: 1,
    lastSeenAt: 1,
  };
}

describe("securityAudit — Profile FLS is honoured (not just Permission Sets)", () => {
  it("does not flag a field as an FLS gap when access comes only from a Profile", () => {
    const field = "CustomField:Account.Tier__c";
    store.mergeNodes([node("CustomField", field), node("Profile", "Profile:Sales User")]);
    // FLS granted ONLY through a Profile — no Permission Set at all.
    store.mergeEdges([grant("Profile:Sales User", field)]);

    const audit = securityAudit(store, ORG);
    expect(audit.flsGaps).not.toContain(field);
    // The Profile shows up as a grantor in the matrix.
    const row = audit.fieldAccessMatrix.find((r) => r.field === field);
    expect(row?.grantedBy).toContain("Profile:Sales User");
  });

  it("still flags a genuinely ungranted field as an FLS gap", () => {
    const field = "CustomField:Account.Secret__c";
    store.mergeNodes([node("CustomField", field), node("Profile", "Profile:Sales User")]);
    // No grant edge at all.
    const audit = securityAudit(store, ORG);
    expect(audit.flsGaps).toContain(field);
  });
});
