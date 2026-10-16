import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConsoleLogger } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilesystemMetadataSource } from "../../../extractors/filesystem/index.js";
import { liveIngest } from "../../../ingest/live-ingest.js";
import { offlineResolvedOrg } from "../../../ingest/offline-org.js";
import { SqliteGraphStore } from "../../../storage/sqlite/graph-store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-audit-parsers-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function w(rel: string, c: string) {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, c, "utf8");
}
async function ingest() {
  w("sfdx-project.json", JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
  const graphStore = new SqliteGraphStore({ dbPath: ":memory:" });
  await graphStore.init();
  const resolved = offlineResolvedOrg(dir, "bench");
  await liveIngest({
    alias: "bench",
    graphStore,
    mode: "full",
    preResolved: resolved,
    metadataSource: await FilesystemMetadataSource.fromProjectRoot(dir),
    logger: new ConsoleLogger("error"),
    skipSnapshot: true,
  });
  return { graphStore, orgId: resolved.orgId };
}
const D = "force-app/main/default";

/**
 * Audit dangling-13: no CustomTab nodes are ever created (no tab parser and
 * the filesystem extractor does not route tabs/), so every
 * GRANTS_TAB_ACCESS edge dangles.
 */
describe("audit dangling-13: CustomTab nodes exist for tabs/*.tab-meta.xml", () => {
  it("creates CustomTab:Widget__c and resolves the Profile tab grant to it", async () => {
    w(
      `${D}/tabs/Widget__c.tab-meta.xml`,
      '<?xml version="1.0" encoding="UTF-8"?><CustomTab xmlns="http://soap.sforce.com/2006/04/metadata"><customObject>true</customObject><motif>Custom1: Heart</motif></CustomTab>',
    );
    w(
      `${D}/profiles/Admin.profile-meta.xml`,
      '<?xml version="1.0" encoding="UTF-8"?><Profile xmlns="http://soap.sforce.com/2006/04/metadata"><tabVisibilities><tab>Widget__c</tab><visibility>DefaultOn</visibility></tabVisibilities></Profile>',
    );
    const { graphStore, orgId } = await ingest();
    const grants = graphStore
      .listEdgesFrom(orgId, "Profile:Admin" as never)
      .filter((e) => String(e.relType) === "GRANTS_TAB_ACCESS");
    expect(grants.map((e) => String(e.dstQualifiedName))).toEqual(["CustomTab:Widget__c"]);
    expect(graphStore.getNode(orgId, "CustomTab:Widget__c" as never)).not.toBeNull();
  });

  it("links an object tab to its object and an LWC tab to its component", async () => {
    w(
      `${D}/tabs/Widget__c.tab-meta.xml`,
      '<?xml version="1.0" encoding="UTF-8"?><CustomTab xmlns="http://soap.sforce.com/2006/04/metadata"><customObject>true</customObject></CustomTab>',
    );
    w(
      `${D}/tabs/Board.tab-meta.xml`,
      '<?xml version="1.0" encoding="UTF-8"?><CustomTab xmlns="http://soap.sforce.com/2006/04/metadata"><customObject>false</customObject><lwcComponent>boardView</lwcComponent></CustomTab>',
    );
    const { graphStore, orgId } = await ingest();
    const out = (qn: string) =>
      graphStore
        .listEdgesFrom(orgId, qn as never)
        .map((e) => `${String(e.relType)}>${String(e.dstQualifiedName)}`);
    expect(out("CustomTab:Widget__c")).toEqual(["REFERENCES_OBJECT>CustomObject:Widget__c"]);
    expect(out("CustomTab:Board")).toEqual(["USES_LWC>LWC:boardView"]);
  });
});
