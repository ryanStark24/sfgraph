import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rebuildWithNocase } from "../sqlite/migrations.js";

let workDir: string;
// biome-ignore lint/suspicious/noExplicitAny: better-sqlite3 instance
let db: any;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-rebuild-"));
  db = new Database(path.join(workDir, "legacy.sqlite"));
});
afterEach(() => {
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("rebuildWithNocase — upgrading a legacy (case-sensitive) table", () => {
  it("adds COLLATE NOCASE, collapses case-duplicate rows, preserves the secondary index", () => {
    // A legacy node-style table created the OLD way: no COLLATE on qualified_name.
    db.exec(`
      CREATE TABLE _sfg_n_CustomObject (
        org_id TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        attributes TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        last_modified_at INTEGER NOT NULL,
        PRIMARY KEY(org_id, qualified_name)
      );
      CREATE INDEX _sfg_n_CustomObject_org ON _sfg_n_CustomObject(org_id);
    `);
    // Two rows that differ only by case — legal under the case-sensitive PK.
    const ins = db.prepare("INSERT INTO _sfg_n_CustomObject VALUES (?, ?, '{}', 'h', 1, 1, 1)");
    ins.run("o", "CustomObject:Account");
    ins.run("o", "CustomObject:account");
    expect(db.prepare("SELECT COUNT(*) c FROM _sfg_n_CustomObject").get().c).toBe(2);

    rebuildWithNocase(db, "_sfg_n_CustomObject", ["qualified_name"]);

    // Case-duplicate collapsed to one row (first-seen wins).
    expect(db.prepare("SELECT COUNT(*) c FROM _sfg_n_CustomObject").get().c).toBe(1);
    // Collation is now NOCASE: a differently-cased lookup matches.
    const hit = db
      .prepare("SELECT qualified_name q FROM _sfg_n_CustomObject WHERE qualified_name = ?")
      .get("CUSTOMOBJECT:ACCOUNT");
    expect(hit?.q).toBe("CustomObject:Account");
    // Inserting a case variant now violates the NOCASE PK (proves the rebuild took).
    expect(() => ins.run("o", "customobject:ACCOUNT")).toThrow();
    // Secondary index survived the rebuild.
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='_sfg_n_CustomObject_org'",
      )
      .get();
    expect(idx).toBeTruthy();
  });

  it("is a no-op on an already-NOCASE table", () => {
    db.exec(
      "CREATE TABLE t (org_id TEXT, qualified_name TEXT COLLATE NOCASE, PRIMARY KEY(org_id, qualified_name))",
    );
    db.prepare("INSERT INTO t VALUES ('o','X:a')").run();
    rebuildWithNocase(db, "t", ["qualified_name"]);
    expect(db.prepare("SELECT COUNT(*) c FROM t").get().c).toBe(1);
  });
});
