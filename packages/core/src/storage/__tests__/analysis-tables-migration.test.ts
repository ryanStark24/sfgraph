import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, MigrationRunner } from "../sqlite/migrations.js";

describe("v5 analysis tables migration", () => {
  it("applies v5 and creates the four tables", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "v5-"));
    const db = new Database(path.join(dir, "x.sqlite"));
    new MigrationRunner(db, MIGRATIONS, {
      backupDir: path.join(dir, "bk"),
      retainBackups: 1,
    }).applyPending();
    const v = db.prepare("SELECT MAX(version) AS v FROM _sfgraph_schema_version").get() as {
      v: number;
    };
    expect(v.v).toBe(7);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '_sfgraph_%'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "_sfgraph_findings",
        "_sfgraph_dead_code_scores",
        "_sfgraph_governor_risks",
        "_sfgraph_test_coverage",
      ]),
    );
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("enforces composite PK semantics on _sfgraph_findings", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "v5-"));
    const db = new Database(path.join(dir, "x.sqlite"));
    new MigrationRunner(db, MIGRATIONS, {
      backupDir: path.join(dir, "bk"),
      retainBackups: 1,
    }).applyPending();
    const ins = db.prepare(
      "INSERT INTO _sfgraph_findings(org_id, qualified_name, rule_id, line, severity, message, computed_at) VALUES (?,?,?,?,?,?,?)",
    );
    ins.run("o", "ApexClass:X", "r1", -1, "high", "m", 1);
    expect(() => ins.run("o", "ApexClass:X", "r1", -1, "high", "m", 2)).toThrow();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
