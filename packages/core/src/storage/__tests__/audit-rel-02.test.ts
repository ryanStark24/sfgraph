import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { asOrgId } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteGraphStore } from "../sqlite/graph-store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../..");
const graphStoreTs = path.resolve(here, "../sqlite/graph-store.ts");

const ORG = asOrgId("00Dxx0000000REL2");
let workDir: string;
let dbPath: string;
beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-audit-rel02-"));
  dbPath = path.join(workDir, "g.sqlite");
});
afterEach(() => rmSync(workDir, { recursive: true, force: true }));

function org() {
  return {
    id: ORG,
    alias: "a",
    instanceUrl: "https://x.example",
    apiVersion: "60.0",
    createdAt: 1,
  };
}

/** A real ingest process: marks the sync started, then is SIGKILLed. */
async function killedIngest(): Promise<void> {
  const script = path.join(workDir, "child.mts");
  writeFileSync(
    script,
    `import { SqliteGraphStore } from ${JSON.stringify(pathToFileURL(graphStoreTs).href)};
const g = new SqliteGraphStore({ dbPath: ${JSON.stringify(dbPath)}, backupDir: ${JSON.stringify(path.join(workDir, "b"))} });
await g.init();
g.upsertOrg(${JSON.stringify(org())});
g.markSyncStarted(${JSON.stringify(ORG)}, new Date().toISOString());
process.stdout.write("ready\\n");
setInterval(() => {}, 60_000);
`,
  );
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (d) => {
    err += String(d);
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (d) => {
      if (String(d).includes("ready")) resolve();
    });
    child.on("exit", (code) => reject(new Error(`child exited early (${code}): ${err}`)));
  });
  child.removeAllListeners("exit");
  const exited = new Promise((r) => child.on("exit", r));
  child.kill("SIGKILL");
  await exited;
}

// audit rel-02: an ingest killed mid-run left sync_in_progress=1 forever, and
// readers kept reporting it as in progress.
describe("audit rel-02", () => {
  it("a reader does not report a killed ingest as still in progress", async () => {
    await killedIngest();
    const g = new SqliteGraphStore({ dbPath, backupDir: path.join(workDir, "b") });
    await g.init();
    const st = g.getSyncStatus(ORG);
    expect(st.in_progress).toBe(false);
    expect(st.started_at).toBeNull();
    await g.close();
  }, 30_000);

  it("a live ingest (this process) is still reported in progress", async () => {
    const g = new SqliteGraphStore({ dbPath, backupDir: path.join(workDir, "b") });
    await g.init();
    g.upsertOrg(org());
    g.markSyncStarted(ORG, new Date().toISOString());
    const reader = new SqliteGraphStore({ dbPath, backupDir: path.join(workDir, "b") });
    await reader.init();
    expect(reader.getSyncStatus(ORG).in_progress).toBe(true);
    g.markSyncComplete(ORG, new Date().toISOString());
    expect(reader.getSyncStatus(ORG).in_progress).toBe(false);
    await reader.close();
    await g.close();
  });

  it("an ingest owned by another host is trusted (its pid cannot be probed here)", async () => {
    const g = new SqliteGraphStore({ dbPath, backupDir: path.join(workDir, "b") });
    await g.init();
    g.upsertOrg(org());
    g.markSyncStarted(ORG, new Date().toISOString());
    g.db
      .prepare("UPDATE _sfgraph_orgs SET sync_owner_pid = 999999, sync_owner_host = ? WHERE id = ?")
      .run("some-other-host.invalid", ORG);
    expect(g.getSyncStatus(ORG).in_progress).toBe(true);
    await g.close();
  });

  it("the next ingest still starts and completes normally after a killed one", async () => {
    await killedIngest();
    const g = new SqliteGraphStore({ dbPath, backupDir: path.join(workDir, "b") });
    await g.init();
    const before = g.getSyncStatus(ORG).generation;
    g.markSyncStarted(ORG, new Date().toISOString());
    expect(g.getSyncStatus(ORG).in_progress).toBe(true);
    g.markSyncComplete(ORG, new Date().toISOString());
    const after = g.getSyncStatus(ORG);
    expect(after.in_progress).toBe(false);
    expect(after.generation).toBe(before + 1);
    await g.close();
  }, 30_000);
});
