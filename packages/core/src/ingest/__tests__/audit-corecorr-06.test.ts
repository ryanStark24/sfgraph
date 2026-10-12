import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConsoleLogger } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilesystemMetadataSource } from "../../extractors/filesystem/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { liveIngest } from "../live-ingest.js";
import { offlineResolvedOrg } from "../offline-org.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-audit-c06-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function w(rel: string, c: string) {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, c, "utf8");
}

// audit corecorr-06: a member that stops emitting any outgoing edge kept its stale edges
// (fixed in Task 11c, N-5: reconcileExtraSrcs).
describe("audit corecorr-06", () => {
  it("removes a stale CALLS edge after the only call is deleted from the source", async () => {
    w("sfdx-project.json", JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
    w("force-app/main/default/classes/Foo.cls", "public class Foo { public static void bar() {} }");
    w(
      "force-app/main/default/classes/Baz.cls",
      "public class Baz { public void qux() { Foo.bar(); } }",
    );
    const graphStore = new SqliteGraphStore({ dbPath: ":memory:" });
    await graphStore.init();
    const resolved = offlineResolvedOrg(dir, "bench");
    const run = async () =>
      liveIngest({
        alias: "bench",
        graphStore,
        mode: "full",
        preResolved: resolved,
        metadataSource: await FilesystemMetadataSource.fromProjectRoot(dir),
        logger: new ConsoleLogger("error"),
        skipSnapshot: true,
      });
    await run();
    const callsFromBaz = () =>
      graphStore
        .listEdgesFrom(resolved.orgId, "ApexClass:Baz" as never)
        .concat(graphStore.listEdgesFrom(resolved.orgId, "ApexMethod:Baz.qux(0)" as never))
        .filter((e) => String(e.relType) === "CALLS");
    // Sanity: the first run produced the edge (otherwise this test proves nothing).
    expect(callsFromBaz().length).toBeGreaterThan(0);
    w("force-app/main/default/classes/Baz.cls", "public class Baz { public void qux() { } }");
    await run();
    expect(callsFromBaz()).toHaveLength(0);
  });
});
