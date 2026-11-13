import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteGraphStore, SqliteSnapshotStore } from "@ryanstark24/sfgraph-core";
import { type OrgId, asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ToolContext, closeAllContexts, setToolContextFactory } from "../context.js";
import { SfgraphMcpServer } from "../server.js";

// S-1.8.1-002: trace_upstream carries flow status, rule active flag and
// trigger events, shows them on the markdown line, and filters on them.
const ORG = "test-trace-status-org";
const OBJ = "CustomObject:Acme_Order__c";
let workDir: string;
let graphStore: SqliteGraphStore;

function node(qn: string, attributes: Record<string, unknown> = {}) {
  return {
    orgId: asOrgId(ORG),
    qualifiedName: asQualifiedName(qn),
    label: qn.slice(0, qn.indexOf(":")),
    attributes,
    sourceHash: asSha256(`h-${qn}`),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
}
function edge(src: string, rel: string) {
  return {
    orgId: asOrgId(ORG),
    srcQualifiedName: asQualifiedName(src),
    dstQualifiedName: asQualifiedName(OBJ),
    relType: rel as never,
    attributes: {},
    firstSeenAt: 1,
    lastSeenAt: 1,
  };
}

const FLOW_ACTIVE = "Flow:Acme_Order_Active";
const FLOW_DRAFT = "Flow:Acme_Order_Draft";
const FLOW_OBSOLETE = "Flow:Acme_Order_Obsolete";
const RULE_ON = "WorkflowRule:Acme_Order__c.Rule_On";
const RULE_OFF = "WorkflowRule:Acme_Order__c.Rule_Off";
const TRG_INSERT = "ApexTrigger:AcmeOrderBeforeInsert";
const TRG_UPDATE = "ApexTrigger:AcmeOrderAfterUpdate";
const NET_LIVE = "Network:Acme_Community";
const BOT_OFF = "BotVersion:Acme_Bot.v2";
const ALL = [FLOW_ACTIVE, FLOW_DRAFT, FLOW_OBSOLETE, RULE_ON, RULE_OFF, TRG_INSERT, TRG_UPDATE];

beforeEach(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-trace-status-"));
  const dbPath = path.join(workDir, `${ORG}.sqlite`);
  graphStore = new SqliteGraphStore({ dbPath, backupDir: path.join(workDir, "bkp") });
  await graphStore.init();
  graphStore.upsertOrg({
    id: asOrgId(ORG),
    alias: ORG,
    instanceUrl: "https://example.my.salesforce.com",
    apiVersion: "62.0",
    createdAt: 1,
  });
  graphStore.mergeNodes([
    node(OBJ),
    node(FLOW_ACTIVE, { status: "Active" }),
    node(FLOW_DRAFT, { status: "Draft" }),
    node(FLOW_OBSOLETE, { status: "Obsolete" }),
    node(RULE_ON, { active: true }),
    node(RULE_OFF, { active: false }),
    node(TRG_INSERT, { events: ["before insert"] }),
    node(TRG_UPDATE, { events: ["after update"] }),
    node(NET_LIVE, { status: "Live" }),
    node(BOT_OFF, { status: "Inactive" }),
  ]);
  graphStore.mergeEdges([
    ...[FLOW_ACTIVE, FLOW_DRAFT, FLOW_OBSOLETE, RULE_ON, RULE_OFF].map((s) =>
      edge(s, "TRIGGER_FIRES_ON"),
    ),
    edge(TRG_INSERT, "TRIGGERS_ON"),
    edge(TRG_UPDATE, "TRIGGERS_ON"),
    edge(NET_LIVE, "REFERENCES"),
    edge(BOT_OFF, "REFERENCES"),
  ]);
  const snapshotStore = new SqliteSnapshotStore({
    dbPath,
    db: (graphStore as unknown as { db: never }).db,
    skipMigrations: true,
  });
  await snapshotStore.init();
  setToolContextFactory(async () => {
    const ctx: ToolContext = { graphStore, snapshotStore, orgId: asOrgId(ORG) as OrgId };
    return ctx;
  });
});

afterEach(async () => {
  await closeAllContexts();
  setToolContextFactory(null);
  try {
    await graphStore.close();
  } catch {
    /* ignore */
  }
  rmSync(workDir, { recursive: true, force: true });
});

async function trace(extra: Record<string, unknown> = {}) {
  const server = new SfgraphMcpServer();
  await server.loadAllTools();
  const res = await server.dispatch("trace_upstream", {
    org: ORG,
    qname: OBJ,
    depth: 1,
    mermaid: false,
    ...extra,
  });
  expect(res.isError).toBeUndefined();
  const text = res.content.map((c) => c.text).join("\n");
  const listed = [...ALL, NET_LIVE, BOT_OFF].filter((q) => text.includes(`- ${q} `)).sort();
  return { text, listed };
}

describe("trace_upstream status, active and events (S-1.8.1-002)", () => {
  it("defaults list everything and show the new fields on the markdown line", async () => {
    const { text, listed } = await trace();
    expect(listed).toEqual([...ALL, NET_LIVE, BOT_OFF].sort());
    expect(text).toContain(`- ${FLOW_ACTIVE} · Active — hop 1`);
    expect(text).toContain(`- ${FLOW_DRAFT} · Draft — hop 1`);
    expect(text).toContain(`- ${FLOW_OBSOLETE} · Obsolete — hop 1`);
    expect(text).toContain(`- ${RULE_OFF} · inactive — hop 1`);
    expect(text).toContain(`- ${RULE_ON} — hop 1`);
    expect(text).toContain(`- ${TRG_INSERT} · before insert — hop 1`);
    expect(text).toContain(`- ${TRG_UPDATE} · after update — hop 1`);
  });

  it("active_only + events:update keeps the active flow, active rule and after-update trigger", async () => {
    const { listed } = await trace({ active_only: true, events: "update" });
    expect(listed).toEqual([FLOW_ACTIVE, RULE_ON, TRG_UPDATE, NET_LIVE].sort());
  });

  it("events alone filters triggers only; array form and full event names match", async () => {
    const a = await trace({ events: ["insert"] });
    expect(a.listed).toEqual(
      [
        FLOW_ACTIVE,
        FLOW_DRAFT,
        FLOW_OBSOLETE,
        RULE_ON,
        RULE_OFF,
        TRG_INSERT,
        NET_LIVE,
        BOT_OFF,
      ].sort(),
    );
    const b = await trace({ events: ["before insert", "update"] });
    expect(b.listed).toEqual([...ALL, NET_LIVE, BOT_OFF].sort());
    const c = await trace({ events: "before update" });
    expect(c.listed).not.toContain(TRG_UPDATE);
  });

  it("active_only alone drops Draft/Obsolete/inactive and keeps triggers (no status info)", async () => {
    const { listed } = await trace({ active_only: true });
    expect(listed).toEqual([FLOW_ACTIVE, RULE_ON, TRG_INSERT, TRG_UPDATE, NET_LIVE].sort());
    // Network "Live" is kept; BotVersion "Inactive" is dropped.
    expect(listed).not.toContain(BOT_OFF);
  });
});
