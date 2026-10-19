import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConsoleLogger, asOrgId } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildJsforceMock } from "../../extractors/live-org/__tests__/_jsforce-mock.js";
import { wrapConnectionReadOnly } from "../../extractors/live-org/read-only-proxy.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { liveIngest } from "../live-ingest.js";

/**
 * Review I2: every liveIngest overwrote <orgId>.skips.json with only its own
 * pass. The auto-retry pass and --only runs are scoped by `onlyLabels`, so
 * entries for labels they did NOT re-run (unreadable, insufficient_access…)
 * vanished from the report, the final summary and the returned warnings.
 * A scoped run must replace entries only for the labels it re-ran.
 */

type Skip = { label: string; reason: string; category: string };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sfg-skipmerge-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function ingest(onlyLabels?: Set<string>) {
  const conn = buildJsforceMock({
    metadataDescribe: [
      { xmlName: "Healed", childXmlNames: [] },
      { xmlName: "Broken", childXmlNames: [] },
    ],
    metadataList: { Healed: [] },
  });
  const list = conn.metadata.list;
  conn.metadata.list = async (req: { type: string }[]) => {
    if (req[0]?.type === "Broken") throw new Error("socket hang up (ECONNRESET)");
    return list(req);
  };
  const graphStore = new SqliteGraphStore({ dbPath: ":memory:" });
  await graphStore.init();
  const skipReportPath = join(dir, "org.skips.json");
  const result = await liveIngest({
    alias: "m",
    graphStore,
    mode: "full",
    preResolved: {
      orgId: asOrgId("00Dxx0000000MRGAA"),
      alias: "m",
      username: "m@example.com",
      instanceUrl: "https://example.my.salesforce.com",
      apiVersion: "60.0",
      conn: wrapConnectionReadOnly(conn),
    },
    logger: new ConsoleLogger("error"),
    skipSnapshot: true,
    skipReportPath,
    ...(onlyLabels ? { onlyLabels } : {}),
  });
  await graphStore.close();
  const report = JSON.parse(readFileSync(skipReportPath, "utf8")) as { skips: Skip[] };
  return { result, skips: report.skips, skipReportPath };
}

function seed(path: string, skips: Skip[]) {
  writeFileSync(path, JSON.stringify({ recordedAt: 0, orgId: "00Dxx0000000MRGAA", skips }), "utf8");
}

describe("skip report survives scoped re-runs (review I2)", () => {
  it("a scoped run keeps entries for labels it did not re-run and replaces the rest", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const path = join(dir, "org.skips.json");
    seed(path, [
      {
        label: "generic:Unread",
        reason: "generic:Unread: 3 member(s) unreadable",
        category: "unreadable",
      },
      { label: "generic:Healed", reason: "socket hang up", category: "network" },
      { label: "generic:Broken", reason: "socket hang up", category: "network" },
    ]);
    const { result, skips } = await ingest(new Set(["generic:Healed", "generic:Broken"]));
    const labels = skips.map((s) => `${s.label}/${s.category}`).sort();
    // Healed is gone (re-run, succeeded), Broken is re-recorded (re-run, failed
    // again), Unread is carried over untouched.
    expect(labels).toEqual(["generic:Broken/unknown", "generic:Unread/unreadable"]);
    expect(result.warnings.some((w) => w.startsWith("generic:Unread:"))).toBe(true);
  });

  it("an unscoped run replaces the whole report", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const path = join(dir, "org.skips.json");
    seed(path, [{ label: "generic:Unread", reason: "x", category: "unreadable" }]);
    const { skips } = await ingest();
    expect(skips.map((s) => s.label)).toEqual(["generic:Broken"]);
  });
});

describe("carriedOverSkips honours the `discovery` alias (re-review N3)", () => {
  it("--only discovery re-runs every generic:* source, so none of their entries carry over", async () => {
    const { carriedOverSkips } = await import("../live-ingest.js");
    const path = join(dir, "org.skips.json");
    seed(path, [
      { label: "generic:Healed", reason: "socket hang up", category: "network" },
      { label: "generic:Unread", reason: "refused", category: "unreadable" },
      { label: "discovery", reason: "metadata discovery failed", category: "unknown" },
      { label: "apex", reason: "socket hang up", category: "network" },
    ]);
    const kept = carriedOverSkips(path, "00Dxx0000000MRGAA", new Set(["discovery"]));
    expect(kept.map((s) => s.label)).toEqual(["apex"]);
  });
});
