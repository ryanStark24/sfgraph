import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ErrorCode, SfgraphError } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock sqlite-vec so load() throws a real (non-"already loaded") error.
vi.mock("sqlite-vec", async () => {
  return {
    load: (_db: unknown) => {
      throw new Error("simulated extension load failure: cannot open shared object");
    },
  };
});

import { SqliteVectorStore } from "../sqlite/vector-store.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-vec-fail-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("SqliteVectorStore extension-load failure", () => {
  it("throws E_VECTOR_EXTENSION when sqlite-vec cannot be loaded", async () => {
    const store = new SqliteVectorStore({
      dbPath: path.join(workDir, "v.sqlite"),
      backupDir: path.join(workDir, "bkp"),
      // skipMigrations so we don't try to create vec0 tables (which would
      // already fail). We're testing that init() rethrows the load error.
      skipMigrations: true,
    });
    let caught: unknown;
    try {
      await store.init();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SfgraphError);
    expect((caught as SfgraphError).code).toBe(ErrorCode.E_VECTOR_EXTENSION);
  });
});
