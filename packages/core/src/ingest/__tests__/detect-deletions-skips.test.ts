/**
 * Task 11c: the live-org `--detect-deletions` sweep must not delete a node
 * whose source type this run skipped (skipReport.skips, unreadable included):
 * a skipped source touched nothing, so "untouched" proves nothing about it.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConsoleLogger, asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildJsforceMock } from "../../extractors/live-org/__tests__/_jsforce-mock.js";
import { wrapConnectionReadOnly } from "../../extractors/live-org/read-only-proxy.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { isSkipProtected, skipProtection } from "../detect-deletions-guard.js";
import { liveIngest } from "../live-ingest.js";

const skip = (label: string, category = "unreadable") => ({
  label,
  reason: "x",
  category: category as never,
});
const node = (label: string, sourceUri?: string) => ({
  label,
  attributes: sourceUri ? { sourceUri } : {},
});

describe("skipProtection / isSkipProtected", () => {
  it("no skips protects nothing", () => {
    const p = skipProtection([]);
    expect(p.refuseAll).toBe(false);
    expect(isSkipProtected(p, node("ApexClass", "sf://tooling/ApexClass/A"))).toBe(false);
  });

  it("maps dedicated source labels to their metadata types", () => {
    const p = skipProtection([skip("apex"), skip("security"), skip("object", "transient")]);
    expect(p.refuseAll).toBe(false);
    expect(isSkipProtected(p, node("ApexClass", "sf://tooling/ApexClass/A"))).toBe(true);
    // A method's sourceUri is its class's: protected with it.
    expect(isSkipProtected(p, node("ApexMethod", "sf://tooling/ApexClass/A"))).toBe(true);
    expect(isSkipProtected(p, node("ApexTrigger", "sf://tooling/ApexTrigger/T"))).toBe(true);
    expect(isSkipProtected(p, node("Profile", "sf://metadata/Profile/Admin"))).toBe(true);
    expect(isSkipProtected(p, node("CustomField", "sf://describe/Account"))).toBe(true);
    expect(isSkipProtected(p, node("Flow", "sf://metadata/Flow/F"))).toBe(false);
  });

  it("generic:T, vlocity:T:ns and omnistudio-retrieve:T protect type T", () => {
    const p = skipProtection([
      skip("generic:CustomLabels"),
      skip("vlocity:DataRaptor:vlocity_cmt"),
      skip("vlocity:OmniScript:children:vlocity_cmt"),
      skip("omnistudio-retrieve:OmniUiCard"),
    ]);
    expect(isSkipProtected(p, node("CustomLabel", "sf://00D1/CustomLabels/All"))).toBe(true);
    expect(isSkipProtected(p, node("DataRaptor", "sf://00D1/DataRaptor/D"))).toBe(true);
    expect(isSkipProtected(p, node("OmniScript", "sf://00D1/OmniScript/O"))).toBe(true);
    expect(isSkipProtected(p, node("OmniUiCard", "sf://00D1/OmniUiCard/C.xml"))).toBe(true);
    expect(isSkipProtected(p, node("Layout", "sf://00D1/Layout/L"))).toBe(false);
  });

  it("falls back to the node label when the sourceUri is missing or unparseable", () => {
    const p = skipProtection([skip("generic:Layout")]);
    expect(isSkipProtected(p, node("Layout"))).toBe(true);
    expect(isSkipProtected(p, node("Layout", "weird"))).toBe(true);
    expect(isSkipProtected(p, node("Report"))).toBe(false);
  });

  it("mcd-baseline skips protect nothing; an unknown label refuses the whole sweep", () => {
    expect(skipProtection([skip("mcd-baseline:ApexClass")]).refuseAll).toBe(false);
    expect(skipProtection([skip("discovery")]).refuseAll).toBe(true);
    expect(skipProtection([skip("something-new")]).refuseAll).toBe(true);
  });
});

describe("live-org detect-deletions respects skipReport.skips", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sfg-skipdel-"));
    process.env.SFGRAPH_DETECT_DELETIONS_MAX_DROP_RATIO = "1";
  });
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: env var must be truly unset
    delete process.env.SFGRAPH_DETECT_DELETIONS_MAX_DROP_RATIO;
    rmSync(dir, { recursive: true, force: true });
  });

  async function run(carried: Array<{ label: string; reason: string; category: never }>) {
    const orgId = asOrgId("00Dxx0000000SKIPD");
    const graphStore = new SqliteGraphStore({ dbPath: ":memory:" });
    await graphStore.init();
    const now = Date.now();
    graphStore.upsertOrg({
      id: orgId,
      alias: "t",
      instanceUrl: "https://x",
      apiVersion: "60.0",
      createdAt: now,
    });
    const mk = (name: string) => ({
      orgId,
      qualifiedName: asQualifiedName(`ApexClass:${name}`),
      label: "ApexClass",
      attributes: { name, sourceUri: `sf://tooling/ApexClass/${name}` },
      sourceHash: asSha256("c".repeat(64)),
      firstSeenAt: now,
      lastSeenAt: now,
      lastModifiedAt: now,
    });
    graphStore.mergeNodes([mk("Kept"), mk("Gone")]);
    const skipReportPath = path.join(dir, "skips.json");
    writeFileSync(skipReportPath, JSON.stringify({ orgId, skips: carried }));
    const conn = buildJsforceMock({
      toolingQueryResults: {
        "SELECT Name, NamespacePrefix FROM ApexClass": {
          records: [{ Name: "Kept", NamespacePrefix: null }],
          done: true,
        },
        "SELECT Id, Name, Body, NamespacePrefix, LastModifiedDate, ApiVersion, Status FROM ApexClass":
          {
            records: [
              {
                Id: "01pK",
                Name: "Kept",
                Body: "public class Kept { }",
                LastModifiedDate: "2025-01-01T00:00:00Z",
              },
            ],
            done: true,
          },
      },
    });
    await liveIngest({
      alias: "t",
      graphStore,
      mode: "full",
      preResolved: {
        orgId,
        alias: "t",
        username: "t@example.com",
        instanceUrl: "https://x",
        apiVersion: "60.0",
        conn: wrapConnectionReadOnly(conn),
      },
      logger: new ConsoleLogger("error"),
      skipSnapshot: true,
      detectDeletions: true,
      onlyLabels: new Set(["apex"]),
      skipReportPath,
    });
    return graphStore.getNode(orgId, asQualifiedName("ApexClass:Gone"));
  }

  it("control: an unrelated skipped type does not protect ApexClass", async () => {
    expect(await run([skip("generic:Layout") as never])).toBeNull();
  });

  it("a skip with an unmappable label (discovery) refuses the whole sweep", async () => {
    expect(await run([skip("discovery") as never])).not.toBeNull();
  });
});
