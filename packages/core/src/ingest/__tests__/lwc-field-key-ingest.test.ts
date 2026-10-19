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
  dir = mkdtempSync(path.join(tmpdir(), "sfg-lwckey-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function w(rel: string, c: string) {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, c, "utf8");
}

async function ingest(disable: boolean) {
  w("sfdx-project.json", JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
  w(
    "force-app/main/default/objects/Quote/fields/Site_Remarks__c.field-meta.xml",
    "<CustomField><fullName>Site_Remarks__c</fullName><type>Text</type></CustomField>",
  );
  w(
    "force-app/main/default/lwc/payloadBuilder/payloadBuilder.js",
    "export default class P { save(x) { return { Id: x.id, Site_Remarks__c: x.r }; } }",
  );
  w(
    "force-app/main/default/lwc/payloadBuilder/payloadBuilder.js-meta.xml",
    "<LightningComponentBundle><apiVersion>59.0</apiVersion></LightningComponentBundle>",
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
    disableLwcFieldKeyResolve: disable,
  });
  return graphStore
    .listEdgesFrom(resolved.orgId, "LWC:payloadBuilder" as never)
    .filter((e) => e.relType === "LWC_BINDS_FIELD")
    .map((e) => String(e.dstQualifiedName));
}

describe("liveIngest runs the LWC field-key resolver", () => {
  it("binds a unique record-literal key end to end", async () => {
    expect(await ingest(false)).toEqual(["CustomField:Quote.Site_Remarks__c"]);
  });

  it("can be disabled", async () => {
    expect(await ingest(true)).toEqual([]);
  });
});
