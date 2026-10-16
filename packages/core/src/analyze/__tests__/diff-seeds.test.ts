import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConsoleLogger } from "@ryanstark24/sfgraph-shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FilesystemMetadataSource } from "../../extractors/filesystem/index.js";
import { liveIngest } from "../../ingest/live-ingest.js";
import { offlineResolvedOrg } from "../../ingest/offline-org.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { resolveDiffSeeds } from "../diff-seeds.js";
import { parseUnifiedDiff } from "../git-diff.js";
import { pathToQualifiedName } from "../path-to-qname.js";

// T15 query I-4: diff seeds are member-level where the hunks identify the
// method, every parsed type maps (grammar, else the member index), renames
// seed old and new, and nothing is silently dropped.

const FIXTURE = path.resolve(__dirname, "../../ingest/__tests__/fixtures/delta-project");
const CLS = "force-app/main/default/classes";
let dir: string;
let store: SqliteGraphStore;
let orgId: ReturnType<typeof offlineResolvedOrg>["orgId"];

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-diff-seeds-"));
  const proj = path.join(dir, "proj");
  cpSync(FIXTURE, proj, { recursive: true });
  vi.spyOn(console, "log").mockImplementation(() => {});
  store = new SqliteGraphStore({
    dbPath: path.join(dir, "g.sqlite"),
    backupDir: path.join(dir, "bk"),
  });
  await store.init();
  const org = offlineResolvedOrg(proj, "fixture");
  orgId = org.orgId;
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
});
afterAll(async () => {
  vi.restoreAllMocks();
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

const seeds = (diff: string) => resolveDiffSeeds(store, orgId, parseUnifiedDiff(diff), diff);
const file = (p: string, hunk: string) =>
  `diff --git a/${p} b/${p}\nindex 1..2 100644\n--- a/${p}\n+++ b/${p}\n${hunk}\n`;

describe("parseUnifiedDiff", () => {
  it("renames, binaries, quoted paths, mode-only changes and hunks", () => {
    const d = [
      "diff --git a/x/Old.cls b/x/New.cls",
      "similarity index 100%",
      "rename from x/Old.cls",
      "rename to x/New.cls",
      "diff --git a/img/logo.png b/img/logo.png",
      "index 1..2 100644",
      "Binary files a/img/logo.png and b/img/logo.png differ",
      'diff --git "a/x/My Class.cls" "b/x/My Class.cls"',
      "index 1..2 100644",
      '--- "a/x/My Class.cls"',
      '+++ "b/x/My Class.cls"',
      "@@ -1,2 +1,2 @@",
      " keep",
      "--- a removed line that looks like a header",
      "+added",
      "diff --git a/run.sh b/run.sh",
      "old mode 100644",
      "new mode 100755",
    ].join("\n");
    const files = parseUnifiedDiff(d);
    expect(files.map((f) => [f.path, f.status, f.oldPath, !!f.binary, !!f.modeOnly])).toEqual([
      ["x/New.cls", "renamed", "x/Old.cls", false, false],
      ["img/logo.png", "modified", undefined, true, false],
      ["x/My Class.cls", "modified", undefined, false, false],
      ["run.sh", "modified", undefined, false, true],
    ]);
    expect(files[2]?.hunks[0]?.lines).toEqual([
      " keep",
      "--- a removed line that looks like a header",
      "+added",
    ]);
  });
});

describe("pathToQualifiedName covers every single-file parsed type", () => {
  it.each([
    ["force-app/main/default/aura/cmp/cmpController.js", "AuraComponent:cmp"],
    ["force-app/main/default/pages/P.page", "ApexPage:P"],
    ["force-app/main/default/pages/P.page-meta.xml", "ApexPage:P"],
    ["force-app/main/default/components/C.component", "ApexComponent:C"],
    [
      "force-app/main/default/objects/A/validationRules/V.validationRule-meta.xml",
      "ValidationRule:A.V",
    ],
    ["force-app/main/default/objects/A/recordTypes/R.recordType-meta.xml", "RecordType:A.R"],
    ["force-app/main/default/customMetadata/T.Rec.md-meta.xml", "CustomMetadataRecord:T.Rec"],
    ["force-app/main/default/layouts/A-A Layout.layout-meta.xml", "Layout:A-A Layout"],
    ["force-app/main/default/permissionsets/Sales.permissionset-meta.xml", "PermissionSet:Sales"],
    ["force-app/main/default/flexipages/F.flexipage-meta.xml", "FlexiPage:F"],
    ["force-app/main/default/flows/F.flow-meta.xml", "Flow:F"],
  ])("%s -> %s", (p, q) => {
    expect(String(pathToQualifiedName(p))).toBe(q);
  });
  it("a multi-item or unknown file maps to nothing by grammar", () => {
    expect(
      pathToQualifiedName("force-app/main/default/labels/CustomLabels.labels-meta.xml"),
    ).toBeNull();
    expect(pathToQualifiedName("README.md")).toBeNull();
  });
});

describe("resolveDiffSeeds", () => {
  it("a changed line in one method seeds that method, not the class", () => {
    const r = seeds(
      file(
        `${CLS}/AccountService.cls`,
        "@@ -5,4 +5,4 @@\n   public static void save(List<Account> accts) {\n     update accts;\n-    OrderHelper.touch(accts);\n+    OrderHelper.touch(accts); Util.log('x');\n   }",
      ),
    );
    expect(r.seeds).toEqual([
      expect.objectContaining({
        qname: "ApexMethod:AccountService.save(1)",
        level: "member",
        component: "ApexClass:AccountService",
      }),
    ]);
  });

  it("an insertion between two lines of a method seeds that method", () => {
    const r = seeds(
      file(
        `${CLS}/AccountService.cls`,
        "@@ -6,2 +6,3 @@\n     update accts;\n+    accts.clear();\n     OrderHelper.touch(accts);",
      ),
    );
    expect(r.seeds.map((s) => s.qname)).toEqual(["ApexMethod:AccountService.save(1)"]);
  });

  it("a changed signature seeds its method", () => {
    const r = seeds(
      file(
        `${CLS}/AccountService.cls`,
        "@@ -9,3 +9,3 @@\n-  public static void ping(String msg) {\n+  public static void ping(Object msg) {\n     Util.log(msg);",
      ),
    );
    expect(r.seeds.map((s) => s.qname)).toEqual(["ApexMethod:AccountService.ping(1)"]);
  });

  it("a class-level change (the header) falls back to the class", () => {
    const r = seeds(
      file(
        `${CLS}/AccountService.cls`,
        "@@ -1,2 +1,2 @@\n-public with sharing class AccountService {\n+public without sharing class AccountService {\n   @AuraEnabled public static List<Account> load(Set<Id> ids) {",
      ),
    );
    expect(r.seeds).toEqual([
      expect.objectContaining({ qname: "ApexClass:AccountService", level: "component" }),
    ]);
  });

  it("a rename seeds the old and the new path", () => {
    const r = seeds(
      `diff --git a/${CLS}/LegacyHelper.cls b/${CLS}/LegacyRunner.cls\nsimilarity index 100%\nrename from ${CLS}/LegacyHelper.cls\nrename to ${CLS}/LegacyRunner.cls\n`,
    );
    expect(r.seeds.map((s) => [s.qname, s.status])).toEqual([
      ["ApexClass:LegacyHelper", "renamed"],
      ["ApexClass:LegacyRunner", "renamed"],
    ]);
  });

  // Cycle 2 T1 (re-review Minors): mixed hunks, look-alike class-level lines, copies.
  const AS = `${CLS}/AccountService.cls`;
  const qnames = (d: string) => seeds(d).seeds.map((s) => [s.qname, s.level]);

  it("a mixed hunk that also adds a class-level line seeds the class", () => {
    const d = file(
      AS,
      "@@ -6,4 +6,5 @@\n     update accts;\n-    OrderHelper.touch(accts);\n+    OrderHelper.touch(accts); Util.log('y');\n   }\n+  public static Integer counter = 0;\n   public static void ping(String msg) {",
    );
    expect(qnames(d)).toEqual([["ApexClass:AccountService", "component"]]);
  });

  it("a hunk whose removed lines are trivial still checks its added lines", () => {
    const h1 =
      "@@ -7,3 +7,4 @@\n     OrderHelper.touch(accts);\n-  }\n+  }\n+  public Integer extra;\n   public static void ping(String msg) {";
    const h2 = "@@ -10,2 +11,2 @@\n-    Util.log(msg);\n+    Util.log(msg + '!');\n   }";
    expect(qnames(file(AS, `${h1}\n${h2}`))).toEqual([["ApexClass:AccountService", "component"]]);
  });

  it("an added method body replacing a method's last line (closing it) seeds the class", () => {
    const d = file(
      AS,
      "@@ -6,3 +6,6 @@\n     update accts;\n-    OrderHelper.touch(accts);\n+    OrderHelper.touch(accts);\n+  }\n+  public static Integer extra() {\n+    return 1;\n   }",
    );
    expect(qnames(d)).toEqual([["ApexClass:AccountService", "component"]]);
  });

  it("a block whose `}` closes an inner block of the same method still seeds that method", () => {
    const d = file(
      AS,
      "@@ -6,4 +6,4 @@\n-    update accts;\n-    }\n-    OrderHelper.touch(accts);\n+    update accts2;\n+      }\n+    OrderHelper.touch(accts2);\n   }",
    );
    expect(qnames(d)).toEqual([["ApexMethod:AccountService.save(1)", "member"]]);
  });

  it("a removed class-level line identical to a method body line seeds the class", () => {
    const top = file(
      AS,
      "@@ -1,3 +1,2 @@\n public with sharing class AccountService {\n-  Util.log(msg);\n   @AuraEnabled public static List<Account> load(Set<Id> ids) {",
    );
    expect(qnames(top)).toEqual([["ApexClass:AccountService", "component"]]);
    const between = file(
      AS,
      "@@ -8,3 +8,2 @@\n   }\n-  Util.log(msg);\n   public static void ping(String msg) {",
    );
    expect(qnames(between)).toEqual([["ApexClass:AccountService", "component"]]);
  });

  it("a method's last line removed before the next method still seeds that method", () => {
    const d = file(
      AS,
      "@@ -6,4 +6,3 @@\n     update accts;\n-    OrderHelper.touch(accts);\n   }\n   public static void ping(String msg) {",
    );
    expect(qnames(d)).toEqual([["ApexMethod:AccountService.save(1)", "member"]]);
  });

  it("a copy seeds only the new path, not the unchanged source", () => {
    const d = `diff --git a/${CLS}/LegacyHelper.cls b/${CLS}/LegacyCopy.cls\nsimilarity index 100%\ncopy from ${CLS}/LegacyHelper.cls\ncopy to ${CLS}/LegacyCopy.cls\n`;
    const files = parseUnifiedDiff(d);
    expect(files.map((f) => [f.path, f.status, f.oldPath, f.copyFrom])).toEqual([
      [`${CLS}/LegacyCopy.cls`, "added", undefined, `${CLS}/LegacyHelper.cls`],
    ]);
    expect(seeds(d).seeds.map((s) => [s.qname, s.status])).toEqual([
      ["ApexClass:LegacyCopy", "added"],
    ]);
  });

  it("a DataPack's other file maps through the member index", () => {
    const p = "vlocity/datapacks/DataRaptor/AcctFetch/AcctFetch_Mappings.json";
    const r = seeds(file(p, "@@ -1 +1 @@\n-{}\n+{ }"));
    expect(r.seeds.map((s) => s.qname)).toEqual(["DataRaptor:AcctFetch"]);
    expect(r.unmapped).toEqual([]);
  });

  it("binary, mode-only, unknown and unparseable input is reported, not dropped", () => {
    const d = [
      "diff --git a/force-app/main/default/staticresources/logo.png b/force-app/main/default/staticresources/logo.png",
      "Binary files a/force-app/main/default/staticresources/logo.png and b/force-app/main/default/staticresources/logo.png differ",
      "diff --git a/run.sh b/run.sh",
      "old mode 100644",
      "new mode 100755",
      file("README.md", "@@ -1 +1 @@\n-a\n+b"),
    ].join("\n");
    expect(seeds(d).unmapped).toEqual([
      { path: "force-app/main/default/staticresources/logo.png", reason: "binary" },
      { path: "run.sh", reason: "mode-only" },
      { path: "README.md", reason: "no-qname" },
    ]);
    expect(seeds("not a diff at all").unmapped).toEqual([
      { path: "(diff)", reason: "unparseable" },
    ]);
  });
});
