import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConsoleLogger } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilesystemMetadataSource } from "../../extractors/filesystem/index.js";
import { liveIngest } from "../../ingest/live-ingest.js";
import { offlineResolvedOrg } from "../../ingest/offline-org.js";
import { makeTestCtx } from "../../parsers/__tests__/_harness.js";
import { ApexClassParser } from "../../parsers/apex/class.js";
import { emitSarif, lintSarifReport } from "../../render/sarif.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { scanCodeSecurity } from "../code-security.js";
import { codeSecurityToFindings } from "../findings.js";
import { scanGovernorRisks } from "../governor.js";
import { toUriReference, uriReferenceProblem } from "../source-uri.js";

// 1.9.0 outside review: (1) SARIF uris are valid URI references, (2) the method node hash covers
// the signature, so a safe signature change drops a persisted injection finding, through two real
// ingests of the same store.

const cls = (paramType: string): string => `public with sharing class Finder {
    public static List<Account> run(${paramType} term) {
        return Database.query('SELECT Id FROM Account WHERE Name = \\'' + term + '\\'');
    }
}
`;

describe("toUriReference / uriReferenceProblem", () => {
  it("encodes spaces, #, %, ? and non-ASCII per segment and keeps / and the drive", () => {
    expect(toUriReference("file:///p/with space/a#b/100%/q?x/café/F.cls")).toBe(
      "file:///p/with%20space/a%23b/100%25/q%3Fx/caf%C3%A9/F.cls",
    );
    expect(toUriReference("file://C:\\Users\\a b\\F.cls")).toBe("file:///C:/Users/a%20b/F.cls");
    expect(toUriReference("force-app/my dir/F.cls")).toBe("force-app/my%20dir/F.cls");
  });
  it("leaves a plain path alone, and a non-file scheme", () => {
    expect(toUriReference("file:///p/force-app/F.cls")).toBe("file:///p/force-app/F.cls");
    expect(toUriReference("https://example.com/a b")).toBe("https://example.com/a b");
  });
  it("accepts encoded references and rejects raw ones", () => {
    expect(uriReferenceProblem("file:///p/with%20space/caf%C3%A9.cls")).toBeUndefined();
    expect(uriReferenceProblem("file:///p/with space/F.cls")).toBeDefined();
    expect(uriReferenceProblem("file:///p/café/F.cls")).toBeDefined();
    expect(uriReferenceProblem("file:///p/100%/F.cls")).toBeDefined();
  });
});

describe("a project folder with spaces, through ingest and export", () => {
  let dir: string;
  let store: SqliteGraphStore;
  let proj: string;
  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "sfg-hash-uri-"));
    proj = path.join(dir, "project with spaces");
    mkdirSync(path.join(proj, "force-app/main/default/classes"), { recursive: true });
    writeFileSync(
      path.join(proj, "sfdx-project.json"),
      '{ "packageDirectories": [{ "path": "force-app" }] }',
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

  const ingest = async (rebuild: boolean): Promise<ReturnType<typeof offlineResolvedOrg>> => {
    const org = offlineResolvedOrg(proj, "fixture");
    await liveIngest({
      alias: "fixture",
      graphStore: store,
      mode: "full",
      rebuild,
      preResolved: org,
      metadataSource: FilesystemMetadataSource.fromProjectRoot(proj),
      logger: new ConsoleLogger("error"),
      skipSnapshot: true,
      analysisDb: store.db,
    });
    return org;
  };
  const write = (body: string): void =>
    writeFileSync(path.join(proj, "force-app/main/default/classes/Finder.cls"), body);

  it("export_sarif output has encoded uris and no lint errors", async () => {
    write(cls("String"));
    const org = await ingest(true);
    const found = scanCodeSecurity(store, org.orgId).findings;
    expect(found).toHaveLength(1);
    const report = emitSarif({ version: "1.9.0", findings: codeSecurityToFindings(found) });
    const uri = report.runs[0]?.results[0]?.locations[0]?.physicalLocation?.artifactLocation.uri;
    expect(uri).toContain("/project%20with%20spaces/force-app/main/default/classes/Finder.cls");
    expect(uri).not.toContain(" ");
    expect(lintSarifReport(report)).toEqual([]);
  });

  it("a safe signature change (String -> Id) drops the persisted injection finding", async () => {
    write(cls("String"));
    const org = await ingest(true);
    expect(scanCodeSecurity(store, org.orgId).findings).toHaveLength(1);
    write(cls("Id"));
    await ingest(false);
    expect(scanCodeSecurity(store, org.orgId).findings).toEqual([]);
  });
});

describe("Apex method node hash", () => {
  const hashOf = async (src: string): Promise<string> => {
    const r = await new ApexClassParser().parse({ className: "Finder", body: src }, makeTestCtx());
    return String(r.nodes.find((n) => n.label === "ApexMethod")?.sourceHash);
  };
  it("changes with a parameter type, a parameter name, a modifier and an annotation", async () => {
    const base = await hashOf(cls("String"));
    expect(await hashOf(cls("Id"))).not.toBe(base);
    expect(await hashOf(cls("String").replace(/term/g, "other"))).not.toBe(base);
    expect(await hashOf(cls("String").replace("public static", "global static"))).not.toBe(base);
    expect(
      await hashOf(cls("String").replace("public static", "@AuraEnabled public static")),
    ).not.toBe(base);
  });
  it("is stable for identical source", async () => {
    expect(await hashOf(cls("String"))).toBe(await hashOf(cls("String")));
  });
});

describe("@future overload through a real ingest", () => {
  it("a synchronous overload of another arity is not reported, the @future call is", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sfg-future-"));
    const proj = path.join(dir, "proj");
    const classes = path.join(proj, "force-app/main/default/classes");
    mkdirSync(classes, { recursive: true });
    writeFileSync(
      path.join(proj, "sfdx-project.json"),
      '{ "packageDirectories": [{ "path": "force-app" }] }',
    );
    writeFileSync(
      path.join(classes, "Sender.cls"),
      `public class Sender {
    @future public static void send(Id x) { }
    public static void send(Id x, Boolean b) { }
    public static void many(List<Id> ids) {
        for (Id i : ids) { send(i, true); }
        for (Id i : ids) { send(i); }
    }
}
`,
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    const store = new SqliteGraphStore({
      dbPath: path.join(dir, "g.sqlite"),
      backupDir: path.join(dir, "bk"),
    });
    await store.init();
    try {
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
      const risks = scanGovernorRisks(store, org.orgId).risks.filter(
        (r) => r.risk === "async_in_loop",
      );
      expect(risks.map((r) => r.line)).toEqual([6]);
    } finally {
      vi.restoreAllMocks();
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
