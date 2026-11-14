import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FilesystemMetadataSource,
  SqliteGraphStore,
  liveIngest,
  offlineResolvedOrg,
} from "@ryanstark24/sfgraph-core";
import { ConsoleLogger } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setToolContextFactory } from "../../context.js";
import { callTool } from "./_runner.js";

/**
 * F09: a sharing rule's audience for an ingested project. The parser stores recipients as
 * SHARING_TO_GROUP / SHARING_TO_ROLE edges and `kind` on the node, so the audit must read those,
 * not a `sharedTo` attribute that real nodes do not have. Real *.sharingRules-meta.xml through
 * the normal ingest path, then the security_audit and export_sarif tool handlers.
 */
let dir: string;
let store: SqliteGraphStore;
let prevExports: string | undefined;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-shr-"));
  prevExports = process.env.SFGRAPH_EXPORTS_DIR;
  process.env.SFGRAPH_EXPORTS_DIR = path.join(dir, "exports");
  const abs = path.join(
    dir,
    "proj/force-app/main/default/sharingRules/Acme_Order__c.sharingRules-meta.xml",
  );
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(
    abs,
    `<SharingRules>
  <sharingCriteriaRules>
    <fullName>Crit_Edit</fullName>
    <accessLevel>Edit</accessLevel>
    <label>Crit Edit</label>
    <sharedTo><group>Support_Team</group></sharedTo>
    <criteriaItems><field>Status__c</field><operation>equals</operation><value>Open</value></criteriaItems>
  </sharingCriteriaRules>
  <sharingOwnerRules>
    <fullName>Owner_Edit</fullName>
    <accessLevel>Edit</accessLevel>
    <label>Owner Edit</label>
    <sharedFrom><group>Sales_Team</group></sharedFrom>
    <sharedTo><roleAndSubordinates>Support_Manager</roleAndSubordinates></sharedTo>
  </sharingOwnerRules>
  <sharingGuestRules>
    <fullName>Guest_Edit</fullName>
    <accessLevel>Edit</accessLevel>
    <label>Guest Edit</label>
    <sharedTo><guestUser>Example_Site</guestUser></sharedTo>
    <criteriaItems><field>Status__c</field><operation>equals</operation><value>Open</value></criteriaItems>
  </sharingGuestRules>
</SharingRules>`,
    "utf8",
  );
  store = new SqliteGraphStore({ dbPath: ":memory:" });
  await store.init();
  const resolved = offlineResolvedOrg(path.join(dir, "proj"), "shr");
  await liveIngest({
    alias: "shr",
    graphStore: store,
    mode: "full",
    rebuild: true,
    preResolved: resolved,
    metadataSource: FilesystemMetadataSource.fromProjectRoot(path.join(dir, "proj")),
    logger: new ConsoleLogger("error"),
    skipSnapshot: true,
    analysisDb: store.db,
  });
  setToolContextFactory(async () => ({
    graphStore: store,
    snapshotStore: {} as never,
    orgId: resolved.orgId,
  }));
});

afterEach(async () => {
  setToolContextFactory(null);
  await store.close();
  if (prevExports === undefined) Reflect.deleteProperty(process.env, "SFGRAPH_EXPORTS_DIR");
  else process.env.SFGRAPH_EXPORTS_DIR = prevExports;
  rmSync(dir, { recursive: true, force: true });
});

describe("sharing rule audience from an ingested project (F09)", () => {
  const EXPECTED: Record<string, string> = {
    "SharingRule:Acme_Order__c.Crit_Edit": "group: Support_Team",
    "SharingRule:Acme_Order__c.Owner_Edit": "role and subordinates: Support_Manager",
    "SharingRule:Acme_Order__c.Guest_Edit": "guest users",
  };

  it("security_audit shows the group, role and guest audience", async () => {
    const r = await callTool("security_audit", { org: "shr" });
    const d = r.data as { sharingRuleAccess: Array<{ qualifiedName: string; audience?: string }> };
    expect(
      Object.fromEntries(d.sharingRuleAccess.map((x) => [x.qualifiedName, x.audience])),
    ).toEqual(EXPECTED);
    expect(r.markdown).toContain("Edit, to group: Support_Team");
  });

  it("export_sarif messages carry the same audience", async () => {
    const r = await callTool("export_sarif", { org: "shr", audits: ["security"] });
    const { findings } = r.data as {
      findings: Array<{ message: string; location: { qualifiedName: string } }>;
    };
    for (const [qn, audience] of Object.entries(EXPECTED)) {
      const f = findings.find((x) => x.location.qualifiedName === qn);
      expect(f?.message).toContain(`Edit access to records to ${audience} (`);
    }
  });
});
