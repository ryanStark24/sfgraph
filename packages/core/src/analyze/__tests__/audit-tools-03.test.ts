import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConsoleLogger } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilesystemMetadataSource } from "../../extractors/filesystem/index.js";
import { liveIngest } from "../../ingest/live-ingest.js";
import { offlineResolvedOrg } from "../../ingest/offline-org.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { analyzeLocalImpact } from "../wip-impact.js";

// audit tools-03: wip diff of the exact tree that was ingested must be empty,
// including Vlocity DataPacks (wip used a different parser adapter).
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-audit-t03-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function w(rel: string, c: string) {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, c, "utf8");
}

describe("audit tools-03: wip diff on an unmodified ingested tree", () => {
  it("reports no changed DataPack components", async () => {
    const NS = "%vlocity_namespace%__";
    w("sfdx-project.json", JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
    w("force-app/main/default/classes/Foo.cls", "public class Foo { public void a() {} }");
    const dr = "vlocity/datapacks/DataRaptor/WidgetFetch";
    w(
      `${dr}/WidgetFetch_DataPack.json`,
      JSON.stringify({
        Name: "WidgetFetch",
        [`${NS}Type__c`]: "Extract",
        [`${NS}DRMapItem__c`]: "WidgetFetch_Mappings.json",
      }),
    );
    w(
      `${dr}/WidgetFetch_Mappings.json`,
      JSON.stringify([
        {
          [`${NS}InterfaceObjectName__c`]: "Account",
          [`${NS}InterfaceFieldAPIName__c`]: "Name",
          [`${NS}InterfaceObjectLookupOrder__c`]: 1,
          [`${NS}DomainObjectAPIName__c`]: "json",
          [`${NS}DomainObjectFieldAPIName__c`]: "AccName",
        },
      ]),
    );
    const ef = "vlocity/datapacks/EntityFilter/ActiveOnly";
    w(
      `${ef}/ActiveOnly_DataPack.json`,
      JSON.stringify({ Name: "ActiveOnly", [`${NS}IsActive__c`]: true }),
    );

    const graphStore = new SqliteGraphStore({ dbPath: ":memory:" });
    await graphStore.init();
    const resolved = offlineResolvedOrg(dir, "bench");
    await liveIngest({
      alias: "bench",
      graphStore,
      mode: "auto",
      preResolved: resolved,
      metadataSource: await FilesystemMetadataSource.fromProjectRoot(dir),
      logger: new ConsoleLogger("error"),
      skipSnapshot: true,
    });
    expect(graphStore.getNode(resolved.orgId, "DataRaptor:WidgetFetch" as never)).not.toBeNull();

    // Touch every file after the sync (same content), so changed-only mode
    // selects and re-parses them all: parity must come from the shared
    // adapter/hash, not from the change filter skipping the files.
    const later = new Date(Date.now() + 3_600_000);
    for (const f of [
      "force-app/main/default/classes/Foo.cls",
      `${dr}/WidgetFetch_DataPack.json`,
      `${dr}/WidgetFetch_Mappings.json`,
      `${ef}/ActiveOnly_DataPack.json`,
    ]) {
      utimesSync(path.join(dir, f), later, later);
    }
    for (const mode of ["changed-only", "full-folder"] as const) {
      const r = await analyzeLocalImpact({
        graphStore,
        orgId: resolved.orgId,
        projectRoot: dir,
        mode,
      });
      expect(r.changedQnames, mode).toEqual([]);
      expect(r.addedQnames, mode).toEqual([]);
      expect(r.removedQnames, mode).toEqual([]);
    }
    await graphStore.close();
  });
});
