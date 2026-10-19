import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setListOrgsDeps } from "../list_orgs.js";
import { callTool } from "./_runner.js";

let workDir: string;
let prevFallback: string | undefined;
let prevTimeout: string | undefined;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-list-orgs-"));
  prevFallback = process.env.SFGRAPH_ALIAS_SF_FALLBACK;
  prevTimeout = process.env.SFGRAPH_ALIAS_RESOLVE_TIMEOUT_MS;
  // The sf-CLI auth read is opt-in (audit I1); these cases exercise it.
  process.env.SFGRAPH_ALIAS_SF_FALLBACK = "1";
});

afterEach(() => {
  __setListOrgsDeps(null);
  rmSync(workDir, { recursive: true, force: true });
  // biome-ignore lint/performance/noDelete: assigning undefined to process.env coerces to the string "undefined"
  if (prevFallback === undefined) delete process.env.SFGRAPH_ALIAS_SF_FALLBACK;
  else process.env.SFGRAPH_ALIAS_SF_FALLBACK = prevFallback;
  // biome-ignore lint/performance/noDelete: assigning undefined to process.env coerces to the string "undefined"
  if (prevTimeout === undefined) delete process.env.SFGRAPH_ALIAS_RESOLVE_TIMEOUT_MS;
  else process.env.SFGRAPH_ALIAS_RESOLVE_TIMEOUT_MS = prevTimeout;
});

describe("list_orgs default: no sf CLI / keychain access (audit review I1)", () => {
  it("never loads @salesforce/core or calls AuthInfo without the opt-in", async () => {
    // biome-ignore lint/performance/noDelete: see afterEach
    delete process.env.SFGRAPH_ALIAS_SF_FALLBACK;
    const listAll = vi.fn(async () => []);
    const loadSfCore = vi.fn(async () => ({ AuthInfo: { listAllAuthorizations: listAll } }));
    const resolveDefaultOrgAlias = vi.fn(async () => null);
    writeFileSync(
      path.join(workDir, "orgs-snapshot.json"),
      JSON.stringify({
        defaultAlias: "snap",
        aliases: { snap: "u@snap.com" },
        authorizations: {
          "u@snap.com": { orgId: "00Dsnap0000000000", instanceUrl: "https://snap.example" },
        },
        recordedAt: Date.now(),
      }),
    );
    __setListOrgsDeps({ loadSfCore, resolveDefaultOrgAlias, dataDir: workDir, openDb: () => null });
    const r = await callTool("list_orgs", {});
    expect(loadSfCore).not.toHaveBeenCalled();
    expect(listAll).not.toHaveBeenCalled();
    expect(resolveDefaultOrgAlias).not.toHaveBeenCalled();
    const d = r.data as { orgs: Array<{ alias: string | null; isDefault: boolean }> };
    expect(d.orgs).toEqual([expect.objectContaining({ alias: "snap", isDefault: true })]);
    expect(r.summary).toMatch(/sf CLI not consulted/);
  });

  it("bounds the opt-in sf CLI read with the alias-resolve timeout", async () => {
    process.env.SFGRAPH_ALIAS_RESOLVE_TIMEOUT_MS = "50";
    __setListOrgsDeps({
      loadSfCore: async () => ({
        AuthInfo: { listAllAuthorizations: () => new Promise<never>(() => {}) },
      }),
      resolveDefaultOrgAlias: () => new Promise<never>(() => {}),
      dataDir: workDir,
      openDb: () => null,
    });
    const t0 = Date.now();
    const r = await callTool("list_orgs", {});
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.summary).toMatch(/timed out after 50 ms/);
  });
});

describe("list_orgs", () => {
  it("returns empty list gracefully when @salesforce/core can't be loaded", async () => {
    __setListOrgsDeps({
      loadSfCore: async () => {
        throw new Error("module not found");
      },
      resolveDefaultOrgAlias: async () => null,
      dataDir: workDir,
      openDb: () => null,
    });
    const r = await callTool("list_orgs", {});
    const d = r.data as { orgs: unknown[]; defaultAlias: string | null };
    expect(d.orgs).toEqual([]);
    expect(d.defaultAlias).toBe(null);
    // sf CLI lookup failed but the local data dir was also empty —
    // summary explains both.
    expect(r.summary).toMatch(/sf-cli auth unavailable|local sfgraph data dir/);
  });

  it("marks isDefault correctly for the alias matching the default", async () => {
    __setListOrgsDeps({
      loadSfCore: async () => ({
        AuthInfo: {
          listAllAuthorizations: async () => [
            {
              alias: "prod",
              username: "user@prod.com",
              orgId: "00Dprod00000000000",
              instanceUrl: "https://prod.my.salesforce.com",
            },
            {
              alias: "sandbox",
              username: "user@sandbox.com",
              orgId: "00Dsbx00000000000",
              instanceUrl: "https://sandbox.my.salesforce.com",
            },
          ],
        },
      }),
      resolveDefaultOrgAlias: async () => "prod",
      dataDir: workDir,
      openDb: () => null,
    });
    const r = await callTool("list_orgs", {});
    const d = r.data as {
      orgs: Array<{ alias: string | null; isDefault: boolean; ingested: boolean }>;
      defaultAlias: string | null;
    };
    expect(d.defaultAlias).toBe("prod");
    const prod = d.orgs.find((o) => o.alias === "prod");
    const sbx = d.orgs.find((o) => o.alias === "sandbox");
    expect(prod?.isDefault).toBe(true);
    expect(sbx?.isDefault).toBe(false);
    expect(prod?.ingested).toBe(false);
  });

  it("computes stale=true when ageDays >= 7", async () => {
    const oldSync = Date.now() - 1000 * 60 * 60 * 24 * 10;
    const recentSync = Date.now() - 1000 * 60 * 60 * 24 * 2;
    __setListOrgsDeps({
      loadSfCore: async () => ({
        AuthInfo: {
          listAllAuthorizations: async () => [
            {
              alias: "old",
              username: "u@old",
              orgId: "00Dold0000000000",
              instanceUrl: "https://old",
            },
            {
              alias: "fresh",
              username: "u@fresh",
              orgId: "00Dfresh000000000",
              instanceUrl: "https://fresh",
            },
          ],
        },
      }),
      resolveDefaultOrgAlias: async () => null,
      dataDir: workDir,
      openDb: (p: string) => {
        const id = path.basename(p, ".sqlite");
        const ts = id === "00Dold0000000000" ? oldSync : recentSync;
        return {
          prepare: () => ({
            get: () => ({ last_synced_at: ts }),
          }),
          close: () => {},
        };
      },
    });
    const r = await callTool("list_orgs", {});
    const d = r.data as {
      orgs: Array<{ alias: string | null; stale: boolean; ageDays: number | null }>;
    };
    const old = d.orgs.find((o) => o.alias === "old");
    const fresh = d.orgs.find((o) => o.alias === "fresh");
    expect(old?.stale).toBe(true);
    expect((old?.ageDays ?? 0) >= 7).toBe(true);
    expect(fresh?.stale).toBe(false);
  });

  it("fills in missing alias from StateAggregator username->alias map", async () => {
    // The real-world reason this test exists: AuthInfo.listAllAuthorizations()
    // returns alias=null even when `sf org list` shows the alias bound. We
    // resolve the gap by cross-referencing StateAggregator.aliases.getAll().
    __setListOrgsDeps({
      loadSfCore: async () => ({
        AuthInfo: {
          listAllAuthorizations: async () => [
            {
              alias: null, // <-- the bug: AuthInfo returns null here
              username: "user@example.com",
              orgId: "00Dxx0000000XYZEAA",
              instanceUrl: "https://x.my.salesforce.com",
            },
          ],
        },
        aliasByUsername: new Map([["user@example.com", "my-prod"]]),
      }),
      resolveDefaultOrgAlias: async () => "my-prod",
      dataDir: workDir,
      openDb: () => null,
    });
    const r = await callTool("list_orgs", {});
    const d = r.data as {
      orgs: Array<{ alias: string | null; isDefault: boolean; username: string }>;
    };
    expect(d.orgs[0]?.alias).toBe("my-prod");
    expect(d.orgs[0]?.isDefault).toBe(true);
  });
});
