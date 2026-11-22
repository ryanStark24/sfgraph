import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteGraphStore } from "@ryanstark24/sfgraph-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Custom setting row values through `sfgraph ingest`: not stored by default, stored with
 * `--store-setting-rows`, and removed by the next default ingest.
 */

const ORG_ID = "00Dxx0000E2ERTZAAA";
const SECRET = "s3cr3t-token-value-0042";
let dataDir: string;
let sourceMembers: Array<{ MemberType: string; MemberName: string }>;
const saved: Record<string, string | undefined> = {};
const ENV = {
  SFGRAPH_EMBED_MODEL_PATH: "/nonexistent/sfgraph-e2e-model",
  SFGRAPH_NO_AUTO_RETRY: "1",
};

function mockConn(): object {
  const empty = async (soql?: string) =>
    typeof soql === "string" && soql.includes("FROM Acme_Settings__c")
      ? { records: [{ Id: "a01x0000000001", Name: "Default", Api_Key__c: SECRET }], done: true }
      : { records: [], done: true, totalSize: 0 };
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
        if (/IsCustomSetting = true/.test(soql)) {
          return { records: [{ QualifiedApiName: "Acme_Settings__c" }], done: true };
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
  dataDir = mkdtempSync(join(tmpdir(), "sfg-e2e-setting-rows-"));
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

async function storedText(): Promise<string> {
  const store = new SqliteGraphStore({ dbPath: join(dataDir, `${ORG_ID}.sqlite`) });
  await store.init();
  const db = store.db;
  try {
    const rows = store
      .listNodesByLabel(ORG_ID as never, "CustomSetting")
      .map((n) => ({ t: JSON.stringify(n) }));
    const fts = db.prepare("SELECT body AS t FROM _sfgraph_node_fts").all() as Array<{ t: string }>;
    return [...rows, ...fts].map((r) => r.t).join("\n");
  } finally {
    await store.close();
  }
}

describe("sfgraph ingest and custom setting rows", () => {
  it("stores no row values by default, stores them with --store-setting-rows, and the next default ingest removes them", async () => {
    const { ingestCmd } = await loadIngest();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await ingestCmd({ org: "e2e", mode: "full" });
    expect(await storedText()).toContain("Acme_Settings__c");
    expect(await storedText()).not.toContain(SECRET);

    await ingestCmd({ org: "e2e", mode: "full", storeSettingRows: true });
    expect(await storedText()).toContain(SECRET);

    await ingestCmd({ org: "e2e", mode: "full" });
    expect(await storedText()).not.toContain(SECRET);
  }, 120_000);
});
