import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F03 / S-1.8.2-003 through `sfgraph ingest` (the entry point that uses `auto`).
 * First run: full sync. Second run (default mode auto) with SourceMember rows:
 * the CLI must run a full refresh, say so, and name unsupported types.
 */

const ORG_ID = "00Dxx0000E2ERTZAAA";
let dataDir: string;
let sourceMembers: Array<{ MemberType: string; MemberName: string }>;
const saved: Record<string, string | undefined> = {};
const ENV = {
  SFGRAPH_EMBED_MODEL_PATH: "/nonexistent/sfgraph-e2e-model",
  SFGRAPH_NO_AUTO_RETRY: "1",
};

function mockConn(): object {
  const empty = async () => ({ records: [], done: true, totalSize: 0 });
  return {
    instanceUrl: "https://e2e.example.invalid",
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
      query: async (soql: string) => {
        if (/FROM SourceMember/.test(soql)) {
          return {
            done: true,
            records: sourceMembers.map((r, i) => ({
              Id: `SM${i}`,
              RevisionCounter: i,
              IsNameObsolete: false,
              LastModifiedDate: new Date().toISOString(),
              ...r,
            })),
          };
        }
        return { records: [], done: true, totalSize: 0 };
      },
      queryMore: empty,
      sobject: (name: string) => ({
        describe: async () => {
          if (name === "SourceMember") return { name };
          throw new Error(`no such tooling sobject ${name}`);
        },
      }),
    },
    metadata: {
      describe: async () => ({ metadataObjects: [] }),
      list: async () => [],
      read: async (_t: string, names: string[]) => names.map((fullName) => ({ fullName })),
    },
  };
}

async function loadIngest(): Promise<typeof import("../commands/ingest.js")> {
  vi.doMock("@ryanstark24/sfgraph-core", async () => {
    const actual = await vi.importActual<typeof import("@ryanstark24/sfgraph-core")>(
      "@ryanstark24/sfgraph-core",
    );
    await actual.metadataPool.incrementReservoir(10_000);
    await actual.limiter.incrementReservoir(10_000);
    return {
      ...actual,
      resolveOrg: async (alias: string) => ({
        orgId: ORG_ID,
        alias,
        username: "e2e@example.invalid",
        instanceUrl: "https://e2e.example.invalid",
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

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "sfg-e2e-fallback-"));
  sourceMembers = [];
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
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

describe("sfgraph ingest, second sync in auto mode", () => {
  it("runs a full refresh when content changed and tells the user, naming unsupported types", async () => {
    const { ingestCmd } = await loadIngest();
    const logs: string[] = [];
    const warns: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => void logs.push(String(m)));
    vi.spyOn(console, "warn").mockImplementation((m: unknown) => void warns.push(String(m)));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await ingestCmd({ org: "e2e" });
    expect(warns.some((w) => w.includes("auto ran a full refresh"))).toBe(false);

    sourceMembers = [
      { MemberType: "ApexClass", MemberName: "Billing" },
      { MemberType: "Workflow", MemberName: "Account" },
    ];
    // sleep so the watermark from run 1 is strictly before run 2's rows
    await new Promise((r) => setTimeout(r, 20));
    await ingestCmd({ org: "e2e" });

    expect(
      warns.some((w) => w.includes("auto ran a full refresh") && w.includes("mode=full")),
    ).toBe(true);
    expect(warns.some((w) => w.includes("Workflow=1") && w.includes("--mode full"))).toBe(true);
  }, 120_000);
});
