import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConsoleLogger } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilesystemMetadataSource } from "../../extractors/filesystem/index.js";
import type { RawMember } from "../../extractors/interfaces/metadata-source.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { liveIngest } from "../live-ingest.js";
import { offlineResolvedOrg } from "../offline-org.js";

/**
 * T15 (ingest review, bulk-retrieve): the parallel merge rethrows a failed
 * sub-stream once its peers drained (merge-errors.test.ts). The ingest that
 * consumes the stream must not turn that into a silent partial result: the
 * abort is in the result's warnings and flagged, and nothing is swept.
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-abort-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});
function w(rel: string, c: string) {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, c, "utf8");
}

describe("a member stream that throws mid-way", () => {
  it("is reported in the result, never a silent partial ingest", async () => {
    w("sfdx-project.json", JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
    w("force-app/main/default/classes/A.cls", "public class A { }");
    w("force-app/main/default/classes/B.cls", "public class B { }");
    const graphStore = new SqliteGraphStore({ dbPath: ":memory:" });
    await graphStore.init();
    const src = await FilesystemMetadataSource.fromProjectRoot(dir);
    const failing = {
      ...src,
      iter: async function* (): AsyncIterable<RawMember> {
        let n = 0;
        for await (const m of src.iter()) {
          if (n++ === 1) throw new Error("sub-stream generic:Foo failed");
          yield m;
        }
      },
    } as typeof src;
    const res = await liveIngest({
      alias: "t",
      graphStore,
      mode: "full",
      preResolved: offlineResolvedOrg(dir, "t"),
      metadataSource: failing,
      logger: new ConsoleLogger("error"),
      skipSnapshot: true,
    });
    expect(res.streamAborted).toBe(true);
    expect(
      res.warnings.some((x) => /^stream:aborted:.*sub-stream generic:Foo failed/.test(x)),
    ).toBe(true);
  });
});
