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
  dir = mkdtempSync(path.join(tmpdir(), "sfg-audit-c08-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function w(rel: string, c: string) {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, c, "utf8");
}

// audit corecorr-08: Aura bundles are never parsed, so controllers used only from Aura look dead.
describe("audit corecorr-08", () => {
  it("an Aura component's controller= attribute yields an inbound edge on the Apex class", async () => {
    w("sfdx-project.json", JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
    w(
      "force-app/main/default/classes/BillingCtrl.cls",
      "public class BillingCtrl { @AuraEnabled public static String hi() { return 'x'; } }",
    );
    w(
      "force-app/main/default/aura/BillingCmp/BillingCmp.cmp",
      '<aura:component controller="BillingCtrl" implements="flexipage:availableForAllPageTypes"><p>hi</p></aura:component>',
    );
    w(
      "force-app/main/default/aura/BillingCmp/BillingCmp.cmp-meta.xml",
      "<AuraDefinitionBundle><apiVersion>60.0</apiVersion></AuraDefinitionBundle>",
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
    expect(graphStore.getNode(resolved.orgId, "ApexClass:BillingCtrl" as never)).not.toBeNull();
    const inbound = graphStore.listEdgesTo(resolved.orgId, "ApexClass:BillingCtrl" as never);
    expect(inbound.length).toBeGreaterThan(0);
  });
});

// review I4: `<c:name>` resolves against the bundles that exist; the first
// letter's case is only the tiebreak when neither an Aura nor an LWC bundle
// of that name exists.
describe("review I4: Aura embeds resolve against known bundles", () => {
  async function ingest() {
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
    return { graphStore, org: resolved.orgId };
  }
  const meta = "<AuraDefinitionBundle><apiVersion>60.0</apiVersion></AuraDefinitionBundle>";
  it("a lowercase Aura bundle embedded with <c:name> gets EMBEDS_AURA, not a dangling EMBEDS_LWC", async () => {
    w("sfdx-project.json", JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
    w(
      "force-app/main/default/aura/exportRowsCsv/exportRowsCsv.cmp",
      "<aura:component><p>csv</p></aura:component>",
    );
    w("force-app/main/default/aura/exportRowsCsv/exportRowsCsv.cmp-meta.xml", meta);
    w(
      "force-app/main/default/aura/Parent/Parent.cmp",
      "<aura:component><c:exportRowsCsv/><c:lwcCard/><c:Missing/><c:ghostly/></aura:component>",
    );
    w("force-app/main/default/aura/Parent/Parent.cmp-meta.xml", meta);
    w(
      "force-app/main/default/lwc/lwcCard/lwcCard.js",
      "import { LightningElement } from 'lwc'; export default class LwcCard extends LightningElement {}",
    );
    w(
      "force-app/main/default/lwc/lwcCard/lwcCard.js-meta.xml",
      "<LightningComponentBundle><apiVersion>60.0</apiVersion></LightningComponentBundle>",
    );
    const { graphStore, org } = await ingest();
    const out = graphStore
      .listEdgesFrom(org, "AuraComponent:Parent" as never)
      .filter((e) => e.relType === "EMBEDS_AURA" || e.relType === "EMBEDS_LWC")
      .map((e) => `${e.relType} ${e.dstQualifiedName}`)
      .sort();
    expect(out).toEqual([
      "EMBEDS_AURA AuraComponent:Missing",
      "EMBEDS_AURA AuraComponent:exportRowsCsv",
      "EMBEDS_LWC LWC:ghostly",
      "EMBEDS_LWC LWC:lwcCard",
    ]);
    expect(
      graphStore.listEdgesTo(org, "AuraComponent:exportRowsCsv" as never).length,
    ).toBeGreaterThan(0);
  });
});
