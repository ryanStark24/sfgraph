import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { ConsoleLogger, type Logger } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilesystemMetadataSource } from "../../extractors/filesystem/index.js";
import type { RawMember } from "../../extractors/interfaces/metadata-source.js";
import { loadAllRules } from "../../parsers/rules/_loader.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { liveIngest } from "../live-ingest.js";
import { offlineResolvedOrg } from "../offline-org.js";
import type { MemberParse } from "../parse-member.js";
import {
  DEFAULT_PARSE_WORKER_HEAP_MB,
  type ParsePoolOpts,
  type ParsePoolStats,
  type ParsedMember,
  parsePool,
  resolveParseWorkers,
} from "../parse-pool.js";

// vitest runs from sources (no dist): a JS bootstrap registers tsx in the
// worker and then loads the real TS worker.
const TS_WORKER_SRC = new URL("../parse-worker.ts", import.meta.url).href;
const TSX_API = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href;
let TS_WORKER: string;
const GRAPH_DUMP = pathToFileURL(
  path.resolve(__dirname, "../../../../../bench/lib/graph-dump.mjs"),
).href;
type DumpLines = (dbPath: string, opts?: { orgId?: string }) => Iterable<string>;

const BASE = { orgId: "00DFS0000000001", parseTimestamp: "2026-10-09T00:00:00.000Z" };
const NS = "%vlocity_namespace%__";

let dir: string;
let proj: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-pool-"));
  proj = path.join(dir, "proj");
  writeFixture(proj);
  TS_WORKER = path.join(dir, "tsx-boot.mjs");
  writeFileSync(
    TS_WORKER,
    `const { register } = await import(${JSON.stringify(TSX_API)});\nregister();\nawait import(${JSON.stringify(TS_WORKER_SRC)});\n`,
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function w(root: string, rel: string, c: unknown): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, typeof c === "string" ? c : JSON.stringify(c), "utf8");
}

/** Apex, LWC, Flow, object/field, vlocity (DR/IP/OS/Card) plus a qname emitted twice. */
function writeFixture(root: string): void {
  const md = "force-app/main/default";
  w(
    root,
    "sfdx-project.json",
    JSON.stringify({ packageDirectories: [{ path: "force-app" }, { path: "extra-app" }] }),
  );
  // Same class twice: the later member must win (last writer) in both modes.
  w(
    root,
    "extra-app/main/default/classes/OrderHelper.cls",
    "public class OrderHelper { public static void touch(List<Account> a) { } }",
  );
  w(
    root,
    `${md}/classes/AccountService.cls`,
    `public with sharing class AccountService {
       @AuraEnabled public static List<Account> load(Set<Id> ids) {
         return [SELECT Id, Name, Tier__c FROM Account WHERE Id IN :ids];
       }
       public static void save(List<Account> accts) { update accts; OrderHelper.touch(accts); }
     }`,
  );
  w(
    root,
    `${md}/classes/OrderHelper.cls`,
    `public class OrderHelper {
       public static void touch(List<Account> a) { insert new Order__c(Account__c = a[0].Id); }
       public static Integer count() { return [SELECT COUNT() FROM Order__c]; }
     }`,
  );
  w(
    root,
    `${md}/classes/CheckoutSvc.cls`,
    "global class CheckoutSvc implements vlocity_cmt.VlocityOpenInterface { global Boolean invokeMethod(String m, Map<String,Object> i, Map<String,Object> o, Map<String,Object> p) { return true; } }",
  );
  w(
    root,
    `${md}/triggers/AccountTrigger.trigger`,
    "trigger AccountTrigger on Account (before update) { AccountService.save(Trigger.new); }",
  );
  w(
    root,
    `${md}/objects/Account/Account.object-meta.xml`,
    "<CustomObject><label>Account</label></CustomObject>",
  );
  w(
    root,
    `${md}/objects/Account/fields/Tier__c.field-meta.xml`,
    "<CustomField><fullName>Tier__c</fullName><type>Text</type></CustomField>",
  );
  w(
    root,
    `${md}/objects/Account/fields/Score__c.field-meta.xml`,
    "<CustomField><fullName>Score__c</fullName><type>Number</type><formula>LEN(Tier__c)</formula></CustomField>",
  );
  w(
    root,
    `${md}/objects/Order__c/Order__c.object-meta.xml`,
    "<CustomObject><label>Order</label></CustomObject>",
  );
  w(
    root,
    `${md}/objects/Order__c/fields/Account__c.field-meta.xml`,
    "<CustomField><fullName>Account__c</fullName><type>Lookup</type><referenceTo>Account</referenceTo><relationshipName>Orders</relationshipName></CustomField>",
  );
  w(
    root,
    `${md}/lwc/accountCard/accountCard.js`,
    `import { LightningElement, wire } from 'lwc';
     import load from '@salesforce/apex/AccountService.load';
     import TIER from '@salesforce/schema/Account.Tier__c';
     export default class AccountCard extends LightningElement { @wire(load) accts; tier = TIER; }`,
  );
  w(
    root,
    `${md}/lwc/accountCard/accountCard.html`,
    "<template><c-order-list record-id={recordId}></c-order-list></template>",
  );
  w(
    root,
    `${md}/lwc/accountCard/accountCard.js-meta.xml`,
    '<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>60.0</apiVersion><isExposed>true</isExposed></LightningComponentBundle>',
  );
  w(
    root,
    `${md}/lwc/orderList/orderList.js`,
    "import { LightningElement, api } from 'lwc'; export default class OrderList extends LightningElement { @api recordId; }",
  );
  w(
    root,
    `${md}/lwc/orderList/orderList.js-meta.xml`,
    "<LightningComponentBundle><apiVersion>60.0</apiVersion></LightningComponentBundle>",
  );
  w(
    root,
    `${md}/flows/Account_Update.flow-meta.xml`,
    `<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
       <processType>AutoLaunchedFlow</processType>
       <start><object>Account</object><triggerType>RecordAfterSave</triggerType></start>
       <actionCalls><name>Call_Svc</name><actionName>AccountService</actionName><actionType>apex</actionType></actionCalls>
       <recordUpdates><name>Upd</name><object>Account</object>
         <inputAssignments><field>Tier__c</field><value><stringValue>Gold</stringValue></value></inputAssignments>
       </recordUpdates>
     </Flow>`,
  );
  w(
    root,
    `${md}/permissionsets/Sales.permissionset-meta.xml`,
    `<PermissionSet><label>Sales</label>
       <classAccesses><apexClass>AccountService</apexClass><enabled>true</enabled></classAccesses>
       <fieldPermissions><field>Account.Tier__c</field><readable>true</readable><editable>false</editable></fieldPermissions>
     </PermissionSet>`,
  );
  w(
    root,
    `${md}/labels/CustomLabels.labels-meta.xml`,
    "<CustomLabels><labels><fullName>Greeting</fullName><value>Hi</value></labels></CustomLabels>",
  );
  const dp = "vlocity/datapacks";
  w(root, `${dp}/DataRaptor/AcctFetch/AcctFetch_DataPack.json`, {
    Name: "AcctFetch",
    [`${NS}Type__c`]: "Extract",
    [`${NS}DRMapItem__c`]: "AcctFetch_Mappings.json",
  });
  w(root, `${dp}/DataRaptor/AcctFetch/AcctFetch_Mappings.json`, [
    {
      [`${NS}InterfaceObjectName__c`]: "Account",
      [`${NS}InterfaceFieldAPIName__c`]: "Tier__c",
      [`${NS}InterfaceObjectLookupOrder__c`]: 1,
      [`${NS}DomainObjectAPIName__c`]: "json",
      [`${NS}DomainObjectFieldAPIName__c`]: "Acct:Tier",
    },
  ]);
  w(root, `${dp}/IntegrationProcedure/Shop_Checkout/Shop_Checkout_DataPack.json`, {
    [`${NS}Type__c`]: "Shop",
    [`${NS}SubType__c`]: "Checkout",
    [`${NS}Language__c`]: "Procedure",
    [`${NS}Element__c`]: ["Shop_Checkout_Element_RA.json", "Shop_Checkout_Element_DR.json"],
    Name: "Checkout",
  });
  w(root, `${dp}/IntegrationProcedure/Shop_Checkout/Shop_Checkout_Element_RA.json`, {
    Name: "RA",
    [`${NS}Type__c`]: "Remote Action",
    [`${NS}PropertySet__c`]: { remoteClass: "CheckoutSvc", remoteMethod: "submit" },
  });
  w(root, `${dp}/IntegrationProcedure/Shop_Checkout/Shop_Checkout_Element_DR.json`, {
    Name: "Fetch",
    [`${NS}Type__c`]: "DataRaptor Extract Action",
    [`${NS}PropertySet__c`]: { bundle: "AcctFetch" },
  });
  w(root, `${dp}/OmniScript/Plan_Select_English/Plan_Select_English_DataPack.json`, {
    [`${NS}Type__c`]: "Plan",
    [`${NS}SubType__c`]: "Select",
    [`${NS}Language__c`]: "English",
    [`${NS}Element__c`]: ["Plan_Select_English_Element_IP.json"],
  });
  w(root, `${dp}/OmniScript/Plan_Select_English/Plan_Select_English_Element_IP.json`, {
    Name: "CallIP",
    [`${NS}Type__c`]: "Integration Procedure Action",
    [`${NS}PropertySet__c`]: { integrationProcedureKey: "Shop_Checkout" },
  });
  w(root, `${dp}/VlocityCard/Plan-Cards/Plan-Cards_DataPack.json`, {
    Name: "Plan Cards",
    [`${NS}Definition__c`]: "Plan-Cards.json",
  });
  w(root, `${dp}/VlocityCard/Plan-Cards/Plan-Cards.json`, {
    dataSource: { type: "IntegrationProcedures", value: { ipMethod: "Shop_Checkout" } },
    states: [],
  });
}

async function members(): Promise<RawMember[]> {
  const src = await FilesystemMetadataSource.fromProjectRoot(proj);
  const out: RawMember[] = [];
  for await (const m of src.iter()) out.push(m);
  return out;
}

/** Recording logger: parser log calls must replay in the same order. */
function recLogger(): { logger: Logger; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const mk =
    (level: string) =>
    (...a: unknown[]): void => {
      calls.push([level, ...a]);
    };
  return {
    calls,
    logger: { debug: mk("debug"), info: mk("info"), warn: mk("warn"), error: mk("error") },
  };
}

function withoutTiming(o: MemberParse): unknown {
  const { parseMs: _ms, ...rest } = o;
  return rest;
}

async function run(
  ms: Iterable<RawMember> | AsyncIterable<RawMember>,
  opts: Partial<ParsePoolOpts>,
): Promise<ParsedMember[]> {
  const out: ParsedMember[] = [];
  for await (const p of parsePool(ms, { ...BASE, ...opts })) out.push(p);
  return out;
}

function fakeWorker(body: string): string {
  const f = path.join(dir, `fake-worker-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(
    f,
    `import { parentPort } from "node:worker_threads";
     const port = parentPort;
     const ok = (seq, name) => port.postMessage({ type: "done", seq, logs: [], outcome: {
       kind: "parsed", parseMs: 0, result: { nodes: [{ qualifiedName: "X:" + name }], edges: [] } } });
     ${body}`,
  );
  return f;
}

function newStats(): ParsePoolStats {
  return { workers: 0, pooled: 0, inProcess: 0, fallbacks: 0, crashes: 0 };
}

function member(name: string): RawMember {
  return {
    ref: {
      category: "apex" as never,
      memberType: "ApexClass",
      memberName: name,
      lastModifiedAt: null,
      sourceUri: `x://${name}`,
    },
    content: `public class ${name} {}`,
  };
}

describe("resolveParseWorkers", () => {
  it("defaults to cpus - 1 capped at 4, honours an explicit count, 0 disables", () => {
    expect(resolveParseWorkers(undefined, 4)).toBe(3);
    expect(resolveParseWorkers(undefined, 1)).toBe(1);
    expect(resolveParseWorkers(undefined, 6)).toBe(4);
    expect(resolveParseWorkers(undefined, 32)).toBe(4);
    expect(resolveParseWorkers("12", 32)).toBe(12);
    expect(resolveParseWorkers("0", 32)).toBe(0);
    expect(resolveParseWorkers("nope", 4)).toBe(3);
    expect(resolveParseWorkers("", 4)).toBe(3);
  });
});

describe("parsePool", () => {
  it("yields the same outcomes, in input order, as serial parsing (real worker)", async () => {
    await loadAllRules();
    const ms = await members();
    expect(ms.length).toBeGreaterThan(15);
    const types = new Set(ms.map((m) => m.ref.memberType));
    for (const t of [
      "ApexClass",
      "ApexTrigger",
      "LightningComponentBundle",
      "Flow",
      "CustomObject",
      "DataRaptor",
      "IntegrationProcedure",
      "OmniScript",
      "VlocityCard",
    ]) {
      expect(types, t).toContain(t);
    }

    const serialLog = recLogger();
    const serial = await run(ms, { workers: 0, logger: serialLog.logger });

    const poolLog = recLogger();
    const stats: ParsePoolStats = { workers: 0, pooled: 0, inProcess: 0, fallbacks: 0, crashes: 0 };
    const t0 = performance.now();
    const pooled = await run(ms, {
      workers: 3,
      workerUrl: TS_WORKER,
      minMembers: 0,
      perWorker: 2,
      logger: poolLog.logger,
      stats,
    });
    const poolMs = performance.now() - t0;

    expect(stats.workers).toBe(3);
    expect(stats.pooled).toBe(ms.length);
    expect(stats.crashes).toBe(0);
    expect(pooled.map((p) => p.member)).toEqual(ms);
    const a = serial.map((p) => withoutTiming(p.outcome));
    const b = pooled.map((p) => withoutTiming(p.outcome));
    expect(a.filter((o) => (o as { kind: string }).kind === "parsed").length).toBeGreaterThan(15);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(b).toEqual(a);
    expect(poolLog.calls).toEqual(serialLog.calls);
    console.log(
      `parse-pool fixture: ${ms.length} members, pool (3 workers, incl. start) ${poolMs.toFixed(0)} ms`,
    );
  }, 60_000);

  it("stays serial below minMembers", async () => {
    const stats: ParsePoolStats = { workers: 0, pooled: 0, inProcess: 0, fallbacks: 0, crashes: 0 };
    const out = await run([member("A"), member("B")], {
      workers: 2,
      workerUrl: fakeWorker(`throw new Error("must not start");`),
      minMembers: 5,
      stats,
    });
    expect(out.map((o) => o.outcome.kind)).toEqual(["parsed", "parsed"]);
    expect(stats.workers).toBe(0);
    expect(stats.inProcess).toBe(2);
  });

  it("a worker crash fails only that member, re-dispatches the rest, and does not hang", async () => {
    const stats: ParsePoolStats = { workers: 0, pooled: 0, inProcess: 0, fallbacks: 0, crashes: 0 };
    const names = ["A", "B", "Boom", "C", "D", "E", "F", "G"];
    const out = await run(
      names.map((n) => member(n)),
      {
        workers: 2,
        perWorker: 3,
        minMembers: 0,
        workerUrl: fakeWorker(`
          port.postMessage({ type: "ready" });
          port.on("message", (j) => {
            if (j.member.ref.memberName === "Boom") process.exit(7);
            ok(j.seq, j.member.ref.memberName); // one at a time, like the real worker
          });`),
        stats,
      },
    );
    expect(out.map((o) => o.member.ref.memberName)).toEqual(names);
    const boom = out[2]?.outcome;
    expect(boom?.kind).toBe("error");
    expect(boom).toMatchObject({
      // A lost worker is transient (N4-1), not a parser verdict on the content.
      phase: "worker",
      message: expect.stringMatching(/exited with code 7/),
    });
    for (const [i, o] of out.entries()) {
      if (i === 2) continue;
      expect(o.outcome.kind, names[i]).toBe("parsed");
    }
    expect(stats.crashes).toBe(1);
  }, 20_000);

  it("caps each worker's old-generation heap (default 256 MB, option and 0 = none)", async () => {
    const probe = fakeWorker(`
      import { resourceLimits } from "node:worker_threads";
      port.postMessage({ type: "ready" });
      port.on("message", (j) => ok(j.seq, String(resourceLimits.maxOldGenerationSizeMb)));`);
    const cap = async (o: Partial<ParsePoolOpts>): Promise<unknown> => {
      const out = await run([member("A")], { workers: 1, minMembers: 0, workerUrl: probe, ...o });
      const r = out[0]?.outcome;
      return r?.kind === "parsed" ? r.result.nodes[0]?.qualifiedName : r;
    };
    expect(await cap({})).toBe(`X:${DEFAULT_PARSE_WORKER_HEAP_MB}`);
    expect(DEFAULT_PARSE_WORKER_HEAP_MB).toBe(256);
    expect(await cap({ workerHeapMb: 64 })).toBe("X:64");
    // No cap: V8's own default (well above 256 on 64-bit).
    expect(Number(String(await cap({ workerHeapMb: 0 })).slice(2))).toBeGreaterThan(256);
  }, 20_000);

  it("a worker over its heap cap has that member re-parsed on main, not failed", async () => {
    const stats = newStats();
    const names = ["A", "B", "Big", "C", "D"];
    const out = await run(
      names.map((n) => member(n)),
      {
        workers: 1,
        perWorker: 2,
        minMembers: 0,
        workerHeapMb: 16,
        workerUrl: fakeWorker(`
          port.postMessage({ type: "ready" });
          port.on("message", (j) => {
            if (j.member.ref.memberName === "Big") {
              const hog = [];
              for (;;) hog.push(new Array(100000).fill({ x: hog.length }));
            }
            ok(j.seq, j.member.ref.memberName);
          });`),
        stats,
      },
    );
    expect(out.map((o) => o.member.ref.memberName)).toEqual(names);
    const big = out[2]?.outcome;
    // The real main-thread parse, not a worker error and not the fake's node.
    expect(big?.kind).toBe("parsed");
    if (big?.kind === "parsed") {
      expect(big.result.nodes.some((n) => n.qualifiedName === "X:Big")).toBe(false);
      expect(big.result.nodes.length).toBeGreaterThan(0);
    }
    for (const [i, o] of out.entries()) {
      if (i === 2) continue;
      expect(o.outcome, names[i]).toMatchObject({ kind: "parsed" });
    }
    // An OOM is not a crash: it has its own count and bound.
    expect(stats.crashes).toBe(0);
    expect(stats.oomFallbacks).toBe(1);
    expect(stats.inProcess).toBeGreaterThanOrEqual(1);
  }, 30_000);

  const hogWorker = (): string =>
    fakeWorker(`
          port.postMessage({ type: "ready" });
          port.on("message", (j) => {
            if (j.member.ref.memberName.startsWith("Big")) {
              const hog = [];
              for (;;) hog.push(new Array(100000).fill({ x: hog.length }));
            }
            ok(j.seq, j.member.ref.memberName);
          });`);

  it("OOM fallbacks have their own bound, max(10, workers*4), and warn with type and count only", async () => {
    // 4 OOMs: over the crash bound (3) but under the OOM bound (10), so the
    // pool keeps going and the members after them still parse in workers.
    const stats = newStats();
    const log = recLogger();
    const names = ["Big1", "Big2", "Big3", "Big4", "A", "B", "C"];
    const out = await run(
      names.map((n) => member(n)),
      {
        workers: 1,
        perWorker: 1,
        minMembers: 0,
        workerHeapMb: 16,
        workerUrl: hogWorker(),
        stats,
        logger: log.logger,
      },
    );
    expect(out.map((o) => o.member.ref.memberName)).toEqual(names);
    expect(stats.oomFallbacks).toBe(4);
    expect(stats.crashes).toBe(0);
    // Members after the OOMs went through the (fake) worker.
    expect(
      out
        .slice(4)
        .map((o) =>
          o.outcome.kind === "parsed" ? o.outcome.result.nodes[0]?.qualifiedName : o.outcome.kind,
        ),
    ).toEqual(["X:A", "X:B", "X:C"]);
    const warns = log.calls.filter((c) => c[0] === "warn");
    expect(warns.length).toBe(4);
    expect(warns[3]?.[2]).toMatchObject({ memberType: "ApexClass", oomFallbacks: 4 });
    // Never a member name: org data may be sensitive.
    expect(JSON.stringify(warns)).not.toMatch(/Big/);
  }, 60_000);

  it("past the OOM bound the pool breaks and the rest parse on main", async () => {
    const stats = newStats();
    const log = recLogger();
    const names = [...Array.from({ length: 10 }, (_, i) => `Big${i}`), "A", "B"];
    const out = await run(
      names.map((n) => member(n)),
      {
        workers: 1,
        perWorker: 1,
        minMembers: 0,
        workerHeapMb: 16,
        workerUrl: hogWorker(),
        stats,
        logger: log.logger,
      },
    );
    expect(out.map((o) => o.member.ref.memberName)).toEqual(names);
    expect(stats.oomFallbacks).toBe(10);
    // A and B: real main-thread parses, not the fake worker's node.
    for (const o of out.slice(10)) {
      expect(o.outcome.kind).toBe("parsed");
      if (o.outcome.kind === "parsed")
        expect(o.outcome.result.nodes.some((n) => n.qualifiedName.startsWith("X:"))).toBe(false);
    }
    expect(JSON.stringify(log.calls)).not.toMatch(/Big/);
    expect(log.calls.some((c) => c[0] === "warn" && String(c[1]).includes("heap cap"))).toBe(true);
  }, 90_000);

  it("a stalled worker fails its member after the stall timeout (start-up not counted)", async () => {
    // Ready only after 800 ms: longer than the stall timeout, which must not
    // start until the worker is ready.
    const out = await run([member("A"), member("Hang"), member("C")], {
      workers: 1,
      perWorker: 1,
      minMembers: 0,
      stallTimeoutMs: 300,
      workerUrl: fakeWorker(`
        port.on("message", (j) => { if (j.member.ref.memberName !== "Hang") ok(j.seq, j.member.ref.memberName); });
        setTimeout(() => port.postMessage({ type: "ready" }), 800);`),
    });
    expect(out.map((o) => o.outcome.kind)).toEqual(["parsed", "error", "parsed"]);
    expect(out[1]?.outcome).toMatchObject({ message: expect.stringMatching(/unresponsive/) });
  }, 20_000);

  it("a worker that never becomes ready hits the start-up timeout and falls back", async () => {
    const stats = newStats();
    const out = await run([member("A"), member("B"), member("C")], {
      workers: 1,
      minMembers: 0,
      startupTimeoutMs: 300,
      workerUrl: fakeWorker("setInterval(() => {}, 1000);"),
      stats,
    });
    expect(out.map((o) => o.outcome.kind)).toEqual(["parsed", "parsed", "parsed"]);
    expect(stats.inProcess).toBe(3);
    expect(stats.crashes).toBe(0);
  }, 20_000);

  it("breaks the pool after 3 crashes after ready and re-parses on the main thread", async () => {
    const stats = newStats();
    const names = ["A", "B", "C", "D", "E", "F", "G", "H"];
    const out = await run(
      names.map((n) => member(n)),
      {
        workers: 1,
        perWorker: 1,
        minMembers: 0,
        workerUrl: fakeWorker(`
          port.postMessage({ type: "ready" });
          port.on("message", () => process.exit(9));`),
        stats,
      },
    );
    expect(out.map((o) => o.member.ref.memberName)).toEqual(names);
    expect(stats.crashes).toBe(3);
    // The first two culprits were yielded before the third crash; the third
    // (still waiting its turn) and everything after it parse on main.
    expect(out.map((o) => o.outcome.kind)).toEqual([
      "error",
      "error",
      "parsed",
      "parsed",
      "parsed",
      "parsed",
      "parsed",
      "parsed",
    ]);
    expect(stats.inProcess).toBe(6);
    expect(stats.pooled).toBe(2);
  }, 30_000);

  it("workers that cannot load fall back to main-thread parsing with the same output", async () => {
    await loadAllRules();
    const ms = await members();
    const serial = await run(ms, { workers: 0 });
    const stats: ParsePoolStats = { workers: 0, pooled: 0, inProcess: 0, fallbacks: 0, crashes: 0 };
    const out = await run(ms, {
      workers: 2,
      minMembers: 0,
      workerUrl: fakeWorker(`throw new Error("cannot load parsers");`),
      stats,
    });
    expect(out.map((p) => withoutTiming(p.outcome))).toEqual(
      serial.map((p) => withoutTiming(p.outcome)),
    );
    expect(stats.inProcess).toBe(ms.length);
    expect(stats.pooled).toBe(0);
  }, 20_000);

  it("a non-plain result is re-parsed on the main thread", async () => {
    const out = await run([member("A"), member("B")], {
      workers: 1,
      minMembers: 0,
      workerUrl: fakeWorker(`
        port.postMessage({ type: "ready" });
        port.on("message", (j) => port.postMessage({ type: "fallback", seq: j.seq, reason: "x" }));`),
    });
    // Re-parsed by the real Apex parser on the main thread.
    expect(out.map((o) => o.outcome.kind)).toEqual(["parsed", "parsed"]);
    const r = out[0]?.outcome as Extract<MemberParse, { kind: "parsed" }>;
    expect(r.result.nodes.some((n) => String(n.qualifiedName) === "ApexClass:A")).toBe(true);
  });

  it("yields members read during the read-ahead before an upstream error (default minMembers)", async () => {
    async function* src(): AsyncGenerator<RawMember> {
      yield member("A");
      yield member("B");
      yield member("C");
      throw new Error("stream broke");
    }
    const got: string[] = [];
    await expect(
      (async () => {
        for await (const p of parsePool(src(), {
          ...BASE,
          workers: 2,
          workerUrl: fakeWorker(`throw new Error("must not start");`),
        })) {
          got.push(p.member.ref.memberName);
        }
      })(),
    ).rejects.toThrow(/stream broke/);
    expect(got).toEqual(["A", "B", "C"]);
  });

  it("an early consumer break terminates every worker", async () => {
    const terminate = vi.spyOn(Worker.prototype, "terminate");
    let sourceClosed = false;
    function* src(): Generator<RawMember> {
      try {
        for (let i = 0; i < 200; i++) yield member(`M${i}`);
      } finally {
        sourceClosed = true;
      }
    }
    const stats = newStats();
    let n = 0;
    for await (const _p of parsePool(src(), {
      ...BASE,
      workers: 2,
      perWorker: 2,
      minMembers: 0,
      workerUrl: fakeWorker(`
        port.postMessage({ type: "ready" });
        port.on("message", (j) => ok(j.seq, j.member.ref.memberName));`),
      stats,
    })) {
      if (++n === 3) break;
    }
    expect(stats.workers).toBe(2);
    const workers = new Set(terminate.mock.instances);
    expect(workers.size).toBe(2);
    const codes = await Promise.all(terminate.mock.results.map((r) => r.value as Promise<number>));
    expect(codes.length).toBeGreaterThanOrEqual(2);
    expect(sourceClosed).toBe(true);
  }, 20_000);

  it("an early break does not wait behind a pending upstream pull", async () => {
    let release: () => void = () => {};
    const never = new Promise<void>((r) => {
      release = r;
    });
    async function* src(): AsyncGenerator<RawMember> {
      yield member("A");
      yield member("B");
      await never; // a live fetch that has not answered yet
      yield member("C");
    }
    const t0 = performance.now();
    for await (const p of parsePool(src(), {
      ...BASE,
      workers: 1,
      minMembers: 0,
      workerUrl: fakeWorker(`
        port.postMessage({ type: "ready" });
        port.on("message", (j) => ok(j.seq, j.member.ref.memberName));`),
    })) {
      expect(p.member.ref.memberName).toBe("A");
      break;
    }
    expect(performance.now() - t0).toBeLessThan(5_000);
    release();
  }, 10_000);

  it("yields members read before an upstream error, then rethrows it", async () => {
    async function* src(): AsyncGenerator<RawMember> {
      yield member("A");
      yield member("B");
      throw new Error("stream broke");
    }
    const got: string[] = [];
    await expect(
      (async () => {
        for await (const p of parsePool(src(), {
          ...BASE,
          workers: 1,
          minMembers: 0,
          workerUrl: fakeWorker(`
            port.postMessage({ type: "ready" });
            port.on("message", (j) => ok(j.seq, j.member.ref.memberName));`),
        })) {
          got.push(p.member.ref.memberName);
        }
      })(),
    ).rejects.toThrow(/stream broke/);
    expect(got).toEqual(["A", "B"]);
  });
});

describe("liveIngest with the parse pool", () => {
  async function ingest(
    dbPath: string,
    parsePoolOpts: Pick<ParsePoolOpts, "workers" | "workerUrl" | "minMembers" | "stats">,
  ) {
    const graphStore = new SqliteGraphStore({ dbPath, backupDir: path.join(dir, "bk") });
    await graphStore.init();
    const resolved = offlineResolvedOrg(proj, "fixture");
    const res = await liveIngest({
      alias: "fixture",
      graphStore,
      mode: "full",
      rebuild: true,
      preResolved: resolved,
      metadataSource: await FilesystemMetadataSource.fromProjectRoot(proj),
      logger: new ConsoleLogger("error"),
      skipSnapshot: true,
      analysisDb: graphStore.db,
      parsePool: parsePoolOpts,
    });
    const fts = graphStore.db
      .prepare(
        "SELECT rowid, qualified_name, org_id, label, body FROM _sfgraph_node_fts ORDER BY rowid",
      )
      .all();
    await graphStore.close();
    return { res, fts };
  }

  it("builds a graph identical (dumpLines + FTS) to serial parsing", async () => {
    const { dumpLines } = (await import(GRAPH_DUMP)) as { dumpLines: DumpLines };
    const serialDb = path.join(dir, "serial.sqlite");
    const poolDb = path.join(dir, "pool.sqlite");
    // SFGRAPH_DEBUG_INGEST traces are emitted on the main thread as each
    // result is applied, so they must come out in the same order.
    const prevDebug = process.env.SFGRAPH_DEBUG_INGEST;
    process.env.SFGRAPH_DEBUG_INGEST = "1";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const traces = (): string[] =>
      logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("ingest: [trace]"));
    let s: Awaited<ReturnType<typeof ingest>>;
    let p: Awaited<ReturnType<typeof ingest>>;
    let serialTrace: string[];
    let poolTrace: string[];
    const serialStats = newStats();
    const poolStats = newStats();
    const t0 = performance.now();
    let t1 = 0;
    try {
      s = await ingest(serialDb, { workers: 0, stats: serialStats });
      serialTrace = traces();
      logSpy.mockClear();
      t1 = performance.now();
      p = await ingest(poolDb, {
        workers: 3,
        workerUrl: TS_WORKER,
        minMembers: 0,
        stats: poolStats,
      });
      poolTrace = traces();
    } finally {
      if (prevDebug === undefined) Reflect.deleteProperty(process.env, "SFGRAPH_DEBUG_INGEST");
      else process.env.SFGRAPH_DEBUG_INGEST = prevDebug;
      vi.restoreAllMocks();
    }
    const serialMs = t1 - t0;
    const poolMs = performance.now() - t1;
    // The pool really ran (a silent fallback to serial would also pass the diff).
    expect(serialStats.workers).toBe(0);
    expect(poolStats.workers).toBe(3);
    expect(poolStats.pooled).toBeGreaterThan(0);
    expect(poolStats.inProcess).toBe(0);
    expect(poolStats.crashes).toBe(0);
    expect(serialTrace.some((l) => l.startsWith("ingest: [trace] parse ← "))).toBe(true);
    expect(poolTrace).toEqual(serialTrace);
    expect(p.res.parseErrors).toBe(s.res.parseErrors);
    expect(p.res.membersProcessed).toBe(s.res.membersProcessed);
    const a = [...dumpLines(serialDb)];
    const b = [...dumpLines(poolDb)];
    expect(a.length).toBeGreaterThan(40);
    expect(b).toEqual(a);
    expect(p.fts).toEqual(s.fts);
    console.log(
      `parse-pool liveIngest fixture: serial ${serialMs.toFixed(0)} ms, pool ${poolMs.toFixed(0)} ms`,
    );
  }, 60_000);
});
