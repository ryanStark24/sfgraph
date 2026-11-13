import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConsoleLogger } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilesystemMetadataSource } from "../../extractors/filesystem/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { runDeltaIngest } from "../delta.js";
import { liveIngest } from "../live-ingest.js";
import { offlineResolvedOrg } from "../offline-org.js";

/** S-1.8.1-001/005/006 end to end: project folder -> ingest -> graph. */

const MD = "force-app/main/default";
const logger = new ConsoleLogger("error");
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-pfi-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function w(rel: string, c: string): void {
  const abs = path.join(dir, "proj", rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, c, "utf8");
}

async function ingest() {
  const store = new SqliteGraphStore({ dbPath: ":memory:" });
  await store.init();
  const resolved = offlineResolvedOrg(path.join(dir, "proj"), "pf");
  const res = await liveIngest({
    alias: "pf",
    graphStore: store,
    mode: "full",
    rebuild: true,
    preResolved: resolved,
    metadataSource: FilesystemMetadataSource.fromProjectRoot(path.join(dir, "proj")),
    logger,
    skipSnapshot: true,
    analysisDb: store.db,
  });
  return { store, resolved, res };
}

const q = (s: string) => s as never;

describe("project folders through ingest", () => {
  it("a report gets its rule edges, an unknown folder an opaque node listed in unknownTypes", async () => {
    w(
      `${MD}/reports/Acme_Reports/Open_Orders.report-meta.xml`,
      "<Report><name>Open Orders</name><reportType>Acme_Order__c</reportType>" +
        "<columns><field>Acme_Order__c.Total__c</field></columns></Report>",
    );
    w(`${MD}/roles/Sales_Lead.role-meta.xml`, "<Role><name>Sales Lead</name></Role>");
    w(
      `${MD}/gadgets/Left.gadget-meta.xml`,
      "<Gadget><label>Left</label><object>Acme_Order__c</object></Gadget>",
    );
    w(`${MD}/gadgets/Right.gadget-meta.xml`, "<Gadget><label>Right</label></Gadget>");
    w(`${MD}/objects/Acme_Order__c/Acme_Order__c.object-meta.xml`, "<CustomObject/>");
    const { store, resolved, res } = await ingest();
    const rep = "Report:Acme_Reports/Open_Orders";
    expect(store.getNode(resolved.orgId, q(rep))).toBeTruthy();
    expect(
      store
        .listEdgesFrom(resolved.orgId, q(rep), "REPORTS_ON" as never)
        .map((e) => e.dstQualifiedName),
    ).toEqual(["CustomObject:Acme_Order__c"]);
    expect(
      store.listEdgesFrom(resolved.orgId, q(rep), "READS_FIELD" as never).length,
    ).toBeGreaterThan(0);
    expect(store.getNode(resolved.orgId, q("Role:Sales_Lead"))).toBeTruthy();
    expect(store.getNode(resolved.orgId, q("Gadget:Left"))).toBeTruthy();
    expect(res.coverage?.unknownTypes).toContain("Gadget");
    expect(res.coverage?.unknownTypes).toContain("Role");
    expect(res.coverage?.unknownTypes).not.toContain("Report");
    expect(
      store.listEdgesFrom(resolved.orgId, q("Gadget:Left"), "GENERIC_REFERENCES_OBJECT" as never)
        .length,
    ).toBe(1);
  });

  it("Campaign recordTypes and validationRules with no object file become nodes", async () => {
    w(
      `${MD}/objects/Campaign/recordTypes/Event.recordType-meta.xml`,
      "<RecordType><fullName>Event</fullName><label>Event</label><active>true</active></RecordType>",
    );
    w(
      `${MD}/objects/Campaign/validationRules/Need_Date.validationRule-meta.xml`,
      "<ValidationRule><fullName>Need_Date</fullName><active>true</active>" +
        "<errorConditionFormula>ISBLANK(StartDate)</errorConditionFormula>" +
        "<errorMessage>Date needed</errorMessage></ValidationRule>",
    );
    const { store, resolved } = await ingest();
    expect(store.listNodesByLabel(resolved.orgId, "RecordType" as never).length).toBe(1);
    expect(store.listNodesByLabel(resolved.orgId, "ValidationRule" as never).length).toBe(1);
  });

  it("a field placed directly in the object folder gets its node", async () => {
    w(`${MD}/objects/Acme_Order__c/Acme_Order__c.object-meta.xml`, "<CustomObject/>");
    w(
      `${MD}/objects/Acme_Order__c/Total__c.field-meta.xml`,
      "<CustomField><fullName>Total__c</fullName><type>Number</type><label>Total</label></CustomField>",
    );
    const { store, resolved } = await ingest();
    expect(store.getNode(resolved.orgId, q("CustomField:Acme_Order__c.Total__c"))).toBeTruthy();
  });

  it("guest sharing rules give sharing-rule nodes with kind guest and the criteria edges", async () => {
    w(
      `${MD}/sharingRules/Acme_Order__c.sharingRules-meta.xml`,
      `<SharingRules>
  <sharingGuestRules>
    <fullName>Guest_Read</fullName>
    <accessLevel>Read</accessLevel>
    <label>Guest Read</label>
    <sharedTo><guestUser>Example_Site</guestUser></sharedTo>
    <criteriaItems><field>Status__c</field><operation>equals</operation><value>Open</value></criteriaItems>
  </sharingGuestRules>
  <sharingCriteriaRules>
    <fullName>Crit_Read</fullName>
    <accessLevel>Edit</accessLevel>
    <sharedTo><group>Support_Team</group></sharedTo>
  </sharingCriteriaRules>
</SharingRules>`,
    );
    const { store, resolved } = await ingest();
    const g = store.getNode(resolved.orgId, q("SharingRule:Acme_Order__c.Guest_Read"));
    expect(g).toBeTruthy();
    expect((g?.attributes as Record<string, unknown>).kind).toBe("guest");
    const c = store.getNode(resolved.orgId, q("SharingRule:Acme_Order__c.Crit_Read"));
    expect((c?.attributes as Record<string, unknown>).kind).toBe("criteria");
    expect(
      store
        .listEdgesFrom(
          resolved.orgId,
          q("SharingRule:Acme_Order__c.Guest_Read"),
          "SHARING_GRANTS" as never,
        )
        .map((e) => e.dstQualifiedName),
    ).toEqual(["CustomObject:Acme_Order__c"]);
  });

  it("delta ingest notices an edited record type of a children-only object", async () => {
    w(
      `${MD}/objects/Campaign/recordTypes/Event.recordType-meta.xml`,
      "<RecordType><fullName>Event</fullName><label>Event</label></RecordType>",
    );
    const { store, resolved } = await ingest();
    expect(store.listNodesByLabel(resolved.orgId, "RecordType" as never)).toHaveLength(1);
    const rel = `${MD}/objects/Campaign/recordTypes/Event.recordType-meta.xml`;
    w(rel, "<RecordType><fullName>Event</fullName><label>Changed label</label></RecordType>");
    const abs = path.join(dir, "proj", rel);
    utimesSync(abs, new Date(), new Date(Date.now() + 5000));
    const proj = path.join(dir, "proj");
    const r = await runDeltaIngest({
      alias: "pf",
      graphStore: store,
      preResolved: offlineResolvedOrg(proj, "pf"),
      metadataSource: FilesystemMetadataSource.fromProjectRoot(proj),
      logger,
      skipSnapshot: true,
      analysisDb: store.db,
      lockDir: dir,
      fullRebuild: async () => {
        throw new Error("unexpected full rebuild");
      },
    });
    expect(r).toMatchObject({ kind: "delta", changed: 1 });
    const rt = store.listNodesByLabel(resolved.orgId, "RecordType" as never);
    expect(JSON.stringify(rt[0]?.attributes)).toContain("Changed label");
  });
});
