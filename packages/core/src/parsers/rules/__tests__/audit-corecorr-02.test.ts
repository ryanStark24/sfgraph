import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConsoleLogger } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilesystemMetadataSource } from "../../../extractors/filesystem/index.js";
import { liveIngest } from "../../../ingest/live-ingest.js";
import { offlineResolvedOrg } from "../../../ingest/offline-org.js";
import { SqliteGraphStore } from "../../../storage/sqlite/graph-store.js";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { parserRegistry } from "../../registry.js";
import { loadAllRules } from "../_loader.js";

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
 * Audit corecorr-02: CustomMetadata records emit INSTANCE_OF ->
 * CustomMetadataType:<Type>, but the type is stored as CustomObject:<Type>__mdt,
 * so the edge never resolves.
 */
describe("audit corecorr-02: CustomMetadata record INSTANCE_OF resolves", () => {
  it("links Txn_Type.Foo to an existing node for the Txn_Type__mdt type", async () => {
    w(
      `${D}/objects/Txn_Type__mdt/Txn_Type__mdt.object-meta.xml`,
      '<?xml version="1.0" encoding="UTF-8"?><CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><label>Txn Type</label></CustomObject>',
    );
    w(
      `${D}/customMetadata/Txn_Type.Foo.md-meta.xml`,
      '<?xml version="1.0" encoding="UTF-8"?><CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata"><label>Foo</label><protected>false</protected></CustomMetadata>',
    );
    const { graphStore, orgId } = await ingest();
    const src = "CustomMetadataRecord:Txn_Type.Foo";
    expect(graphStore.getNode(orgId, src as never)).not.toBeNull();
    const inst = graphStore
      .listEdgesFrom(orgId, src as never)
      .filter((e) => String(e.relType) === "INSTANCE_OF");
    expect(inst).toHaveLength(1);
    // Either target the CustomObject:Txn_Type__mdt node directly or alias the
    // type onto it; what matters is that the edge resolves.
    expect(graphStore.getNode(orgId, "CustomObject:Txn_Type__mdt" as never)).not.toBeNull();
    const dst = String(inst[0]?.dstQualifiedName);
    expect(graphStore.getNode(orgId, dst as never)).not.toBeNull();
  });

  it("review M-4: a dot-less member never writes a CustomObject node over the object parser's", async () => {
    await loadAllRules();
    const parser = parserRegistry.for("CustomMetadata");
    expect(parser).toBeDefined();
    const out = await parser?.parse(
      {
        name: "Txn_Type",
        xml: '<?xml version="1.0"?><CustomMetadata><label>Txn Type</label></CustomMetadata>',
      },
      makeTestCtx(),
    );
    expect(out?.nodes.filter((n) => n.label === "CustomObject")).toEqual([]);
  });
});
