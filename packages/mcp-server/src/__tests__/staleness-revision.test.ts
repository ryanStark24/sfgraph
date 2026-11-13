import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FilesystemMetadataSource,
  SqliteGraphStore,
  SqliteSnapshotStore,
  liveIngest,
  offlineResolvedOrg,
  runDeltaIngest,
} from "@ryanstark24/sfgraph-core";
import { ConsoleLogger, type OrgId } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ToolContext, closeAllContexts, setToolContextFactory } from "../context.js";
import { SfgraphMcpServer } from "../server.js";

// S-1.8.1-008 / C-1.8.1-022: staleness_check reports the stored source commit,
// including after a no-op delta (only a README changed) moved it.
const logger = new ConsoleLogger("error");
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
let dir: string;
let proj: string;
let store: SqliteGraphStore;

const rev = (gitCommit: string) => ({
  gitBranch: "main",
  gitCommit,
  capturedAt: "2026-11-13T00:00:00.000Z",
});

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-stale-rev-"));
  proj = path.join(dir, "proj");
  mkdirSync(path.join(proj, "force-app/main/default/classes"), { recursive: true });
  writeFileSync(
    path.join(proj, "sfdx-project.json"),
    JSON.stringify({ packageDirectories: [{ path: "force-app" }] }),
  );
  const cls = path.join(proj, "force-app/main/default/classes/WidgetService.cls");
  writeFileSync(cls, "public class WidgetService { public void run() {} }");
  writeFileSync(
    `${cls}-meta.xml`,
    `<?xml version="1.0" encoding="UTF-8"?><ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>60.0</apiVersion><status>Active</status></ApexClass>`,
  );
  const dbPath = path.join(dir, "g.sqlite");
  store = new SqliteGraphStore({ dbPath, backupDir: path.join(dir, "bk") });
  await store.init();
  const snapshotStore = new SqliteSnapshotStore({
    dbPath,
    db: (store as unknown as { db: never }).db,
    skipMigrations: true,
  });
  await snapshotStore.init();
  const orgId = offlineResolvedOrg(proj, "fixture").orgId;
  setToolContextFactory(async () => {
    const ctx: ToolContext = { graphStore: store, snapshotStore, orgId: orgId as OrgId };
    return ctx;
  });
});

afterEach(async () => {
  await closeAllContexts();
  setToolContextFactory(null);
  await store.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

async function staleness() {
  const server = new SfgraphMcpServer();
  await server.loadAllTools();
  const res = await server.dispatch("staleness_check", { org: "fixture" });
  expect(res.isError).toBeUndefined();
  const text = res.content.map((c) => c.text).join("\n");
  const out = (await server.registry.get("staleness_check")?.handler({ org: "fixture" })) as
    | { data?: Record<string, unknown> }
    | undefined;
  return { text, data: out?.data };
}

describe("staleness_check source revision", () => {
  it("shows the new commit after a no-op delta that only changed a README", async () => {
    await liveIngest({
      alias: "fixture",
      graphStore: store,
      mode: "full",
      rebuild: true,
      preResolved: offlineResolvedOrg(proj, "fixture"),
      metadataSource: FilesystemMetadataSource.fromProjectRoot(proj),
      sourceRevision: rev(COMMIT_A),
      logger,
      skipSnapshot: true,
      analysisDb: store.db,
    });
    const before = await staleness();
    expect(before.text).toContain(COMMIT_A);
    expect(before.data?.sourceRevision).toMatchObject({ gitCommit: COMMIT_A, gitBranch: "main" });

    writeFileSync(path.join(proj, "README.md"), "# Example project\n\nA docs-only change.\n");
    const r = await runDeltaIngest({
      alias: "fixture",
      graphStore: store,
      preResolved: offlineResolvedOrg(proj, "fixture"),
      metadataSource: FilesystemMetadataSource.fromProjectRoot(proj),
      sourceRevision: rev(COMMIT_B),
      logger,
      skipSnapshot: true,
      analysisDb: store.db,
      lockDir: dir,
      report: () => {},
      fullRebuild: async () => {
        throw new Error("a README change must not force a rebuild");
      },
    });
    expect(r).toMatchObject({ kind: "delta", added: 0, changed: 0, deleted: 0 });

    const after = await staleness();
    expect(after.text).toContain(COMMIT_B);
    expect(after.text).not.toContain(COMMIT_A);
    expect(after.text.split("\n").filter((l) => l.startsWith("Source revision:"))).toHaveLength(1);
    expect(after.data?.sourceRevision).toMatchObject({ gitCommit: COMMIT_B, gitBranch: "main" });
  });

  it("reports sourceRevision null and no revision line when none is stored", async () => {
    const { text, data } = await staleness();
    expect(data?.sourceRevision).toBeNull();
    expect(text).not.toContain("Source revision:");
  });
});
