import { ConsoleLogger, asOrgId } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { buildJsforceMock } from "../../extractors/live-org/__tests__/_jsforce-mock.js";
import type { IngestSkipReport } from "../../extractors/live-org/bulk-retrieve.js";
import { __testing as bulkTesting } from "../../extractors/live-org/bulk-retrieve.js";
import { wrapConnectionReadOnly } from "../../extractors/live-org/read-only-proxy.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { liveIngest } from "../live-ingest.js";

/**
 * Exit hang (large live-org re-ingest, 2026-10-09): after the auto-retry pass the
 * CLI printed its last line, then sat idle for ~3.8 min before exiting. The
 * failSoft watchdog timer (5 min inactivity / 90 s first-yield, ref'd) was
 * only cleared when the source's `next()` RESOLVED; a source that THREW left
 * it armed, holding the event loop open until it fired. Every source that
 * skips by throwing leaked one. An ingest must leave no timers behind.
 */

const timers = (): number => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

describe("ingest leaves no live timers behind", () => {
  it("failSoft clears its watchdog when the source throws (after a yield and before one)", async () => {
    const before = timers();
    const coordinator = bulkTesting.createWedgeCoordinator();
    async function* yieldsThenThrows() {
      yield { type: "X", fullName: "a", body: "" } as never;
      throw new Error("socket hang up (ECONNRESET)");
    }
    // biome-ignore lint/correctness/useYield: throws before any yield on purpose
    async function* throwsAtOnce(): AsyncGenerator<never> {
      throw new Error("socket hang up (ECONNRESET)");
    }
    const errors: string[] = [];
    for (const factory of [yieldsThenThrows, throwsAtOnce]) {
      for await (const _ of bulkTesting.failSoft(
        "x",
        factory,
        (_l, e) => errors.push(e.message),
        coordinator,
      )) {
        /* consume */
      }
    }
    expect(errors).toHaveLength(2);
    expect(timers()).toBeLessThanOrEqual(before);
  });

  it("a live ingest with skipped sources, followed by a targeted retry pass, leaves no timers", async () => {
    // Fifteen generic types whose listing always fails transiently: each is a
    // failSoft source that throws -> skip (as on the real org, > the CLI's
    // auto-retry threshold of 10).
    const types = Array.from({ length: 15 }, (_, i) => `Leaky${i}Type`);
    const conn = buildJsforceMock({
      toolingQueryResults: {},
      metadataDescribe: types.map((xmlName) => ({ xmlName, childXmlNames: [] })),
    });
    conn.metadata.list = async () => {
      throw new Error("socket hang up (ECONNRESET)");
    };
    const graphStore = new SqliteGraphStore({ dbPath: ":memory:" });
    await graphStore.init();
    const resolved = {
      orgId: asOrgId("00Dxx0000000LEAKAA"),
      alias: "leak",
      username: "leak@example.com",
      instanceUrl: "https://example.my.salesforce.com",
      apiVersion: "60.0",
      conn: wrapConnectionReadOnly(conn),
    };
    const base = {
      alias: "leak",
      graphStore,
      mode: "full" as const,
      preResolved: resolved,
      logger: new ConsoleLogger("error"),
      skipSnapshot: true,
    };
    const before = timers();
    const first = await liveIngest(base);
    const skipped = first.warnings.filter((w) => w.startsWith("generic:Leaky"));
    expect(skipped.length).toBe(types.length);
    // The CLI auto-retry: a second pass scoped to the skipped labels.
    await liveIngest({ ...base, onlyLabels: new Set(types.map((t) => `generic:${t}`)) });
    expect(timers()).toBeLessThanOrEqual(before);
    await graphStore.close();
  }, 60_000);
});
