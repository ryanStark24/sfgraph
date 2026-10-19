import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * End-to-end `sfgraph ingest` against a mocked org, through the real
 * liveIngest (core dist) — only `resolveOrg` and the data dir are stubbed.
 *
 * 1. Exit hang (2026-10-09): the run printed its last line, then sat ~3.8 min
 *    before exiting because failSoft left a ref'd watchdog timer armed for
 *    every source that skipped by throwing. The run, INCLUDING the auto-retry
 *    pass (> 10 transient skips), must leave no live timers behind.
 * 2. `unreadable` only means "not auto-retried within this run": the
 *    auto-retry pass leaves it out, but it stays in the persisted skip
 *    report, and an explicit --retry-skipped re-runs it.
 */

const ORG_ID = "00Dxx0000E2ERTYAAA";
const LEAKY = Array.from({ length: 12 }, (_, i) => `Leaky${i}Type`);
const UNREAD = "UnreadType";
const UNREAD_MEMBERS = Array.from({ length: 100 }, (_, i) => `U${i}`);

let dataDir: string;
let unreadRequested: Set<string>;
let calls: { list: Map<string, number>; read: Map<string, number> };
const saved: Record<string, string | undefined> = {};
const ENV = {
  SFGRAPH_EMBED_MODEL_PATH: "/nonexistent/sfgraph-e2e-model",
  SFGRAPH_NO_AUTO_RETRY: undefined,
  SFGRAPH_AUTO_RETRY_THRESHOLD: undefined,
  SFGRAPH_SKIP_THRESHOLD: undefined,
};

const timers = (): number => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

function sfFault(code: string, message: string): Error {
  const e = new Error(message) as Error & { errorCode: string };
  e.name = `sf:${code}`;
  e.errorCode = `sf:${code}`;
  return e;
}

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

/** A jsforce-like connection: every LEAKY type's listing fails transiently;
 *  UNREAD lists 100 members whose reads the org rejects deterministically
 *  (one identical message), so a normal run stops reading it early. */
function mockConn(): object {
  const empty = async () => ({ records: [], done: true, totalSize: 0 });
  return {
    instanceUrl: "https://e2e.my.salesforce.com",
    version: "60.0",
    userInfo: { organizationId: ORG_ID },
    query: empty,
    queryMore: empty,
    request: async () => ({}),
    describeGlobal: async () => ({ sobjects: [] }),
    sobject: (name: string) => ({
      describe: async () => {
        throw new Error(`no such sobject ${name}`);
      },
    }),
    tooling: {
      query: empty,
      queryMore: empty,
      sobject: (name: string) => ({
        describe: async () => {
          throw new Error(`no such tooling sobject ${name}`);
        },
      }),
    },
    metadata: {
      describe: async () => ({
        metadataObjects: [...LEAKY, UNREAD].map((xmlName) => ({ xmlName, childXmlNames: [] })),
      }),
      list: async (req: { type: string } | Array<{ type: string }>) => {
        const type = (Array.isArray(req) ? req[0] : req)?.type ?? "";
        bump(calls.list, type);
        if (type === UNREAD) return UNREAD_MEMBERS.map((fullName) => ({ fullName }));
        if (LEAKY.includes(type)) throw new Error("socket hang up (ECONNRESET)");
        return [];
      },
      read: async (type: string, names: string[]) => {
        bump(calls.read, type);
        if (type === UNREAD) for (const n of names) unreadRequested.add(n);
        if (type === UNREAD) {
          throw sfFault(
            "INVALID_CROSS_REFERENCE_KEY",
            "INVALID_CROSS_REFERENCE_KEY: invalid cross reference id",
          );
        }
        return names.map((fullName) => ({ fullName }));
      },
    },
  };
}

async function loadIngest(): Promise<typeof import("../commands/ingest.js")> {
  vi.doMock("@ryanstark24/sfgraph-core", async () => {
    const actual = await vi.importActual<typeof import("@ryanstark24/sfgraph-core")>(
      "@ryanstark24/sfgraph-core",
    );
    // Keep the shared pools' reservoirs from throttling the mocked calls.
    await actual.metadataPool.incrementReservoir(10_000);
    await actual.limiter.incrementReservoir(10_000);
    return {
      ...actual,
      resolveOrg: async (alias: string) => ({
        orgId: ORG_ID,
        alias,
        username: "e2e@example.com",
        instanceUrl: "https://e2e.my.salesforce.com",
        apiVersion: "60.0",
        conn: actual.wrapConnectionReadOnly(mockConn()),
      }),
    };
  });
  vi.doMock("@ryanstark24/sfgraph-shared", async () => {
    const actual = await vi.importActual<typeof import("@ryanstark24/sfgraph-shared")>(
      "@ryanstark24/sfgraph-shared",
    );
    return {
      ...actual,
      getSfgraphPaths: () => ({ data: dataDir, cache: dataDir, config: dataDir }),
    };
  });
  return await import("../commands/ingest.js");
}

type Skip = { label: string; category: string; reason: string };
const report = (): Skip[] =>
  (JSON.parse(readFileSync(join(dataDir, `${ORG_ID}.skips.json`), "utf8")) as { skips: Skip[] })
    .skips;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "sfg-e2e-retry-"));
  calls = { list: new Map(), read: new Map() };
  unreadRequested = new Set();
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  process.exitCode = 0;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("sfgraph ingest end-to-end (mocked org)", () => {
  it("auto-retries the transient skips, keeps the unreadable entry, and leaves no live timers", async () => {
    const { ingestCmd } = await loadIngest();
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => {
      out.push(String(m));
    });
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m: unknown) => {
      errs.push(String(m));
    });
    const before = timers();

    await ingestCmd({ org: "e2e" });

    // The auto-retry pass ran (12 transient skips > threshold 10) …
    expect(out.some((l) => l.includes("ingest: auto-retry — 12 transient skips"))).toBe(true);
    // … re-listing the transient types (pass 1 + auto-retry) but NOT the
    // unreadable one (listed once, in pass 1 only).
    const pass1Lists = calls.list.get(LEAKY[0] ?? "") ?? 0;
    expect(pass1Lists).toBeGreaterThan(0);
    for (const t of LEAKY) expect(calls.list.get(t)).toBe(pass1Lists);
    expect(calls.list.get(UNREAD)).toBe(1);
    expect(calls.read.get(UNREAD) ?? 0).toBeGreaterThan(0);
    expect(out.some((l) => l.includes("--only filter active (12 sources)"))).toBe(true);

    // The persisted report still names the unreadable type after the
    // scoped auto-retry pass rewrote it (review I2).
    const skips = report();
    const unreadEntry = skips.find((s) => s.label === `generic:${UNREAD}`);
    expect(unreadEntry?.category).toBe("unreadable");
    // A normal run stops reading the refused type early …
    expect(unreadRequested.size).toBeLessThan(UNREAD_MEMBERS.length);
    expect(unreadEntry?.reason).toMatch(/more member\(s\) not read/);
    expect(skips.filter((s) => s.label.startsWith("generic:Leaky"))).toHaveLength(LEAKY.length);
    // 12 transient skips remain >= the exit threshold of 5.
    expect(process.exitCode).toBe(1);

    // Exit hang: nothing left holding the event loop open.
    expect(timers()).toBeLessThanOrEqual(before);
  }, 120_000);

  it("--retry-skipped re-runs unreadable labels too and keeps them in the report", async () => {
    const { ingestCmd } = await loadIngest();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => {
      out.push(String(m));
    });
    process.env.SFGRAPH_NO_AUTO_RETRY = "1";
    await ingestCmd({ org: "e2e" });
    expect(existsSync(join(dataDir, `${ORG_ID}.skips.json`))).toBe(true);
    const readsAfterFirst = calls.read.get(UNREAD) ?? 0;
    unreadRequested.clear();
    expect(readsAfterFirst).toBeGreaterThan(0);

    const before = timers();
    await ingestCmd({ org: "e2e", retrySkipped: true });

    expect(
      out.some((l) =>
        l.includes(`--retry-skipped: retrying ${LEAKY.length + 1} previously-skipped sources`),
      ),
    ).toBe(true);
    // The unreadable type was read again on the explicit retry …
    expect(calls.read.get(UNREAD) ?? 0).toBeGreaterThan(readsAfterFirst);
    // … in full: an explicit --retry-skipped has no early stop (N1c).
    expect(unreadRequested.size).toBe(UNREAD_MEMBERS.length);
    // … and, refused again, is still recorded as unreadable.
    const skips = report();
    expect(skips.find((s) => s.label === `generic:${UNREAD}`)?.category).toBe("unreadable");
    expect(timers()).toBeLessThanOrEqual(before);
  }, 120_000);
});
