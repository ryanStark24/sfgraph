import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asOrgId } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteGraphStore } from "../sqlite/graph-store.js";

/** The data folder is created 0700, and graph, -wal/-shm and backup files 0600 (POSIX). */

const posix = process.platform !== "win32";
const mode = (p: string): number => statSync(p).mode & 0o777;

let base: string;
beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "sfg-modes-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe.skipIf(!posix)("stored file modes", () => {
  it("creates the data folder 0700 and the graph file 0600, under a permissive umask", async () => {
    const dataDir = path.join(base, "data");
    const dbPath = path.join(dataDir, "00DXX0000001abcEAA.sqlite");
    const old = process.umask(0o022);
    try {
      const g = new SqliteGraphStore({ dbPath, backupDir: path.join(dataDir, "backups") });
      await g.init();
      g.upsertOrg({
        id: asOrgId("00DXX0000001abcEAA"),
        alias: "dev",
        instanceUrl: "https://example.my.salesforce.com",
        apiVersion: "62.0",
        createdAt: Date.now(),
      });
      expect(mode(dataDir)).toBe(0o700);
      expect(mode(dbPath)).toBe(0o600);
      for (const s of ["-wal", "-shm"]) {
        if (readdirSync(dataDir).includes(`00DXX0000001abcEAA.sqlite${s}`)) {
          expect(mode(`${dbPath}${s}`)).toBe(0o600);
        }
      }
      await g.close();
    } finally {
      process.umask(old);
    }
  });
});
