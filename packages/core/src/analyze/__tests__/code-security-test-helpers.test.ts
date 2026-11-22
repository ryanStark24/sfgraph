import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConsoleLogger } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilesystemMetadataSource } from "../../extractors/filesystem/index.js";
import { liveIngest } from "../../ingest/live-ingest.js";
import { offlineResolvedOrg } from "../../ingest/offline-org.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { scanCodeSecurity } from "../code-security.js";

// An instance helper in an @isTest class keeps isTest false on its ApexMethod node (the parser
// copies the class's status onto static methods only). scanCodeSecurity must still treat it as
// test code, through the shared makeTestSourceCheck (owner lookup), and still report the same
// method in a production class.

const helper = `void q(String s) { Database.query('SELECT Id FROM Account WHERE Name = \\'' + s + '\\''); }`;

describe("scanCodeSecurity and test-class helper methods", () => {
  let dir: string;
  let proj: string;
  let store: SqliteGraphStore;
  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "sfg-sec-testhelp-"));
    proj = path.join(dir, "proj");
    const classes = path.join(proj, "force-app/main/default/classes");
    mkdirSync(classes, { recursive: true });
    writeFileSync(
      path.join(proj, "sfdx-project.json"),
      '{ "packageDirectories": [{ "path": "force-app" }] }',
    );
    writeFileSync(
      path.join(classes, "TestHelperTest.cls"),
      `@isTest\nprivate class TestHelperTest {\n    ${helper}\n}\n`,
    );
    writeFileSync(
      path.join(classes, "ProdHelper.cls"),
      `public with sharing class ProdHelper {\n    ${helper}\n}\n`,
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    store = new SqliteGraphStore({
      dbPath: path.join(dir, "g.sqlite"),
      backupDir: path.join(dir, "bk"),
    });
    await store.init();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips the instance helper of an @isTest class, reports the production one", async () => {
    const org = offlineResolvedOrg(proj, "fixture");
    await liveIngest({
      alias: "fixture",
      graphStore: store,
      mode: "full",
      rebuild: true,
      preResolved: org,
      metadataSource: FilesystemMetadataSource.fromProjectRoot(proj),
      logger: new ConsoleLogger("error"),
      skipSnapshot: true,
      analysisDb: store.db,
    });
    const found = scanCodeSecurity(store, org.orgId).findings;
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("high");
    expect(found[0]?.ruleId).toBe("security.soql-injection");
    expect(found[0]?.qualifiedName).toContain("ProdHelper");
    expect(found.some((f) => f.qualifiedName.includes("TestHelperTest"))).toBe(false);
  });
});
