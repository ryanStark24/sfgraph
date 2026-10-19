import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ConsoleLogger } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilesystemMetadataSource } from "../../extractors/filesystem/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { runDeltaIngest } from "../delta.js";
import { liveIngest } from "../live-ingest.js";
import { offlineResolvedOrg } from "../offline-org.js";

/**
 * T15 ingest I-2: a resolver (or the analysis populate) that throws during a
 * delta must not finalize the delta as a clean sync. The run fails, the
 * `_sfgraph_delta_pending` marker stays set, and the next delta replays the
 * touched members at full scope and lands on the rebuild's graph.
 */

const fail = vi.hoisted(() => ({ arity: false, populate: false }));
vi.mock("../../parsers/apex/arity-resolver.js", async (orig) => {
  const m = (await orig()) as typeof import("../../parsers/apex/arity-resolver.js");
  return {
    ...m,
    resolveApexMethodArity: (...a: Parameters<typeof m.resolveApexMethodArity>) => {
      if (fail.arity) throw new Error("injected arity failure");
      return m.resolveApexMethodArity(...a);
    },
  };
});
vi.mock("../../analyze/populate.js", async (orig) => {
  const m = (await orig()) as typeof import("../../analyze/populate.js");
  return {
    ...m,
    populateAnalysisTables: async (...a: Parameters<typeof m.populateAnalysisTables>) => {
      if (fail.populate) throw new Error("injected populate failure");
      return m.populateAnalysisTables(...a);
    },
  };
});

const GRAPH_DUMP = pathToFileURL(
  path.resolve(__dirname, "../../../../../bench/lib/graph-dump.mjs"),
).href;
const FIXTURE = path.resolve(__dirname, "fixtures/delta-project");
const MD = "force-app/main/default";
const logger = new ConsoleLogger("error");

let dir: string;
let proj: string;
let dumpEntries: (p: string) => Iterable<{ disp: string; payload: string }>;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-delta-fail-"));
  proj = path.join(dir, "proj");
  cpSync(FIXTURE, proj, { recursive: true });
  ({ dumpEntries } = (await import(GRAPH_DUMP)) as { dumpEntries: typeof dumpEntries });
  vi.spyOn(console, "log").mockImplementation(() => {});
  fail.arity = false;
  fail.populate = false;
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

interface Ctx {
  store: SqliteGraphStore;
  dbPath: string;
}

async function open(dbPath: string): Promise<SqliteGraphStore> {
  const s = new SqliteGraphStore({ dbPath, backupDir: path.join(dir, "bk") });
  await s.init();
  return s;
}
async function fullIngest(store: SqliteGraphStore): Promise<void> {
  await liveIngest({
    alias: "fixture",
    graphStore: store,
    mode: "full",
    rebuild: true,
    preResolved: offlineResolvedOrg(proj, "fixture"),
    metadataSource: FilesystemMetadataSource.fromProjectRoot(proj),
    logger,
    skipSnapshot: true,
    analysisDb: store.db,
  });
}
async function rebuildInto(name: string): Promise<Ctx> {
  const dbPath = path.join(dir, `${name}.sqlite`);
  const store = await open(dbPath);
  await fullIngest(store);
  return { store, dbPath };
}
function delta(ctx: Ctx) {
  return runDeltaIngest({
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
async function expectSameAsRebuild(ctx: Ctx): Promise<void> {
  await ctx.store.close();
  const ref = await rebuildInto("ref");
  await ref.store.close();
  const lines = (p: string) => [...dumpEntries(p)].map((e) => `${e.disp}\t${e.payload}`);
  const a = lines(ctx.dbPath);
  expect(a.length).toBeGreaterThan(50);
  expect(a).toEqual(lines(ref.dbPath));
}
const orgId = () => offlineResolvedOrg(proj, "fixture").orgId;

function edit(): void {
  mkdirSync(path.join(proj, MD, "classes"), { recursive: true });
  writeFileSync(
    path.join(proj, `${MD}/classes/NewSvc.cls`),
    "public class NewSvc { public static void go() { Integer n = OrderHelper.count(); Util.log('x'); } }",
  );
}

describe("T15 I-2: a post-merge failure during a delta is never a clean sync", () => {
  for (const step of ["arity", "populate"] as const) {
    it(`${step} throws: the delta fails, the pending marker stays, the next delta converges`, async () => {
      const ctx = await rebuildInto("delta");
      const genBefore = ctx.store.getSyncStatus(orgId()).generation;
      edit();
      fail[step] = true;
      await expect(delta(ctx)).rejects.toThrow(/post-merge|failed/);
      expect(ctx.store.getDeltaPending(orgId())).not.toBeNull();
      // Not a clean sync: no new generation, and no sync left flagged in progress.
      expect(ctx.store.getSyncStatus(orgId())).toMatchObject({
        generation: genBefore,
        in_progress: false,
      });
      fail[step] = false;
      const r = await delta(ctx);
      expect(r).toMatchObject({ kind: "delta", added: 1 });
      expect(ctx.store.getDeltaPending(orgId())).toBeNull();
      await expectSameAsRebuild(ctx);
    });
  }
});
