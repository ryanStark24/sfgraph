import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConsoleLogger } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshnessBucket, freshnessScore } from "../../../analyze/freshness.js";
import { liveIngest } from "../../../ingest/live-ingest.js";
import { offlineResolvedOrg } from "../../../ingest/offline-org.js";
import { SqliteGraphStore } from "../../../storage/sqlite/graph-store.js";
import { type GitRunner, execGit } from "../change-times.js";
import { FilesystemMetadataSource } from "../index.js";

/**
 * S-1.8.1-003: `lastModifiedAt` is the file's last commit time (one batched
 * pass), its mtime outside git or when edited since HEAD, never ingest time.
 */

const MD = "force-app/main/default";
const DAY = 86_400_000;
const logger = new ConsoleLogger("error");
let dir: string;
let proj: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-ctimes-"));
  proj = path.join(dir, "proj");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    path.join(proj, "sfdx-project.json"),
    JSON.stringify({ packageDirectories: [{ path: "force-app" }] }),
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function cls(name: string): void {
  const f = path.join(proj, MD, "classes", `${name}.cls`);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, `public class ${name} { public void run() {} }`);
  writeFileSync(
    `${f}-meta.xml`,
    `<?xml version="1.0" encoding="UTF-8"?><ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>60.0</apiVersion><status>Active</status></ApexClass>`,
  );
}

function sh(cmd: string, args: string[], env: Record<string, string> = {}): void {
  execFileSync(cmd, args, {
    cwd: proj,
    stdio: "ignore",
    env: { ...process.env, ...env },
  });
}

/** Commit everything with an author and committer date `daysAgo` days ago. */
function commitAt(daysAgo: number, msg: string): void {
  const iso = new Date(Date.now() - daysAgo * DAY).toISOString();
  sh("git", ["add", "-A"]);
  sh(
    "git",
    ["-c", "user.email=a@example.com", "-c", "user.name=Example User", "commit", "-q", "-m", msg],
    { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
  );
}

async function ingestAndRead(
  git?: GitRunner,
): Promise<Map<string, { bucket: string; ageDays: number }>> {
  const store = new SqliteGraphStore({
    dbPath: path.join(dir, `g-${Math.random().toString(36).slice(2)}.sqlite`),
    backupDir: path.join(dir, "bk"),
  });
  await store.init();
  try {
    await liveIngest({
      alias: "fixture",
      graphStore: store,
      mode: "full",
      rebuild: true,
      preResolved: offlineResolvedOrg(proj, "fixture"),
      metadataSource: new FilesystemMetadataSource(proj, ["force-app"], git ? { git } : {}),
      logger,
      skipSnapshot: true,
      analysisDb: store.db,
    });
    const org = offlineResolvedOrg(proj, "fixture").orgId;
    const out = new Map<string, { bucket: string; ageDays: number }>();
    const now = Date.now();
    for (const n of store.listNodesByLabel(org, "ApexClass", 100)) {
      out.set(String(n.qualifiedName).replace(/^ApexClass:/, ""), {
        bucket: freshnessBucket(freshnessScore(n, now)),
        ageDays: (now - n.lastModifiedAt) / DAY,
      });
    }
    return out;
  } finally {
    await store.close();
  }
}

describe("project ingest: lastModifiedAt from git", () => {
  it("buckets match back-dated commits (2, 45 and 400 days), not ingest time", async () => {
    sh("git", ["init", "-q"]);
    cls("OldService");
    commitAt(400, "old");
    cls("MidService");
    commitAt(45, "mid");
    cls("NewService");
    commitAt(2, "new");

    // A fresh clone / checkout stamps every mtime "now": git must still win.
    const now = new Date();
    for (const n of ["OldService", "MidService", "NewService"]) {
      utimesSync(path.join(proj, MD, "classes", `${n}.cls`), now, now);
    }

    const got = await ingestAndRead();
    expect(got.get("NewService")?.bucket).toBe("hot");
    expect(got.get("MidService")?.bucket).toBe("current");
    expect(got.get("OldService")?.bucket).toBe("dead");
    expect(got.get("NewService")?.ageDays).toBeGreaterThan(1.9);
    expect(got.get("NewService")?.ageDays).toBeLessThan(2.1);
    expect(got.get("OldService")?.ageDays).toBeGreaterThan(399);
  });

  it("a file edited since HEAD counts as its mtime (newest)", async () => {
    sh("git", ["init", "-q"]);
    cls("OldService");
    commitAt(400, "old");
    writeFileSync(
      path.join(proj, MD, "classes", "OldService.cls"),
      "public class OldService { public void run() { Integer x = 1; } }",
    );
    cls("BrandNew"); // untracked
    const got = await ingestAndRead();
    expect(got.get("OldService")?.bucket).toBe("hot");
    expect(got.get("BrandNew")?.bucket).toBe("hot");
  });

  it("a bundle or object folder takes the newest of its files", async () => {
    sh("git", ["init", "-q"]);
    const objDir = path.join(proj, MD, "objects", "Acme_Order__c");
    mkdirSync(path.join(objDir, "fields"), { recursive: true });
    writeFileSync(
      path.join(objDir, "Acme_Order__c.object-meta.xml"),
      `<?xml version="1.0" encoding="UTF-8"?><CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><label>Acme Order</label></CustomObject>`,
    );
    commitAt(400, "object");
    writeFileSync(
      path.join(objDir, "fields", "Total__c.field-meta.xml"),
      `<?xml version="1.0" encoding="UTF-8"?><CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>Total__c</fullName><type>Number</type></CustomField>`,
    );
    commitAt(2, "field");
    const items: Array<{ memberType: string; at: string | null }> = [];
    for await (const m of new FilesystemMetadataSource(proj, ["force-app"]).iter()) {
      items.push({ memberType: m.ref.memberType, at: m.ref.lastModifiedAt });
    }
    const obj = items.find((i) => i.memberType === "CustomObject");
    const ageDays = (Date.now() - Date.parse(obj?.at ?? "0")) / DAY;
    expect(ageDays).toBeGreaterThan(1.9);
    expect(ageDays).toBeLessThan(2.1);
  });

  it("outside git, lastModifiedAt is the file mtime", async () => {
    cls("PlainService");
    cls("AgedService");
    const old = new Date(Date.now() - 200 * DAY);
    for (const f of ["AgedService.cls", "AgedService.cls-meta.xml"]) {
      utimesSync(path.join(proj, MD, "classes", f), old, old);
    }
    const got = await ingestAndRead();
    expect(got.get("PlainService")?.bucket).toBe("hot");
    expect(got.get("AgedService")?.ageDays).toBeGreaterThan(199);
    expect(got.get("AgedService")?.bucket).toBe("stale");
  });

  it("history is read in a few batched calls, not one process per file", async () => {
    sh("git", ["init", "-q"]);
    for (let i = 0; i < 40; i++) cls(`Svc${i}`);
    commitAt(10, "many");
    const calls: string[][] = [];
    const counting: GitRunner = (args, cwd) => {
      calls.push(args);
      return execGit(args, cwd);
    };
    const got = await ingestAndRead(counting);
    expect(got.size).toBe(40);
    // rev-parse, one log, one diff, one ls-files: independent of the file count.
    expect(calls.length).toBeLessThanOrEqual(5);
    expect(calls.filter((a) => a.includes("log")).length).toBe(1);
    expect(got.get("Svc7")?.ageDays).toBeGreaterThan(9.9);
  });
});
