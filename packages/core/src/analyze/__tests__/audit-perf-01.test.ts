import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeFact } from "../../domain/index.js";
import { FilesystemMetadataSource } from "../../extractors/filesystem/index.js";
import { parserRegistry } from "../../parsers/registry.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { analyzeLocalImpact } from "../wip-impact.js";

// audit perf-01: changed-only mode must parse only the changed files, not
// re-parse the whole tree. The fixture makes B.cls unchanged by every sane
// signal (committed in git, mtime before the org's lastSyncedAt) and A.cls
// changed by every signal (dirty in git, mtime after lastSyncedAt).
let dir: string;
let store: SqliteGraphStore;
const orgId = asOrgId("org_perf01");

function seed(qname: string): NodeFact {
  return {
    orgId,
    qualifiedName: asQualifiedName(qname),
    label: "ApexClass",
    attributes: {},
    sourceHash: asSha256("seeded"),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
}
function w(rel: string, c: string): string {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, c, "utf8");
  return abs;
}
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd: dir,
    stdio: "ignore",
  });

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-audit-p01-"));
  store = new SqliteGraphStore({ dbPath: ":memory:" });
  await store.init();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("audit perf-01: changed-only wip parses only changed files", () => {
  it("parses A.cls (changed) and not B.cls (unchanged)", async () => {
    w("sfdx-project.json", JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
    const a = w("force-app/main/default/classes/A.cls", "public class A {}");
    const b = w("force-app/main/default/classes/B.cls", "public class B {}");
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    const syncedAt = Date.now();
    const past = new Date(syncedAt - 3_600_000);
    const future = new Date(syncedAt + 3_600_000);
    utimesSync(b, past, past);
    writeFileSync(a, "public class A { void m() {} }", "utf8");
    utimesSync(a, future, future);
    store.upsertOrg({
      id: orgId,
      alias: "p01",
      instanceUrl: "https://example",
      apiVersion: "60.0",
      createdAt: 1,
      lastSyncedAt: syncedAt,
    });
    store.mergeNodes([seed("ApexClass:A"), seed("ApexClass:B")]);

    const parser = parserRegistry.for("ApexClass");
    if (!parser) throw new Error("ApexClass parser not registered");
    const spy = vi.spyOn(parser, "parse");
    await analyzeLocalImpact({ graphStore: store, orgId, projectRoot: dir, mode: "changed-only" });
    const parsedNames = spy.mock.calls.map((c) => (c[0] as { className?: string }).className ?? "");
    expect(parsedNames).toEqual(["A"]);
  });

  // review M-2: the changed-only selection must not read the tree twice.
  it("reads the source tree once in changed-only mode", async () => {
    w("sfdx-project.json", JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
    const a = w("force-app/main/default/classes/A.cls", "public class A {}");
    w("force-app/main/default/classes/B.cls", "public class B {}");
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    writeFileSync(a, "public class A { void m() {} }", "utf8");
    // T14 batch L: one index walk (iterIndexed), never the full-read iter().
    const iter = vi.spyOn(FilesystemMetadataSource.prototype, "iter");
    const indexed = vi.spyOn(FilesystemMetadataSource.prototype, "iterIndexed");
    const parser = parserRegistry.for("ApexClass");
    if (!parser) throw new Error("ApexClass parser not registered");
    const spy = vi.spyOn(parser, "parse");
    await analyzeLocalImpact({ graphStore: store, orgId, projectRoot: dir, mode: "changed-only" });
    expect(indexed).toHaveBeenCalledTimes(1);
    expect(iter).not.toHaveBeenCalled();
    const parsedNames = spy.mock.calls.map((c) => (c[0] as { className?: string }).className ?? "");
    expect(parsedNames).toEqual(["A"]);
  });
});
