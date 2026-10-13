import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ConsoleLogger } from "@ryanstark24/sfgraph-shared";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilesystemMetadataSource } from "../../extractors/filesystem/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { type RunDeltaResult, runDeltaIngest } from "../delta.js";
import { type LiveIngestOpts, liveIngest } from "../live-ingest.js";
import { offlineResolvedOrg } from "../offline-org.js";

/**
 * Task 11c: project delta ingestion. Every scenario edits a copy of the
 * fixture project, runs a delta against a graph built from the unedited
 * tree, and asserts the delta graph is identical (canonical dumpLines) to a
 * full rebuild of the edited tree at the same path.
 */

const GRAPH_DUMP = pathToFileURL(
  path.resolve(__dirname, "../../../../../bench/lib/graph-dump.mjs"),
).href;
type DumpLines = (
  dbPath: string,
  opts?: { orgId?: string; includeSourceHash?: boolean },
) => Iterable<string>;
type DumpEntries = (
  dbPath: string,
  opts?: { orgId?: string; includeSourceHash?: boolean },
) => Iterable<{ key: string; disp: string; payload: string }>;
const FIXTURE = path.resolve(__dirname, "fixtures/delta-project");
const MD = "force-app/main/default";

let dir: string;
let proj: string;
let dumpLines: DumpLines;
let dumpEntries: DumpEntries;
const logger = new ConsoleLogger("error");

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-delta-"));
  proj = path.join(dir, "proj");
  cpSync(FIXTURE, proj, { recursive: true });
  ({ dumpLines, dumpEntries } = (await import(GRAPH_DUMP)) as {
    dumpLines: DumpLines;
    dumpEntries: DumpEntries;
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  // biome-ignore lint/performance/noDelete: env var must be truly unset
  delete process.env.SFGRAPH_DELTA_ABORT_AFTER;
  rmSync(dir, { recursive: true, force: true });
});

function w(rel: string, c: string): void {
  const abs = path.join(proj, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, c, "utf8");
}

async function open(dbPath: string): Promise<SqliteGraphStore> {
  const s = new SqliteGraphStore({ dbPath, backupDir: path.join(dir, "bk") });
  await s.init();
  return s;
}

async function fullIngest(
  store: SqliteGraphStore,
  rebuild = true,
  parsePool?: LiveIngestOpts["parsePool"],
): Promise<void> {
  await liveIngest({
    alias: "fixture",
    graphStore: store,
    mode: "full",
    rebuild,
    preResolved: offlineResolvedOrg(proj, "fixture"),
    metadataSource: FilesystemMetadataSource.fromProjectRoot(proj),
    logger,
    skipSnapshot: true,
    analysisDb: store.db,
    ...(parsePool ? { parsePool } : {}),
  });
}

/** A graph built (rebuild) from the current tree. */
async function rebuildInto(name: string): Promise<{ store: SqliteGraphStore; dbPath: string }> {
  const dbPath = path.join(dir, `${name}.sqlite`);
  const store = await open(dbPath);
  await fullIngest(store);
  return { store, dbPath };
}

interface Ctx {
  store: SqliteGraphStore;
  dbPath: string;
}

function delta(
  ctx: Ctx,
  extra: { onFullRebuild?: () => void; parsePool?: LiveIngestOpts["parsePool"] } = {},
): Promise<RunDeltaResult> {
  return runDeltaIngest({
    ...(extra.parsePool ? { parsePool: extra.parsePool } : {}),
    alias: "fixture",
    graphStore: ctx.store,
    preResolved: offlineResolvedOrg(proj, "fixture"),
    metadataSource: FilesystemMetadataSource.fromProjectRoot(proj),
    logger,
    skipSnapshot: true,
    analysisDb: ctx.store.db,
    lockDir: dir,
    fullRebuild: async () => {
      extra.onFullRebuild?.();
      await ctx.store.close();
      rmSync(ctx.dbPath, { force: true });
      rmSync(`${ctx.dbPath}-wal`, { force: true });
      rmSync(`${ctx.dbPath}-shm`, { force: true });
      ctx.store = await open(ctx.dbPath);
      await fullIngest(ctx.store);
    },
  });
}

/** Close the delta graph, rebuild the current tree next to it, compare. */
async function expectSameAsRebuild(ctx: Ctx): Promise<void> {
  await ctx.store.close();
  const ref = await rebuildInto("ref");
  await ref.store.close();
  // Stored spelling, not the lower-cased match key: case drift is a difference.
  const lines = (p: string): string[] => [...dumpEntries(p)].map((e) => `${e.disp}\t${e.payload}`);
  const a = lines(ctx.dbPath);
  const b = lines(ref.dbPath);
  expect(a.length).toBeGreaterThan(50);
  expect(a).toEqual(b);
  // Member rows and the keyword index must match too (I-5).
  expect(sideTables(ctx.dbPath)).toEqual(sideTables(ref.dbPath));
}

function sideTables(dbPath: string): { members: string[]; fts: string[] } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const members = (
      db
        .prepare("SELECT member_key, fingerprint, hash, owned FROM _sfgraph_members")
        .all() as Array<{
        member_key: string;
        fingerprint: string;
        hash: string;
        owned: string;
      }>
    )
      .map((r) => {
        const owned = (JSON.parse(r.owned) as string[]).slice().sort().join(",");
        return `${r.member_key}\t${r.fingerprint}\t${r.hash}\t${owned}`;
      })
      .sort();
    const fts = (
      db.prepare("SELECT qualified_name, label, body FROM _sfgraph_node_fts").all() as Array<{
        qualified_name: string;
        label: string;
        body: string;
      }>
    )
      .map((r) => `${r.qualified_name}\t${r.label}\t${r.body}`)
      .sort();
    return { members, fts };
  } finally {
    db.close();
  }
}

async function baseline(): Promise<Ctx> {
  const { store, dbPath } = await rebuildInto("delta");
  return { store, dbPath };
}

describe("project delta ingestion: same graph as a full rebuild", () => {
  it("1. add-apex: a new class calling existing methods", async () => {
    const ctx = await baseline();
    w(
      `${MD}/classes/NewSvc.cls`,
      "public class NewSvc { public static void go() { Integer n = OrderHelper.count(); Util.log('x'); } }",
    );
    const r = await delta(ctx);
    expect(r).toMatchObject({ kind: "delta", added: 1, changed: 0, deleted: 0 });
    await expectSameAsRebuild(ctx);
  });

  it("2. modify-apex-remove-call: ping no longer calls Util.log (N-5)", async () => {
    const ctx = await baseline();
    w(
      `${MD}/classes/AccountService.cls`,
      `public with sharing class AccountService {
  @AuraEnabled public static List<Account> load(Set<Id> ids) {
    return [SELECT Id, Name, Tier__c FROM Account WHERE Id IN :ids];
  }
  public static void save(List<Account> accts) {
    update accts;
    OrderHelper.touch(accts);
  }
  public static void ping(String msg) {
    System.debug(msg);
  }
}
`,
    );
    const r = await delta(ctx);
    expect(r).toMatchObject({ kind: "delta", added: 0, changed: 1, deleted: 0 });
    const calls = ctx.store
      .listEdgesFrom(orgId(), "ApexMethod:AccountService.ping(1)" as never)
      .map((e) => String(e.dstQualifiedName));
    expect(calls).not.toContain("ApexMethod:Util.log(1)");
    await expectSameAsRebuild(ctx);
  });

  it("3. delete-lwc: the FlexiPage edge dangles exactly as in a rebuild", async () => {
    const ctx = await baseline();
    rmSync(path.join(proj, `${MD}/lwc/orderList`), { recursive: true });
    const r = await delta(ctx);
    expect(r).toMatchObject({ kind: "delta", added: 0, changed: 0, deleted: 1 });
    await expectSameAsRebuild(ctx);
  });

  it("4. rename: LegacyHelper -> LegacyRunner leaves no ghost", async () => {
    const ctx = await baseline();
    rmSync(path.join(proj, `${MD}/classes/LegacyHelper.cls`));
    w(
      `${MD}/classes/LegacyRunner.cls`,
      "public class LegacyRunner {\n  public static void run() { OrderHelper.count(); }\n}\n",
    );
    w(
      `${MD}/triggers/AccountTrigger.trigger`,
      "trigger AccountTrigger on Account (before update) {\n  AccountService.save(Trigger.new);\n  LegacyRunner.run();\n}\n",
    );
    const r = await delta(ctx);
    expect(r).toMatchObject({ kind: "delta", added: 1, changed: 1, deleted: 1 });
    expect(ctx.store.getNode(orgId(), "ApexClass:LegacyHelper" as never)).toBeNull();
    expect(ctx.store.getNode(orgId(), "ApexMethod:LegacyHelper.run(0)" as never)).toBeNull();
    await expectSameAsRebuild(ctx);
  });

  it("5. modify-flow-field-ref: the flow writes Score__c instead of Tier__c", async () => {
    const ctx = await baseline();
    const flow = path.join(proj, `${MD}/flows/Account_Update.flow-meta.xml`);
    const { readFileSync } = await import("node:fs");
    writeFileSync(flow, readFileSync(flow, "utf8").replace("Tier__c", "Score__c"));
    const r = await delta(ctx);
    expect(r).toMatchObject({ kind: "delta", changed: 1 });
    await expectSameAsRebuild(ctx);
  });

  it("6. add-field-used-by-dr: Billing_Region__c makes the DR path resolvable", async () => {
    const ctx = await baseline();
    w(
      `${MD}/objects/Account/fields/Billing_Region__c.field-meta.xml`,
      "<CustomField><fullName>Billing_Region__c</fullName><type>Lookup</type><referenceTo>Region__c</referenceTo><relationshipName>Billing_Region</relationshipName></CustomField>",
    );
    const r = await delta(ctx);
    expect(r).toMatchObject({ kind: "delta", changed: 1 });
    await expectSameAsRebuild(ctx);
  });

  it("7. ip-name-match: a new IntegrationProcedure matches the VlocityAction's ProcessName", async () => {
    const ctx = await baseline();
    const ip = "vlocity/datapacks/IntegrationProcedure/Shop_Refund";
    w(
      `${ip}/Shop_Refund_DataPack.json`,
      JSON.stringify({
        "%vlocity_namespace%__Type__c": "Shop",
        "%vlocity_namespace%__SubType__c": "Refund",
        "%vlocity_namespace%__Language__c": "Procedure",
        "%vlocity_namespace%__Element__c": [],
        Name: "Refund",
      }),
    );
    const r = await delta(ctx);
    expect(r).toMatchObject({ kind: "delta", added: 1 });
    await expectSameAsRebuild(ctx);
  });

  it("8. toggle-inactive: the IP's remote action is deactivated", async () => {
    const ctx = await baseline();
    w(
      "vlocity/datapacks/IntegrationProcedure/Shop_Checkout/Shop_Checkout_Element_RA.json",
      JSON.stringify({
        Name: "RA",
        "%vlocity_namespace%__Type__c": "Remote Action",
        "%vlocity_namespace%__Active__c": false,
        "%vlocity_namespace%__PropertySet__c": {
          remoteClass: "CheckoutSvc",
          remoteMethod: "submit",
        },
      }),
    );
    const r = await delta(ctx);
    expect(r).toMatchObject({ kind: "delta", changed: 1 });
    await expectSameAsRebuild(ctx);
  });

  it("9. dead-code-flip: Util.log loses every caller", async () => {
    const ctx = await baseline();
    w(
      `${MD}/classes/AccountService.cls`,
      `public with sharing class AccountService {
  @AuraEnabled public static List<Account> load(Set<Id> ids) {
    return [SELECT Id, Name, Tier__c FROM Account WHERE Id IN :ids];
  }
  public static void save(List<Account> accts) {
    update accts;
    OrderHelper.touch(accts);
  }
  public static void ping(String msg) { }
}
`,
    );
    w(
      `${MD}/classes/OrderHelper.cls`,
      "public class OrderHelper {\n  public static void touch(List<Account> a) { }\n  public static Integer count() { return [SELECT COUNT() FROM Account]; }\n}\n",
    );
    const r = await delta(ctx);
    expect(r).toMatchObject({ kind: "delta", changed: 2 });
    await expectSameAsRebuild(ctx);
  });

  it("10. noop: 0/0/0, byte-identical (with source hashes), under 2 s", async () => {
    const ctx = await baseline();
    await ctx.store.close();
    const before = [...dumpLines(ctx.dbPath, { includeSourceHash: true })];
    ctx.store = await open(ctx.dbPath);
    const t0 = Date.now();
    const r = await delta(ctx);
    const ms = Date.now() - t0;
    expect(r).toMatchObject({ kind: "delta", added: 0, changed: 0, deleted: 0 });
    expect(ms).toBeLessThan(2000);
    await ctx.store.close();
    expect([...dumpLines(ctx.dbPath, { includeSourceHash: true })]).toEqual(before);
    expect(
      (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.some((c) =>
        /^delta: \+0 ~0 -0 \(=\d+ unchanged\) in \d+(\.\d)?s$/.test(String(c[0])),
      ),
    ).toBe(true);
  });

  it("11. legacy-graph: no member hashes -> message and full rebuild", async () => {
    const ctx = await baseline();
    ctx.store.db.prepare("DELETE FROM _sfgraph_members").run();
    w(
      `${MD}/classes/NewSvc.cls`,
      "public class NewSvc { public static void go() { Util.log('x'); } }",
    );
    let rebuilt = 0;
    const r = await delta(ctx, { onFullRebuild: () => rebuilt++ });
    expect(r.kind).toBe("full");
    expect(rebuilt).toBe(1);
    expect(
      (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(
        (c) =>
          String(c[0]) ===
          "delta: graph has no member hashes (built by an older sfgraph); running full rebuild",
      ),
    ).toBe(true);
    await expectSameAsRebuild(ctx);
  });

  it("12. concurrent: the second run refuses with the lock message", async () => {
    const ctx = await baseline();
    w(
      `${MD}/classes/NewSvc.cls`,
      "public class NewSvc { public static void go() { Util.log('x'); } }",
    );
    const results = await Promise.allSettled([delta(ctx), delta(ctx)]);
    const rejected = results.filter((x) => x.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason.message)).toMatch(
      /^ingest already running for fixture \(pid \d+ since .+\); retry later$/,
    );
    await expectSameAsRebuild(ctx);
  });

  it("13. interrupted: an abort after the merge converges on the next delta", async () => {
    const ctx = await baseline();
    rmSync(path.join(proj, `${MD}/classes/LegacyHelper.cls`));
    w(
      `${MD}/classes/NewSvc.cls`,
      "public class NewSvc { public static void go() { Util.log('x'); } }",
    );
    process.env.SFGRAPH_DELTA_ABORT_AFTER = "merge";
    await expect(delta(ctx)).rejects.toThrow(/SFGRAPH_DELTA_ABORT_AFTER/);
    // biome-ignore lint/performance/noDelete: env var must be truly unset
    delete process.env.SFGRAPH_DELTA_ABORT_AFTER;
    const r = await delta(ctx);
    expect(r).toMatchObject({ kind: "delta", added: 1, deleted: 1 });
    await expectSameAsRebuild(ctx);
  });

  it("an add-then-rename before a delta is just an add", async () => {
    const ctx = await baseline();
    w(`${MD}/classes/Extra.cls`, "public class Extra { }");
    renameSync(
      path.join(proj, `${MD}/classes/Extra.cls`),
      path.join(proj, `${MD}/classes/Extra2.cls`),
    );
    const r = await delta(ctx);
    expect(r.kind).toBe("delta");
    await expectSameAsRebuild(ctx);
  });
});

describe("full --project ingest maintenance", () => {
  it("ghost sweep: a non-rebuild full ingest removes a deleted class and its methods", async () => {
    const ctx = await baseline();
    rmSync(path.join(proj, `${MD}/classes/LegacyHelper.cls`));
    await fullIngest(ctx.store, false);
    expect(ctx.store.getNode(orgId(), "ApexClass:LegacyHelper" as never)).toBeNull();
    expect(ctx.store.getNode(orgId(), "ApexMethod:LegacyHelper.run(0)" as never)).toBeNull();
    expect(
      ctx.store
        .listEdgesFrom(orgId(), "ApexMethod:LegacyHelper.run(0)" as never)
        .map((e) => String(e.dstQualifiedName)),
    ).toEqual([]);
    // The class still referenced by the trigger keeps the dangling CALLS edge
    // a rebuild would have (the trigger was not edited).
    expect(ctx.store.getNode(orgId(), "ApexClass:OrderHelper" as never)).not.toBeNull();
    await ctx.store.close();
  });

  it("ghost sweep refuses when the source yields no members (empty stream)", async () => {
    const ctx = await baseline();
    const before = ctx.store.countNodes(orgId());
    const res = await liveIngest({
      alias: "fixture",
      graphStore: ctx.store,
      mode: "full",
      rebuild: false,
      preResolved: offlineResolvedOrg(proj, "fixture"),
      metadataSource: {
        async *iter() {
          /* no members */
        },
      },
      logger,
      skipSnapshot: true,
      analysisDb: ctx.store.db,
    });
    expect(ctx.store.getNode(orgId(), "ApexClass:LegacyHelper" as never)).not.toBeNull();
    expect(ctx.store.countNodes(orgId())).toBe(before);
    expect(
      res.warnings.some((w) => w.startsWith("wedge:ghost-sweep:refuse:reason=empty-stream")),
    ).toBe(true);
    // No rows were written: the next delta falls back to a full rebuild.
    expect(ctx.store.listMemberRows(orgId())).toEqual([]);
    await ctx.store.close();
  });

  it("N-5: a non-rebuild full ingest drops a method's only (removed) call", async () => {
    const ctx = await baseline();
    w(
      `${MD}/classes/AccountService.cls`,
      `public with sharing class AccountService {
  @AuraEnabled public static List<Account> load(Set<Id> ids) {
    return [SELECT Id, Name, Tier__c FROM Account WHERE Id IN :ids];
  }
  public static void save(List<Account> accts) {
    update accts;
    OrderHelper.touch(accts);
  }
  public static void ping(String msg) { }
}
`,
    );
    await fullIngest(ctx.store, false);
    const out = ctx.store
      .listEdgesFrom(orgId(), "ApexMethod:AccountService.ping(1)" as never)
      .map((e) => String(e.dstQualifiedName));
    expect(out).not.toContain("ApexMethod:Util.log(1)");
    await ctx.store.close();
  });
});

function orgId(): never {
  return offlineResolvedOrg(proj, "fixture").orgId as never;
}

describe("review round 1", () => {
  const UTIL = `${MD}/classes/Util.cls`;
  const IP = "vlocity/datapacks/IntegrationProcedure/Shop_Checkout/Shop_Checkout_DataPack.json";
  const FLOW = `${MD}/flows/Account_Update.flow-meta.xml`;
  const bump = (rel: string): void => {
    const t = Date.now() / 1000 + 5;
    utimesSync(path.join(proj, rel), t, t);
  };
  const has = (ctx: Ctx, q: string): boolean => ctx.store.getNode(orgId(), q as never) !== null;

  it("C-1: a case-only rename on a non-rebuild full ingest keeps the class and its method", async () => {
    const ctx = await baseline();
    w(UTIL, "public class UTIL {\n  public static void log(String s) { System.debug(s); }\n}\n");
    await fullIngest(ctx.store, false);
    expect(has(ctx, "ApexClass:UTIL")).toBe(true);
    expect(has(ctx, "ApexMethod:UTIL.log(1)")).toBe(true);
    await ctx.store.close();
  });

  it("C-1: a case-only rename on a delta matches a rebuild (case-sensitive)", async () => {
    const ctx = await baseline();
    w(UTIL, "public class UTIL {\n  public static void log(String s) { System.debug(s); }\n}\n");
    const r = await delta(ctx);
    expect(r).toMatchObject({ kind: "delta", changed: 1 });
    expect(has(ctx, "ApexClass:UTIL")).toBe(true);
    await expectSameAsRebuild(ctx);
  });

  it.skipIf(process.getuid?.() === 0)(
    "I-1: an unreadable file keeps its nodes (delta and full) and converges once readable",
    async () => {
      const ctx = await baseline();
      chmodSync(path.join(proj, UTIL), 0o000);
      bump(UTIL);
      try {
        const r = await delta(ctx);
        expect(r).toMatchObject({ kind: "delta", deleted: 0 });
        expect(has(ctx, "ApexMethod:Util.log(1)")).toBe(true);
        await fullIngest(ctx.store, false);
        expect(has(ctx, "ApexMethod:Util.log(1)")).toBe(true);
      } finally {
        chmodSync(path.join(proj, UTIL), 0o644);
      }
      w(UTIL, "public class Util {\n  public static void log(String s) { }\n}\n");
      await delta(ctx);
      await expectSameAsRebuild(ctx);
    },
  );

  it("I-1: a truncated DataPack keeps the IntegrationProcedure (delta and full)", async () => {
    const ctx = await baseline();
    const full = readFileSync(path.join(proj, IP), "utf8");
    w(IP, full.slice(0, 40));
    const r = await delta(ctx);
    expect(r).toMatchObject({ kind: "delta", deleted: 0 });
    expect(has(ctx, "IntegrationProcedure:Shop_Checkout")).toBe(true);
    await fullIngest(ctx.store, false);
    expect(has(ctx, "IntegrationProcedure:Shop_Checkout")).toBe(true);
    w(IP, full);
    bump(IP);
    await delta(ctx);
    await expectSameAsRebuild(ctx);
  });

  it("I-1: a flow with broken XML keeps the Flow (delta and full)", async () => {
    const ctx = await baseline();
    const good = readFileSync(path.join(proj, FLOW), "utf8");
    w(FLOW, good.slice(0, Math.floor(good.length / 2)));
    const r = await delta(ctx);
    expect(r.kind).toBe("delta");
    expect(has(ctx, "Flow:Account_Update")).toBe(true);
    await fullIngest(ctx.store, false);
    expect(has(ctx, "Flow:Account_Update")).toBe(true);
    w(FLOW, good.replace("</Flow>", "<description>fixed</description></Flow>"));
    await delta(ctx);
    await expectSameAsRebuild(ctx);
  });

  it("N-4: a ParseError-only member: delta writes the same graph as a full (non-rebuild) ingest", async () => {
    const ctx = await baseline();
    const other = await rebuildInto("full-prior");
    const good = readFileSync(path.join(proj, FLOW), "utf8");
    w(FLOW, good.slice(0, Math.floor(good.length / 2)));
    await delta(ctx);
    await fullIngest(other.store, false);
    await ctx.store.close();
    await other.store.close();
    const lines = (p: string): string[] =>
      [...dumpEntries(p)].map((e) => `${e.disp}\t${e.payload}`);
    const a = lines(ctx.dbPath);
    expect(a.some((l) => l.includes("|ParseError:Flow:Account_Update	"))).toBe(true);
    expect(a).toEqual(lines(other.dbPath));
    expect(sideTables(ctx.dbPath)).toEqual(sideTables(other.dbPath));
  });

  it("N2-1: an unchanged ParseError-only member is skipped by the next delta (no merge pass)", async () => {
    const ctx = await baseline();
    const good = readFileSync(path.join(proj, FLOW), "utf8");
    w(FLOW, good.slice(0, Math.floor(good.length / 2)));
    const first = await delta(ctx);
    expect(first.result).toBeDefined();
    const second = await delta(ctx);
    expect(second.added + second.changed + second.deleted).toBe(0);
    // No merge pass ran: the broken member was counted unchanged, not retried.
    expect(second.result).toBeUndefined();
    // Fixing it is still picked up, and the graph equals a rebuild.
    w(FLOW, good.replace("</Flow>", "<description>fixed</description></Flow>"));
    const third = await delta(ctx);
    expect(third.changed).toBe(1);
    await expectSameAsRebuild(ctx);
  });

  it("I-4: a delta never takes a full-graph snapshot", async () => {
    const ctx = await baseline();
    w(`${MD}/classes/NewSvc.cls`, "public class NewSvc { }");
    const createSnapshot = vi.fn();
    await runDeltaIngest({
      alias: "fixture",
      graphStore: ctx.store,
      preResolved: offlineResolvedOrg(proj, "fixture"),
      metadataSource: FilesystemMetadataSource.fromProjectRoot(proj),
      logger,
      analysisDb: ctx.store.db,
      snapshotStore: { createSnapshot, prune: vi.fn() } as never,
      fullRebuild: async () => {},
    });
    expect(createSnapshot).not.toHaveBeenCalled();
    await ctx.store.close();
  });

  it("the delta summary line goes to `report` when given, never to console.log", async () => {
    const ctx = await baseline();
    w(`${MD}/classes/NewSvc.cls`, "public class NewSvc { }");
    const consoleLog = vi.mocked(console.log);
    consoleLog.mockClear();
    const report = vi.fn();
    await runDeltaIngest({
      alias: "fixture",
      graphStore: ctx.store,
      preResolved: offlineResolvedOrg(proj, "fixture"),
      metadataSource: FilesystemMetadataSource.fromProjectRoot(proj),
      logger,
      skipSnapshot: true,
      analysisDb: ctx.store.db,
      report,
      fullRebuild: async () => {},
    });
    expect(report).toHaveBeenCalledWith(expect.stringMatching(/^delta: \+1 ~0 -0 /));
    expect(consoleLog.mock.calls.flat().some((a) => String(a).startsWith("delta:"))).toBe(false);
    await ctx.store.close();
  });

  it("I-5: shared ownership: two members emitting one qname re-merge in source order", async () => {
    w(
      "sfdx-project.json",
      JSON.stringify({ packageDirectories: [{ path: "force-app" }, { path: "extra" }] }),
    );
    const labels = (v: string): string =>
      `<?xml version="1.0"?><CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata"><labels><fullName>Dup</fullName><value>${v}</value><language>en_US</language><protected>false</protected><shortDescription>Dup</shortDescription></labels></CustomLabels>`;
    w(`${MD}/labels/CustomLabels.labels-meta.xml`, labels("A"));
    w("extra/labels/CustomLabels.labels-meta.xml", labels("B"));
    const ctx = await baseline();
    const rows = ctx.store.listMemberRows(orgId());
    const owners = rows.filter((r) => r.owned.some((q) => q.toLowerCase() === "customlabel:dup"));
    expect(owners).toHaveLength(2);
    w(`${MD}/labels/CustomLabels.labels-meta.xml`, labels("C"));
    await delta(ctx);
    await expectSameAsRebuild(ctx);
    ctx.store = await open(ctx.dbPath);
    w("extra/labels/CustomLabels.labels-meta.xml", labels("D"));
    await delta(ctx);
    await expectSameAsRebuild(ctx);
  });

  it("I-5: an abort after clearing R's edges (before the merge) converges on the next delta", async () => {
    const ctx = await baseline();
    w(
      `${MD}/classes/NewSvc.cls`,
      "public class NewSvc { public static void go() { Util.log('x'); } }",
    );
    rmSync(path.join(proj, `${MD}/classes/LegacyHelper.cls`));
    process.env.SFGRAPH_DELTA_ABORT_AFTER = "clear";
    await expect(delta(ctx)).rejects.toThrow(/SFGRAPH_DELTA_ABORT_AFTER/);
    // biome-ignore lint/performance/noDelete: env var must be truly unset
    delete process.env.SFGRAPH_DELTA_ABORT_AFTER;
    expect(ctx.store.getDeltaPending(orgId())).not.toBeNull();
    await delta(ctx);
    await expectSameAsRebuild(ctx);
  });

  it("M-2: re-merged but unchanged nodes keep last_modified_at", async () => {
    const ctx = await baseline();
    const q = "ApexMethod:AccountService.load(1)";
    const before = ctx.store.getNode(orgId(), q as never)?.lastModifiedAt;
    expect(before).toBeDefined();
    await new Promise((r) => setTimeout(r, 15));
    const svc = `${MD}/classes/AccountService.cls`;
    const src = readFileSync(path.join(proj, svc), "utf8");
    w(svc, src.replace("Util.log(msg);", "Util.log(msg + '!');"));
    const r = await delta(ctx);
    expect(r).toMatchObject({ changed: 1 });
    expect(ctx.store.getNode(orgId(), q as never)?.lastModifiedAt).toBe(before);
    await ctx.store.close();
  });

  it("M-9: a graph from an sfgraph without the member table falls back to a full rebuild", async () => {
    const ctx = await baseline();
    ctx.store.db.exec("DROP TABLE _sfgraph_members; DROP TABLE _sfgraph_delta_pending;");
    await ctx.store.close();
    ctx.store = await open(ctx.dbPath);
    let rebuilt = 0;
    const r = await delta(ctx, { onFullRebuild: () => rebuilt++ });
    expect(r.kind).toBe("full");
    expect(rebuilt).toBe(1);
    await expectSameAsRebuild(ctx);
  });
});

/**
 * Fix round 3 (replay drift): the CLI runs a delta in a fresh process, where
 * no full ingest has registered the declarative (YAML) rule parsers yet. A
 * delta loaded from a reset module graph reproduces that.
 */
describe("fresh process (replay drift)", () => {
  const CMR = `${MD}/customMetadata/Order_Routing.Pilot.md-meta.xml`;
  const cmr = (api: string, target: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?>
<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
    <label>Pilot</label>
    <protected>false</protected>
    <values>
        <field>Billing_API__c</field>
        <value xsi:type="xsd:string">${api}</value>
    </values>
    <values>
        <field>Target__c</field>
        <value xsi:type="xsd:string">${target}</value>
    </values>
</CustomMetadata>
`;

  async function freshDelta(ctx: Ctx): Promise<RunDeltaResult> {
    vi.resetModules();
    const fresh = (await import("../delta.js")) as typeof import("../delta.js");
    return fresh.runDeltaIngest({
      alias: "fixture",
      graphStore: ctx.store,
      preResolved: offlineResolvedOrg(proj, "fixture"),
      metadataSource: FilesystemMetadataSource.fromProjectRoot(proj),
      logger,
      skipSnapshot: true,
      analysisDb: ctx.store.db,
      lockDir: dir,
      fullRebuild: async () => {
        throw new Error("unexpected full rebuild");
      },
    });
  }

  const reflected = (ctx: Ctx, src: string): string[] =>
    ctx.store
      .listEdgesFrom(orgId(), src as never)
      .filter((e) => (e.attributes as Record<string, unknown>)?.source === "reflection")
      .map((e) => String(e.dstQualifiedName));

  it("a changed rule-parsed member (CustomMetadata) keeps its reflection edges", async () => {
    w(CMR, cmr("UpdateComponent", "ORDERHELPER"));
    const ctx = await baseline();
    const src = "CustomMetadataRecord:Order_Routing.Pilot";
    expect(reflected(ctx, src)).toContain("ApexClass:OrderHelper");
    w(CMR, cmr("createProduct", "ORDERHELPER"));
    const r = await freshDelta(ctx);
    expect(r).toMatchObject({ kind: "delta", changed: 1 });
    expect(reflected(ctx, src)).toContain("ApexClass:OrderHelper");
    await expectSameAsRebuild(ctx);
  });

  it("a new reflection target links an unchanged source; deleting it unlinks it", async () => {
    w(CMR, cmr("UpdateComponent", "PILOTTARGET"));
    const ctx = await baseline();
    const src = "CustomMetadataRecord:Order_Routing.Pilot";
    expect(reflected(ctx, src)).toEqual([]);
    w(`${MD}/classes/PilotTarget.cls`, "public class PilotTarget { }");
    expect(await freshDelta(ctx)).toMatchObject({ added: 1, changed: 0 });
    expect(reflected(ctx, src)).toContain("ApexClass:PilotTarget");
    rmSync(path.join(proj, `${MD}/classes/PilotTarget.cls`));
    expect(await freshDelta(ctx)).toMatchObject({ deleted: 1 });
    expect(reflected(ctx, src)).toEqual([]);
    await expectSameAsRebuild(ctx);
  });

  it("a new name-match target (IP) links an unchanged VlocityAction; deleting it unlinks it", async () => {
    const ctx = await baseline();
    const ip = "vlocity/datapacks/IntegrationProcedure/Shop_Refund";
    w(
      `${ip}/Shop_Refund_DataPack.json`,
      JSON.stringify({
        "%vlocity_namespace%__Type__c": "Shop",
        "%vlocity_namespace%__SubType__c": "Refund",
        "%vlocity_namespace%__Language__c": "Procedure",
        "%vlocity_namespace%__Element__c": [],
        Name: "Refund",
      }),
    );
    expect(await freshDelta(ctx)).toMatchObject({ added: 1 });
    rmSync(path.join(proj, ip), { recursive: true, force: true });
    expect(await freshDelta(ctx)).toMatchObject({ deleted: 1 });
    await expectSameAsRebuild(ctx);
  });

  it("arity: a new overload in a changed class re-resolves an unchanged caller", async () => {
    w(
      `${MD}/classes/Caller.cls`,
      "public class Caller { public static void go(Object o) { Target.run(o); } }",
    );
    w(`${MD}/classes/Target.cls`, "public class Target { public static void run(Object o) {} }");
    const ctx = await baseline();
    w(
      `${MD}/classes/Target.cls`,
      "public class Target { public static void run(Object o) {} public static void run(Object o, Integer n) {} }",
    );
    expect(await freshDelta(ctx)).toMatchObject({ changed: 1 });
    await expectSameAsRebuild(ctx);
  });

  it("interface retarget: a new interface takes an unchanged class's references", async () => {
    w(
      `${MD}/classes/Uses.cls`,
      "public class Uses { public static void go(IShape s) { s.area(); } }",
    );
    const ctx = await baseline();
    w(`${MD}/classes/IShape.cls`, "public interface IShape { Decimal area(); }");
    expect(await freshDelta(ctx)).toMatchObject({ added: 1 });
    await expectSameAsRebuild(ctx);
    const ctx2 = { store: await open(ctx.dbPath), dbPath: ctx.dbPath };
    rmSync(path.join(proj, `${MD}/classes/IShape.cls`));
    expect(await freshDelta(ctx2)).toMatchObject({ deleted: 1 });
    await expectSameAsRebuild(ctx2);
  });

  it("an existing scenario (modify Apex) also matches a rebuild from a fresh process", async () => {
    w(CMR, cmr("UpdateComponent", "UTIL"));
    const ctx = await baseline();
    w(
      `${MD}/classes/NewSvc.cls`,
      "public class NewSvc { public static void go() { Util.log('x'); } }",
    );
    await freshDelta(ctx);
    w(CMR, cmr("createProduct", "UTIL"));
    await freshDelta(ctx);
    await expectSameAsRebuild(ctx);
  });
});

describe("perf scenarios (round 4): a member the parser rejects", () => {
  const PAGE = `${MD}/pages/Portal.page`;
  // The page parser throws on this markup (a bare `<` in text), as on the
  // corpus' acme_portal_en.page: the member is read fine, its parse fails.
  const BROKEN = "<apex:page><div>' < '</div></apex:page>\n";
  const GOOD = '<apex:page controller="Util"><div>ok</div></apex:page>\n';
  const META =
    '<?xml version="1.0" encoding="UTF-8"?>\n<ApexPage xmlns="http://soap.sforce.com/2006/04/metadata">\n  <apiVersion>60.0</apiVersion>\n  <label>Portal</label>\n</ApexPage>\n';
  const page = (body: string): void => {
    w(PAGE, body);
    w(`${PAGE}-meta.xml`, META);
  };

  it("a full ingest records its hash, so a delta on the unchanged tree is 0/0/0", async () => {
    page(BROKEN);
    const ctx = await baseline();
    const r = await delta(ctx);
    expect(r).toMatchObject({ kind: "delta", added: 0, changed: 0, deleted: 0 });
    expect(r.result).toBeUndefined();
    await ctx.store.close();
  });

  it("added by a delta, it is skipped by the next one until it changes", async () => {
    const ctx = await baseline();
    page(BROKEN);
    expect(await delta(ctx)).toMatchObject({ added: 1, changed: 0 });
    const second = await delta(ctx);
    expect(second).toMatchObject({ added: 0, changed: 0, deleted: 0 });
    expect(second.result).toBeUndefined();
    page(GOOD);
    expect(await delta(ctx)).toMatchObject({ changed: 1 });
    await expectSameAsRebuild(ctx);
  });

  it("a known page turning unparseable: delta and full ingest record the same row", async () => {
    page(GOOD);
    const ctx = await baseline();
    const other = await rebuildInto("full-prior");
    page(BROKEN);
    await delta(ctx);
    await fullIngest(other.store, false);
    const rows = (p: string): string[] =>
      sideTables(p).members.filter((m) => /[\\/]pages[\\/]Portal\.page/.test(m));
    expect(rows(ctx.dbPath)).toEqual(rows(other.dbPath));
    // Its hash is recorded (not left empty for a retry every delta).
    expect(rows(ctx.dbPath)[0]?.split("\t")[2]).not.toBe("");
    await ctx.store.close();
    await other.store.close();
  });
});

describe("fix round 5: a parse-pool failure is retried, not hashed (N4-1)", () => {
  const UTIL = `${MD}/classes/Util.cls`;
  const has = (ctx: Ctx, q: string): boolean => ctx.store.getNode(orgId(), q as never) !== null;
  /** A pool whose worker exits on Util (a crash blamed on the queue head); skips the rest. */
  const crashingPool = (): NonNullable<LiveIngestOpts["parsePool"]> => {
    const f = path.join(dir, "crash-worker.mjs");
    writeFileSync(
      f,
      `import { parentPort } from "node:worker_threads";
       parentPort.postMessage({ type: "ready" });
       parentPort.on("message", (j) => {
         if (j.member.ref.memberName === "Util") process.exit(7);
         parentPort.postMessage({ type: "done", seq: j.seq, logs: [], outcome: { kind: "skip", parseMs: 0 } });
       });`,
    );
    return { workers: 1, workerUrl: f, minMembers: 0 };
  };
  const utilRow = (dbPath: string): string | undefined =>
    sideTables(dbPath).members.find((m) => /[\\/]classes[\\/]Util\.cls\t/.test(m));

  it("full: a member whose worker crashed gets an empty row and the next delta parses it", async () => {
    const dbPath = path.join(dir, "delta.sqlite");
    const store = await open(dbPath);
    await fullIngest(store, true, crashingPool());
    const ctx: Ctx = { store, dbPath };
    expect(has(ctx, "ApexClass:Util")).toBe(false);
    // Empty fingerprint (retried); the hash counts worker failures on this content (T15 N5-1).
    const [fp, hash] = utilRow(dbPath)?.split("\t").slice(1, 3) ?? [];
    expect(fp).toBe("");
    expect(hash).toMatch(/^w1:[0-9a-f]{64}$/);
    const r = await delta(ctx, { parsePool: { workers: 0 } });
    expect(r.changed).toBeGreaterThanOrEqual(1);
    expect(has(ctx, "ApexClass:Util")).toBe(true);
    await ctx.store.close();
  }, 30_000);

  it("delta: a changed member whose worker crashed is re-parsed by the next delta", async () => {
    const ctx = await baseline();
    w(
      UTIL,
      "public class Util {\n  public static void log(String s) { }\n  public static void two() { }\n}\n",
    );
    await delta(ctx, { parsePool: crashingPool() });
    expect(has(ctx, "ApexMethod:Util.two(0)")).toBe(false);
    const r = await delta(ctx, { parsePool: { workers: 0 } });
    expect(r).toMatchObject({ changed: 1 });
    expect(has(ctx, "ApexMethod:Util.two(0)")).toBe(true);
    await expectSameAsRebuild(ctx);
  }, 30_000);
});

// review I4: an Aura embed is re-targeted against the bundles that exist, so
// adding or deleting a lowercase Aura bundle under an unchanged parent must
// land on the same graph as a rebuild.
describe("review I4: Aura embed targets follow the bundle set (delta = rebuild)", () => {
  const meta = "<AuraDefinitionBundle><apiVersion>60.0</apiVersion></AuraDefinitionBundle>";
  const parent = () => {
    w(`${MD}/aura/AuraShell/AuraShell.cmp`, "<aura:component><c:csvExport/></aura:component>");
    w(`${MD}/aura/AuraShell/AuraShell.cmp-meta.xml`, meta);
  };
  const csv = () => {
    w(`${MD}/aura/csvExport/csvExport.cmp`, "<aura:component><p>csv</p></aura:component>");
    w(`${MD}/aura/csvExport/csvExport.cmp-meta.xml`, meta);
  };
  const embeds = (s: SqliteGraphStore) =>
    s
      .listEdgesFrom(orgId(), "AuraComponent:AuraShell" as never)
      .filter((e) => e.relType.startsWith("EMBEDS_"))
      .map((e) => `${e.relType} ${e.dstQualifiedName}`);

  it("adding the bundle re-targets the unchanged parent's embed", async () => {
    parent();
    const ctx = await baseline();
    expect(embeds(ctx.store)).toEqual(["EMBEDS_LWC LWC:csvExport"]);
    csv();
    const r = await delta(ctx);
    expect(r).toMatchObject({ kind: "delta", added: 1, changed: 0, deleted: 0 });
    expect(embeds(ctx.store)).toEqual(["EMBEDS_AURA AuraComponent:csvExport"]);
    await expectSameAsRebuild(ctx);
  });

  it("deleting the bundle reverts the embed to the rebuild's guess", async () => {
    parent();
    csv();
    const ctx = await baseline();
    expect(embeds(ctx.store)).toEqual(["EMBEDS_AURA AuraComponent:csvExport"]);
    rmSync(path.join(proj, `${MD}/aura/csvExport`), { recursive: true });
    const r = await delta(ctx);
    expect(r).toMatchObject({ kind: "delta", added: 0, changed: 0, deleted: 1 });
    await expectSameAsRebuild(ctx);
  });
});

// T15 ingest I-1: the DR relationship resolver must not take over an edge the
// DataRaptor parser owns. A DR reading both Home_Region__c and
// Home_Region__r.Code__c emits the lookup-field edge twice (parser and
// resolver); deleting or renaming the lookup field must leave the parser's
// edge exactly as a rebuild does.
describe("T15 I-1: DR resolver never owns a parser edge (delta = rebuild)", () => {
  const mappings = "vlocity/datapacks/DataRaptor/AcctFetch/AcctFetch_Mappings.json";
  const field = `${MD}/objects/Account/fields/Home_Region__c.field-meta.xml`;
  const addDirectRead = async () => {
    const { readFileSync } = await import("node:fs");
    const abs = path.join(proj, mappings);
    const rows = JSON.parse(readFileSync(abs, "utf8")) as Array<Record<string, unknown>>;
    rows.push({ ...rows[0], "%vlocity_namespace%__InterfaceFieldAPIName__c": "Home_Region__c" });
    writeFileSync(abs, JSON.stringify(rows, null, 2));
  };

  it("deleting the lookup field", async () => {
    await addDirectRead();
    const ctx = await baseline();
    rmSync(path.join(proj, field));
    const r = await delta(ctx);
    expect(r).toMatchObject({ kind: "delta", changed: 1 }); // fields are part of the object member
    await expectSameAsRebuild(ctx);
  });

  it("renaming the lookup field", async () => {
    await addDirectRead();
    const ctx = await baseline();
    const { readFileSync } = await import("node:fs");
    const xml = readFileSync(path.join(proj, field), "utf8").replaceAll("Home_Region", "Home_Area");
    rmSync(path.join(proj, field));
    w(`${MD}/objects/Account/fields/Home_Area__c.field-meta.xml`, xml);
    const r = await delta(ctx);
    expect(r).toMatchObject({ kind: "delta" });
    await expectSameAsRebuild(ctx);
  });
});

// T15 N5-1: a member whose worker crashes or stalls on the same content N
// times in a row is recorded as failed and skipped until its content changes;
// the count is surfaced in the ingest result.
describe("T15 N5-1: repeated worker crashes on one content hash quarantine the member", () => {
  const UTIL = `${MD}/classes/Util.cls`;
  const has = (ctx: Ctx, q: string): boolean => ctx.store.getNode(orgId(), q as never) !== null;
  const crashingPool = (
    stats?: NonNullable<LiveIngestOpts["parsePool"]>["stats"],
  ): NonNullable<LiveIngestOpts["parsePool"]> => {
    const f = path.join(dir, "crash-worker.mjs");
    writeFileSync(
      f,
      `import { parentPort } from "node:worker_threads";
       parentPort.postMessage({ type: "ready" });
       parentPort.on("message", (j) => {
         if (j.member.ref.memberName === "Util") process.exit(7);
         parentPort.postMessage({ type: "done", seq: j.seq, logs: [], outcome: { kind: "skip", parseMs: 0 } });
       });`,
    );
    return { workers: 1, workerUrl: f, minMembers: 0, ...(stats ? { stats } : {}) };
  };
  const utilRow = (ctx: Ctx) =>
    ctx.store.listMemberRows(orgId()).find((r) => /[\\/]classes[\\/]Util\.cls$/.test(r.key));
  const two =
    "public class Util {\n  public static void log(String s) { }\n  public static void two() { }\n}\n";

  it("delta: three crashes on the same content quarantine it; a content change lifts it", async () => {
    const ctx = await baseline();
    w(UTIL, two);
    for (let i = 1; i <= 3; i++) {
      const r = await delta(ctx, { parsePool: crashingPool() });
      expect(r.changed).toBe(1);
      expect(r.result?.parseQuarantined ?? 0).toBe(i === 3 ? 1 : 0);
    }
    expect(utilRow(ctx)?.fingerprint).not.toBe("");
    // Skipped: the next delta neither parses it nor dispatches it to a worker.
    const stats = { workers: 0, pooled: 0, inProcess: 0, fallbacks: 0, crashes: 0 };
    const r4 = await delta(ctx, { parsePool: crashingPool(stats) });
    expect(r4).toMatchObject({ changed: 0, added: 0, deleted: 0 });
    expect(stats.crashes).toBe(0);
    // Its content changes: parsed again (the old graph was kept meanwhile).
    expect(has(ctx, "ApexClass:Util")).toBe(true);
    w(UTIL, two.replace("two()", "three()"));
    const r5 = await delta(ctx, { parsePool: { workers: 0 } });
    expect(r5.changed).toBe(1);
    expect(r5.result?.parseQuarantined ?? 0).toBe(0);
    expect(has(ctx, "ApexMethod:Util.three(0)")).toBe(true);
    await expectSameAsRebuild(ctx);
  }, 60_000);

  it("full (non-rebuild): a quarantined member is not dispatched again", async () => {
    const ctx = await baseline();
    w(UTIL, two);
    for (let i = 0; i < 3; i++) await delta(ctx, { parsePool: crashingPool() });
    const stats = { workers: 0, pooled: 0, inProcess: 0, fallbacks: 0, crashes: 0 };
    await fullIngest(ctx.store, false, crashingPool(stats));
    expect(stats.crashes).toBe(0);
    expect(has(ctx, "ApexClass:Util")).toBe(true);
    expect(utilRow(ctx)?.fingerprint).not.toBe("");
    await ctx.store.close();
  }, 60_000);

  it("a success in between resets the count", async () => {
    const ctx = await baseline();
    w(UTIL, two);
    await delta(ctx, { parsePool: crashingPool() });
    await delta(ctx, { parsePool: crashingPool() });
    await delta(ctx, { parsePool: { workers: 0 } }); // parsed fine: hashed, unchanged next time
    w(UTIL, `${two}// edit\n`);
    for (let i = 0; i < 2; i++) {
      const r = await delta(ctx, { parsePool: crashingPool() });
      expect(r.result?.parseQuarantined ?? 0).toBe(0);
    }
    expect(utilRow(ctx)?.fingerprint).toBe("");
    await ctx.store.close();
  }, 60_000);
});
