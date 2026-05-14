import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setListOrgsDeps } from "../list_orgs.js";
import { callTool } from "./_runner.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-list-orgs-"));
});

afterEach(() => {
  __setListOrgsDeps(null);
  rmSync(workDir, { recursive: true, force: true });
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
});
