import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedIngestedOrgDb } from "./_seed-org-db.js";

/**
 * One alias names one graph (two files holding it are refused, naming both), and the
 * alias-to-org binding is checked against the local mapping on every call, so an alias moved to
 * another org during a long-lived server answers for the org it names now.
 */

const ORG_A = "00DAA0000000001AAA";
const ORG_B = "00DBB0000000002AAA";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-alias-binding-"));
  vi.doMock("@ryanstark24/sfgraph-shared", async () => {
    const actual = await vi.importActual<typeof import("@ryanstark24/sfgraph-shared")>(
      "@ryanstark24/sfgraph-shared",
    );
    return {
      ...actual,
      getSfgraphPaths: () => ({
        data: workDir,
        cache: workDir,
        log: workDir,
        config: workDir,
        temp: workDir,
      }),
    };
  });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

async function realignAlias(orgId: string, alias: string): Promise<void> {
  const { SqliteGraphStore } = await import("@ryanstark24/sfgraph-core");
  const { asOrgId } = await import("@ryanstark24/sfgraph-shared");
  const g = new SqliteGraphStore({
    dbPath: path.join(workDir, `${orgId}.sqlite`),
    backupDir: path.join(workDir, "bkp"),
  });
  await g.init();
  g.upsertOrg({
    id: asOrgId(orgId),
    alias,
    instanceUrl: "https://example.my.salesforce.com",
    apiVersion: "62.0",
    createdAt: Date.now(),
  });
  await g.close();
}

describe("alias on two graph files", () => {
  it("is refused with both files named, whichever the directory lists first", async () => {
    await seedIngestedOrgDb(workDir, ORG_A, "uat");
    await seedIngestedOrgDb(workDir, ORG_B, "uat");
    const { getToolContext, setToolContextFactory } = await import("../context.js");
    setToolContextFactory(null);
    const err = await getToolContext({ orgId: "uat" }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/ambiguous org alias 'uat'/);
    expect(err?.message).toContain(`${ORG_A}.sqlite`);
    expect(err?.message).toContain(`${ORG_B}.sqlite`);
  });

  it("still answers by orgId when the alias is ambiguous", async () => {
    await seedIngestedOrgDb(workDir, ORG_A, "uat");
    await seedIngestedOrgDb(workDir, ORG_B, "uat");
    const { getToolContext, closeAllContexts, setToolContextFactory } = await import(
      "../context.js"
    );
    setToolContextFactory(null);
    const ctx = await getToolContext({ orgId: ORG_B });
    expect(String(ctx.orgId)).toBe(ORG_B);
    await closeAllContexts();
  });
});

describe("aliases that differ only in case", () => {
  it("reports ambiguity for an exact-case lookup too, naming both orgs", async () => {
    await seedIngestedOrgDb(workDir, ORG_A, "UAT");
    await seedIngestedOrgDb(workDir, ORG_B, "uat");
    const { getToolContext, setToolContextFactory } = await import("../context.js");
    setToolContextFactory(null);
    for (const asked of ["uat", "UAT", "Uat"]) {
      const err = await getToolContext({ orgId: asked }).then(
        () => null,
        (e: Error) => e,
      );
      expect(err?.message).toMatch(/ambiguous org alias/);
      expect(err?.message).toContain(ORG_A);
      expect(err?.message).toContain(ORG_B);
    }
  });

  it("still resolves a single holder by exact or other-case alias, and by orgId", async () => {
    await seedIngestedOrgDb(workDir, ORG_A, "UAT");
    const { getToolContext, closeAllContexts, setToolContextFactory } = await import(
      "../context.js"
    );
    setToolContextFactory(null);
    expect(String((await getToolContext({ orgId: "UAT" })).orgId)).toBe(ORG_A);
    expect(String((await getToolContext({ orgId: "uat" })).orgId)).toBe(ORG_A);
    await closeAllContexts();
  });
});

describe("alias binding is not cached for the server's lifetime", () => {
  it("answers for the org the alias names now, after it is moved", async () => {
    await seedIngestedOrgDb(workDir, ORG_A, "uat");
    const { getToolContext, closeAllContexts, setToolContextFactory } = await import(
      "../context.js"
    );
    setToolContextFactory(null);
    const first = await getToolContext({ orgId: "uat" });
    expect(String(first.orgId)).toBe(ORG_A);

    // The alias moves: org A gives it up, org B takes it. Same server process.
    await realignAlias(ORG_A, "uat-old");
    await seedIngestedOrgDb(workDir, ORG_B, "uat");

    const second = await getToolContext({ orgId: "uat" });
    expect(String(second.orgId)).toBe(ORG_B);
    // Org A's store is untouched and still reachable by its id.
    const byId = await getToolContext({ orgId: ORG_A });
    expect(String(byId.orgId)).toBe(ORG_A);
    await closeAllContexts();
  });

  it("refuses a bound alias that has since become ambiguous", async () => {
    await seedIngestedOrgDb(workDir, ORG_A, "uat");
    const { getToolContext, closeAllContexts, setToolContextFactory } = await import(
      "../context.js"
    );
    setToolContextFactory(null);
    await getToolContext({ orgId: "uat" });
    await seedIngestedOrgDb(workDir, ORG_B, "uat");
    await expect(getToolContext({ orgId: "uat" })).rejects.toThrow(/ambiguous org alias/);
    await closeAllContexts();
  });

  it("keeps answering from the cache while the mapping is unchanged", async () => {
    await seedIngestedOrgDb(workDir, ORG_A, "uat");
    const { getToolContext, closeAllContexts, setToolContextFactory } = await import(
      "../context.js"
    );
    setToolContextFactory(null);
    const a = await getToolContext({ orgId: "uat" });
    const b = await getToolContext({ orgId: "uat" });
    expect(b).toBe(a);
    await closeAllContexts();
  });
});

describe.skipIf(process.platform === "win32")("alias call during a rebuild", () => {
  const moveAside = (db: string): void => {
    for (const s of ["", "-wal", "-shm"]) {
      try {
        renameSync(db + s, `${db}.bak${s}`);
      } catch {
        /* absent */
      }
    }
  };

  it("is still served from the old graph while the file is moved aside", async () => {
    await seedIngestedOrgDb(workDir, ORG_A, "uat");
    const { getToolContext, closeAllContexts, setToolContextFactory } = await import(
      "../context.js"
    );
    setToolContextFactory(null);
    const first = await getToolContext({ orgId: "uat" });
    // `ingest --rebuild`: the old file is renamed away, the new one does not exist yet.
    moveAside(path.join(workDir, `${ORG_A}.sqlite`));
    const mid = await getToolContext({ orgId: "uat" });
    expect(String(mid.orgId)).toBe(ORG_A);
    expect(mid).toBe(first);
    await closeAllContexts();
  });

  it("drops the binding once the finished replacement maps the alias elsewhere", async () => {
    await seedIngestedOrgDb(workDir, ORG_A, "uat");
    const { getToolContext, closeAllContexts, setToolContextFactory } = await import(
      "../context.js"
    );
    setToolContextFactory(null);
    await getToolContext({ orgId: "uat" });
    moveAside(path.join(workDir, `${ORG_A}.sqlite`));
    // The rebuild finished: A's new file carries another alias, and B now holds "uat".
    await seedIngestedOrgDb(workDir, ORG_A, "uat-old");
    {
      const { SqliteGraphStore } = await import("@ryanstark24/sfgraph-core");
      const g = new SqliteGraphStore({
        dbPath: path.join(workDir, `${ORG_A}.sqlite`),
        backupDir: path.join(workDir, "bkp"),
      });
      await g.init();
      (g as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db
        .prepare("UPDATE _sfgraph_orgs SET last_synced_at = ?")
        .run(Date.now());
      await g.close();
    }
    await seedIngestedOrgDb(workDir, ORG_B, "uat");
    const after = await getToolContext({ orgId: "uat" });
    expect(String(after.orgId)).toBe(ORG_B);
    await closeAllContexts();
  });
});

/**
 * Release the SQLite handles of a cached context (the cache entry and the alias binding stay).
 * Windows cannot rename or delete a file another handle holds open, so the file moves a rebuild
 * makes are simulated only once the handles are closed (the real rebuild runs in another process
 * that waits for the file to be free).
 */
async function releaseHandles(ctx: {
  graphStore: { close(): Promise<void> };
  snapshotStore?: { close(): Promise<void> } | null;
  vectorStore?: { close(): Promise<void> } | null;
}): Promise<void> {
  for (const st of [ctx.vectorStore, ctx.snapshotStore, ctx.graphStore]) {
    try {
      await st?.close();
    } catch {
      /* already closed */
    }
  }
}

describe("alias on two graph files while one cannot be read", () => {
  it("refuses the alias instead of resolving to the other org (0-byte holder)", async () => {
    await seedIngestedOrgDb(workDir, ORG_B, "uat");
    writeFileSync(path.join(workDir, `${ORG_A}.sqlite`), "");
    const { getToolContext, closeAllContexts, setToolContextFactory } = await import(
      "../context.js"
    );
    setToolContextFactory(null);
    const err = await getToolContext({ orgId: "uat" }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/rebuilt or is unreadable/);
    expect(err?.message).toContain(`${ORG_A}.sqlite`);
    // By orgId the readable org still answers.
    const byId = await getToolContext({ orgId: ORG_B });
    expect(String(byId.orgId)).toBe(ORG_B);
    await closeAllContexts();
  });

  it("refuses a bound alias when its graph is mid-rebuild and another org now claims it", async () => {
    await seedIngestedOrgDb(workDir, ORG_A, "uat");
    await seedIngestedOrgDb(workDir, ORG_B, "uat2");
    const { getToolContext, closeAllContexts, setToolContextFactory } = await import(
      "../context.js"
    );
    setToolContextFactory(null);
    const bound = await getToolContext({ orgId: "uat" });
    await releaseHandles(bound as never);
    for (const sfx of ["", "-wal", "-shm"]) {
      try {
        renameSync(path.join(workDir, `${ORG_A}.sqlite${sfx}`), path.join(workDir, `a.bak${sfx}`));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    await realignAlias(ORG_B, "uat");
    await expect(getToolContext({ orgId: "uat" })).rejects.toThrow(
      /rebuilt or is unreadable|being rebuilt/,
    );
    await closeAllContexts();
  });
});
