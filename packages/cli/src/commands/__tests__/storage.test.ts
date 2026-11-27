import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SqliteGraphStore,
  SqliteSnapshotStore,
  acquireIngestLock,
  loadBetterSqlite3,
} from "@ryanstark24/sfgraph-core";
import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildStorageReport, exitCodeFor, runClean, runDrop, storageCleanCmd } from "../storage.js";

const A = "00Dxx0000001aaa"; // alias alpha, many snapshots, free pages
const B = "00Dxx0000002bbb"; // alias beta, never synced
const C = "00Dxx0000003ccc"; // only backups left
const DAY = 86_400_000;

let dir: string;
const backups = (): string => path.join(dir, "backups");

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sfgraph-storage-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = 0;
});

function nodes(org: string, round: number, count: number) {
  return Array.from({ length: count }, (_, k) => ({
    orgId: asOrgId(org),
    qualifiedName: asQualifiedName(`Cls${k}`),
    label: "ApexClass",
    attributes: { pad: "z".repeat(300) },
    sourceHash: asSha256(`h${round}-${k}`),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  }));
}

/** A real graph file with `auto` auto snapshots (each changing 200 nodes) and `manual` manual ones. */
async function makeGraph(
  org: string,
  o: { alias: string; auto?: number; manual?: number; syncedDaysAgo?: number | null },
): Promise<string> {
  const file = path.join(dir, `${org}.sqlite`);
  const g = new SqliteGraphStore({ dbPath: file, backupDir: path.join(dir, ".sfgraph-backups") });
  await g.init();
  g.upsertOrg({
    id: asOrgId(org),
    alias: o.alias,
    instanceUrl: "https://x.example.com",
    apiVersion: "60.0",
    createdAt: 1,
    lastSyncedAt: o.syncedDaysAgo == null ? null : Date.now() - o.syncedDaysAgo * DAY,
  });
  const s = new SqliteSnapshotStore({ dbPath: file, db: g.db, skipMigrations: true });
  await s.init();
  for (let i = 0; i < (o.auto ?? 0); i++) {
    g.mergeNodes(nodes(org, i, 200));
    const snap = s.createSnapshot(asOrgId(org), `pre-sync-${i}`, true);
    g.db
      .prepare("UPDATE _sfgraph_snapshots SET created_at = ? WHERE id = ?")
      .run(Date.now() - (100 - i) * 1000, snap.id);
  }
  for (let i = 0; i < (o.manual ?? 0); i++) s.createSnapshot(asOrgId(org), `manual-${i}`, false);
  await g.close();
  return file;
}

function stubBackup(org: string, day: number, bytes = 1000): string {
  mkdirSync(backups(), { recursive: true });
  const f = path.join(
    backups(),
    `${org}.rebuild-2026-01-${String(day).padStart(2, "0")}T00-00-00-000Z.sqlite`,
  );
  writeFileSync(f, Buffer.alloc(bytes, 1));
  return f;
}

/** sha-256 over every path (relative, with size and content) in the tree. */
function treeHash(root: string): string {
  const h = createHash("sha256");
  const walk = (d: string): void => {
    for (const n of readdirSync(d).sort()) {
      const p = path.join(d, n);
      const st = statSync(p);
      h.update(`${path.relative(root, p)}|${st.isDirectory() ? "d" : st.size}\n`);
      if (st.isDirectory()) walk(p);
      else h.update(readFileSync(p));
    }
  };
  walk(root);
  return h.digest("hex");
}

async function fixture(): Promise<void> {
  await makeGraph(A, { alias: "alpha", auto: 8, manual: 1, syncedDaysAgo: 1 });
  await makeGraph(B, { alias: "beta", auto: 0, manual: 0, syncedDaysAgo: null });
  stubBackup(A, 1);
  stubBackup(A, 2);
  stubBackup(C, 3, 500);
  writeFileSync(path.join(backups(), "notes.txt"), "hand-made note");
  mkdirSync(path.join(dir, "embedding-cache"));
  writeFileSync(path.join(dir, "embedding-cache", "m.sqlite"), Buffer.alloc(4000, 2));
}

const aliasOf = (r: { alias: string | null }) => r.alias;

describe("sfgraph storage (report)", () => {
  it("reports graphs, backups, cache and the rest, read-only", async () => {
    await fixture();
    const before = treeHash(dir);
    const r = buildStorageReport(dir);
    expect(treeHash(dir)).toBe(before); // reading leaves no -wal/-shm behind

    expect(r.schemaVersion).toBe(1);
    expect(r.dataDir).toBe(dir);
    expect(r.graphs.map((g) => g.orgId)).toEqual([A, B]);
    const [ga, gb] = r.graphs;
    expect(ga && aliasOf(ga)).toBe("alpha");
    expect(ga?.snapshots).toEqual({ auto: 8, manual: 1 });
    expect(ga?.stale).toBe(false);
    expect(ga?.lastSyncAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(ga?.bytes).toBe(statSync(path.join(dir, `${A}.sqlite`)).size);
    expect(gb?.stale).toBe(true);
    expect(gb?.lastSyncAt).toBeNull();
    expect(r.backups.count).toBe(3);
    expect(r.backups.bytes).toBe(2500);
    expect(r.backups.byOrg.map((o) => [o.orgId, o.count, o.bytes])).toEqual([
      [A, 2, 2000],
      [C, 1, 500],
    ]);
    expect(r.backups.byOrg[0]?.newestAt).toBe("2026-01-02T00:00:00.000Z");
    expect(r.backups.other).toEqual({ count: 1, bytes: "hand-made note".length });
    expect(r.embeddingCache.bytes).toBe(4000);
    expect(r.totalBytes).toBeGreaterThanOrEqual(
      r.graphs.reduce((n, g) => n + g.bytes, 0) + 2500 + 4000,
    );
    expect(r.graphs.every((g) => g.tables === undefined)).toBe(true);
  });

  it("--detail adds the largest tables (dbstat)", async () => {
    await fixture();
    const r = buildStorageReport(dir, { detail: true });
    const t = r.graphs[0]?.tables;
    expect(t?.length).toBeGreaterThan(0);
    expect(t?.[0]?.bytes).toBeGreaterThanOrEqual(t?.[1]?.bytes ?? 0);
    expect(t?.some((x) => x.name.startsWith("_sfgraph_snap"))).toBe(true);
  });

  it("an unreadable graph still reports its file size, with null snapshot counts", async () => {
    writeFileSync(path.join(dir, `${B}.sqlite`), "this is not a database at all, but it has bytes");
    const r = buildStorageReport(dir);
    expect(r.graphs[0]).toMatchObject({
      orgId: B,
      bytes: 47,
      walBytes: 0,
      freeBytes: 0,
      snapshots: { auto: null, manual: null },
      lastSyncAt: null,
      stale: true,
    });
  });

  it("JSON shape (schemaVersion 1)", async () => {
    await fixture();
    const shape = (v: unknown): unknown => {
      if (typeof v === "number") return "<number>";
      if (typeof v === "string") {
        if (v === dir) return "<dataDir>";
        if (v.startsWith(dir)) return `<dataDir>${v.slice(dir.length).replaceAll("\\", "/")}`;
        if (/^\d{4}-\d{2}-\d{2}T/.test(v) && !v.startsWith("2026-01")) return "<iso>";
        return v;
      }
      if (Array.isArray(v)) return v.map(shape);
      if (v && typeof v === "object") {
        return Object.fromEntries(
          Object.entries(v).map(([k, x]) => [k, k === "schemaVersion" ? x : shape(x)]),
        );
      }
      return v;
    };
    expect(shape(JSON.parse(JSON.stringify(buildStorageReport(dir))))).toMatchInlineSnapshot(`
      {
        "backups": {
          "byOrg": [
            {
              "bytes": "<number>",
              "count": "<number>",
              "newestAt": "2026-01-02T00:00:00.000Z",
              "orgId": "00Dxx0000001aaa",
            },
            {
              "bytes": "<number>",
              "count": "<number>",
              "newestAt": "2026-01-03T00:00:00.000Z",
              "orgId": "00Dxx0000003ccc",
            },
          ],
          "bytes": "<number>",
          "count": "<number>",
          "other": {
            "bytes": "<number>",
            "count": "<number>",
          },
        },
        "dataDir": "<dataDir>",
        "embeddingCache": {
          "bytes": "<number>",
        },
        "graphs": [
          {
            "alias": "alpha",
            "bytes": "<number>",
            "file": "<dataDir>/00Dxx0000001aaa.sqlite",
            "freeBytes": "<number>",
            "lastSyncAt": "<iso>",
            "orgId": "00Dxx0000001aaa",
            "snapshots": {
              "auto": "<number>",
              "manual": "<number>",
            },
            "stale": false,
            "walBytes": "<number>",
          },
          {
            "alias": "beta",
            "bytes": "<number>",
            "file": "<dataDir>/00Dxx0000002bbb.sqlite",
            "freeBytes": "<number>",
            "lastSyncAt": null,
            "orgId": "00Dxx0000002bbb",
            "snapshots": {
              "auto": "<number>",
              "manual": "<number>",
            },
            "stale": true,
            "walBytes": "<number>",
          },
        ],
        "otherBytes": "<number>",
        "schemaVersion": 1,
        "totalBytes": "<number>",
      }
    `);
  });
});

describe("sfgraph storage clean", () => {
  it("without --apply changes nothing, whatever the flags", async () => {
    await fixture();
    const before = treeHash(dir);
    for (const o of [
      {},
      { backups: true },
      { snapshots: true, keep: 0 },
      { vacuum: true },
      { backups: true, snapshots: true, vacuum: true, keep: 1 },
    ]) {
      const r = await runClean(o, { dataDir: dir });
      expect(r.applied).toBe(false);
      expect(r.freedBytes).toBe(0);
      expect(
        r.actions.every((a) => a.status === "planned" || a.status === "skipped-low-disk"),
      ).toBe(true);
      expect(treeHash(dir)).toBe(before);
    }
    const r = await runClean({}, { dataDir: dir });
    expect(r.actions.filter((a) => a.kind === "backup")).toHaveLength(3);
    // default keep is 5: 8 auto snapshots -> 3 to go, reported but not removed
    expect(r.actions.find((a) => a.kind === "snapshots")?.detail).toMatch(
      /3 auto snapshots would be removed/,
    );
    // non-matching files are listed, flagged as untouched without --backups
    expect(r.actions.find((a) => a.kind === "other-file")?.detail).toMatch(
      /only removed with --backups/,
    );
  });

  it("--apply default (backups + snapshots) removes backups, prunes snapshots, keeps notes and the live graph", async () => {
    await fixture();
    const r = await runClean({ apply: true, keep: 2 }, { dataDir: dir });
    expect(r.applied).toBe(true);
    expect(exitCodeFor(r)).toBe(0);
    expect(readdirSync(backups()).sort()).toEqual(["notes.txt"]);
    expect(existsSync(path.join(dir, `${A}.sqlite`))).toBe(true);
    expect(existsSync(path.join(dir, `${B}.sqlite`))).toBe(true);
    const snap = r.actions.find((a) => a.kind === "snapshots");
    expect(snap?.status).toBe("done");
    expect(r.freedBytes).toBe(2500);

    const after = buildStorageReport(dir);
    expect(after.graphs[0]?.snapshots).toEqual({ auto: 2, manual: 1 }); // manual stays
    expect(after.graphs[0]?.freeBytes).toBeGreaterThan(0);
    // no lock file left behind
    expect(readdirSync(dir).filter((f) => f.endsWith(".ingest.lock"))).toEqual([]);
  });

  it("--backups --apply also removes files in backups/ that are not rebuild backups; --snapshots alone does not", async () => {
    await fixture();
    await runClean({ snapshots: true, apply: true }, { dataDir: dir });
    expect(readdirSync(backups())).toHaveLength(4);
    const r = await runClean({ backups: true, apply: true }, { dataDir: dir });
    expect(readdirSync(backups())).toEqual([]);
    expect(r.actions.filter((a) => a.kind === "other-file")).toEqual([
      expect.objectContaining({ status: "done", orgId: null }),
    ]);
  });

  it("--org limits to one org (id or alias) and refuses an unknown name", async () => {
    await fixture();
    const r = await runClean({ backups: true, apply: true, org: "ALPHA" }, { dataDir: dir });
    expect(r.actions.every((a) => a.orgId === A)).toBe(true);
    expect(readdirSync(backups()).filter((f) => f.startsWith(C))).toHaveLength(1);
    expect(existsSync(path.join(backups(), "notes.txt"))).toBe(true);
    await expect(runClean({ org: "nope" }, { dataDir: dir })).rejects.toThrow(
      /no graph or backup for 'nope'/,
    );
  });

  it("a held ingest lock skips that org (exit 3) and removes nothing of it", async () => {
    await fixture();
    const lock = acquireIngestLock({ dir, orgId: A });
    try {
      const r = await runClean(
        { backups: true, snapshots: true, keep: 0, apply: true },
        { dataDir: dir },
      );
      const ofA = r.actions.filter((a) => a.orgId === A);
      expect(ofA.length).toBeGreaterThan(0);
      expect(ofA.every((a) => a.status === "skipped-busy")).toBe(true);
      expect(exitCodeFor(r)).toBe(3);
      expect(readdirSync(backups()).filter((f) => f.startsWith(A))).toHaveLength(2);
      expect(buildStorageReport(dir).graphs[0]?.snapshots.auto).toBe(8);
      expect(readdirSync(backups()).some((f) => f.startsWith(C))).toBe(false); // other orgs still cleaned
    } finally {
      lock.release();
    }
  });

  it("a backup the OS reports in use is skipped, not counted as freed (exit 3)", async () => {
    await fixture();
    const busyFile = stubBackup(A, 2);
    const r = await runClean(
      { backups: true, apply: true, org: A },
      {
        dataDir: dir,
        unlink: (p) => {
          if (p === busyFile) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
          rmSync(p, { force: true });
        },
      },
    );
    const busy = r.actions.find((a) => a.path === busyFile);
    expect(busy).toMatchObject({ status: "skipped-in-use", bytes: 0 });
    expect(r.freedBytes).toBe(1000); // only the other backup of A
    expect(exitCodeFor(r)).toBe(3);
    expect(existsSync(busyFile)).toBe(true);
  });

  it("--vacuum shrinks a file with free pages", async () => {
    await fixture();
    await runClean({ snapshots: true, keep: 1, apply: true }, { dataDir: dir });
    const file = path.join(dir, `${A}.sqlite`);
    const before = statSync(file).size;
    const free = buildStorageReport(dir).graphs[0]?.freeBytes ?? 0;
    expect(free).toBeGreaterThan(before / 4);
    const r = await runClean({ vacuum: true, apply: true, org: A }, { dataDir: dir });
    const v = r.actions.find((a) => a.kind === "vacuum");
    expect(v?.status).toBe("done");
    const after = statSync(file).size;
    expect(after).toBeLessThan(before);
    expect(v?.bytes).toBe(before - after);
    expect(r.freedBytes).toBe(before - after);
    expect(buildStorageReport(dir).graphs[0]?.freeBytes).toBe(0);
    expect(buildStorageReport(dir).graphs[0]?.snapshots.auto).toBe(1);
  });

  it("--vacuum is skipped while another connection holds a read transaction", async () => {
    await fixture();
    await runClean({ snapshots: true, keep: 1, apply: true }, { dataDir: dir });
    const file = path.join(dir, `${A}.sqlite`);
    const Ctor = loadBetterSqlite3() as new (
      p: string,
    ) => {
      exec: (s: string) => void;
      prepare: (s: string) => { get: () => unknown };
      close: () => void;
    };
    const reader = new Ctor(file);
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) FROM _sfgraph_snap_nodes").get();
    const before = statSync(file).size;
    try {
      const r = await runClean({ vacuum: true, apply: true, org: A }, { dataDir: dir });
      expect(r.actions.find((a) => a.kind === "vacuum")?.status).toBe("skipped-busy");
      expect(exitCodeFor(r)).toBe(3);
      expect(statSync(file).size).toBe(before);
    } finally {
      reader.exec("ROLLBACK");
      reader.close();
    }
  }, 20_000);

  it("--vacuum is refused when free disk is below twice the file size", async () => {
    await fixture();
    await runClean({ snapshots: true, keep: 1, apply: true }, { dataDir: dir });
    const file = path.join(dir, `${A}.sqlite`);
    const before = statSync(file).size;
    const r = await runClean(
      { vacuum: true, apply: true, org: A },
      { dataDir: dir, freeDiskBytes: () => before * 2 - 1 },
    );
    expect(r.actions.find((a) => a.kind === "vacuum")).toMatchObject({
      status: "skipped-low-disk",
    });
    expect(statSync(file).size).toBe(before);
    const ok = await runClean(
      { vacuum: true, apply: true, org: A },
      { dataDir: dir, freeDiskBytes: () => before * 2 },
    );
    expect(ok.actions.find((a) => a.kind === "vacuum")?.status).toBe("done");
  });

  it("rejects a bad --keep", async () => {
    await expect(runClean({ keep: -1 }, { dataDir: dir })).rejects.toThrow(/--keep/);
  });

  it("prints JSON and sets the exit code through the command", async () => {
    await fixture();
    const lines: string[] = [];
    const orig = console.log;
    console.log = (m: unknown) => {
      lines.push(String(m));
    };
    const prev = process.env.SFGRAPH_DATA_DIR;
    process.env.SFGRAPH_DATA_DIR = dir;
    try {
      await storageCleanCmd({ json: true });
    } finally {
      console.log = orig;
      process.env.SFGRAPH_DATA_DIR = prev;
    }
    const out = JSON.parse(lines.join("\n")) as { schemaVersion: number; applied: boolean };
    expect(out).toMatchObject({ schemaVersion: 1, applied: false });
    expect(process.exitCode).toBe(0);
  });
});

describe("sfgraph storage wiring", () => {
  it("`storage clean --json` and `storage --json` each get their own --json", async () => {
    await fixture();
    const { buildProgram } = await import("../../index.js");
    const prev = process.env.SFGRAPH_DATA_DIR;
    process.env.SFGRAPH_DATA_DIR = dir;
    const out: string[] = [];
    const orig = console.log;
    console.log = (m: unknown) => {
      out.push(String(m));
    };
    try {
      await buildProgram().parseAsync(["node", "sfgraph", "storage", "clean", "--json"]);
      await buildProgram().parseAsync(["node", "sfgraph", "storage", "--json"]);
      await buildProgram().parseAsync(["node", "sfgraph", "storage", "drop", "alpha", "--json"]);
    } finally {
      console.log = orig;
      process.env.SFGRAPH_DATA_DIR = prev;
    }
    const [clean, report, drop] = out.map((o) => JSON.parse(o) as Record<string, unknown>);
    expect(clean).toMatchObject({ schemaVersion: 1, applied: false });
    expect(report).toMatchObject({ schemaVersion: 1, dataDir: dir });
    expect(drop).toMatchObject({ schemaVersion: 1, applied: false });
  });
});

describe("sfgraph storage drop", () => {
  it("refuses an unknown name and changes nothing", async () => {
    await fixture();
    const before = treeHash(dir);
    await expect(runDrop("gamma", { apply: true }, { dataDir: dir })).rejects.toThrow(
      /no graph or backup/,
    );
    expect(treeHash(dir)).toBe(before);
  });

  it("a dry run changes nothing", async () => {
    await fixture();
    const before = treeHash(dir);
    const r = await runDrop("alpha", {}, { dataDir: dir });
    expect(r.applied).toBe(false);
    expect(r.actions.map((a) => [a.kind, a.status])).toEqual([
      ["graph", "planned"],
      ["backup", "planned"],
      ["backup", "planned"],
    ]);
    expect(treeHash(dir)).toBe(before);
  });

  it("--apply removes the graph, its sidecars and its backups, and nothing else", async () => {
    await fixture();
    writeFileSync(path.join(dir, `${A}.sqlite-wal`), "w");
    writeFileSync(path.join(dir, `${A}.rebuild-pending.json`), "{}");
    writeFileSync(path.join(backups(), `${A}.rebuild-2026-01-02T00-00-00-000Z.sqlite-wal`), "w");
    const r = await runDrop("alpha", { apply: true }, { dataDir: dir });
    expect(r.actions.every((a) => a.status === "done")).toBe(true);
    expect(readdirSync(dir).filter((f) => f.startsWith(A))).toEqual([]);
    expect(readdirSync(backups()).sort()).toEqual([
      `${C}.rebuild-2026-01-03T00-00-00-000Z.sqlite`,
      "notes.txt",
    ]);
    expect(existsSync(path.join(dir, `${B}.sqlite`))).toBe(true);
    expect(r.freedBytes).toBeGreaterThan(2000);
  });

  it("an org with only backups left can be named by id", async () => {
    await fixture();
    const r = await runDrop(C, { apply: true }, { dataDir: dir });
    expect(r.actions.map((a) => a.kind)).toEqual(["backup"]);
    expect(readdirSync(backups()).some((f) => f.startsWith(C))).toBe(false);
  });

  it("is refused while the org's ingest lock is held", async () => {
    await fixture();
    const lock = acquireIngestLock({ dir, orgId: A });
    try {
      const r = await runDrop("alpha", { apply: true }, { dataDir: dir });
      expect(r.actions.every((a) => a.status === "skipped-busy")).toBe(true);
      expect(exitCodeFor(r)).toBe(3);
      expect(existsSync(path.join(dir, `${A}.sqlite`))).toBe(true);
    } finally {
      lock.release();
    }
  });
});
