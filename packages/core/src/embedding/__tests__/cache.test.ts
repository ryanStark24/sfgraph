import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmbeddingCache, embeddingCachePath } from "../cache.js";

const require = createRequire(import.meta.url);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-ecache-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function vec(seed: number, dim = 4): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.fround(seed + i / 7);
  return v;
}

describe("embeddingCachePath", () => {
  it("lives at <dataDir>/embedding-cache/<modelId>.sqlite with the id made filename-safe", () => {
    expect(embeddingCachePath("/d", "Xenova/all-MiniLM-L6-v2")).toBe(
      path.join("/d", "embedding-cache", "Xenova_all-MiniLM-L6-v2.sqlite"),
    );
    // "@" separates the model id from its weights fingerprint / token cap.
    expect(path.basename(embeddingCachePath("/d", "Xenova/m@0123abcd@512"))).toBe(
      "Xenova_m@0123abcd@512.sqlite",
    );
    // Path separators and traversal cannot escape the cache dir.
    const p = embeddingCachePath("/d", "../../etc/x");
    expect(path.dirname(p)).toBe(path.join("/d", "embedding-cache"));
  });
});

describe("EmbeddingCache", () => {
  it("round-trips vectors byte-for-byte, keyed by text sha256, and persists across reopen", () => {
    const file = embeddingCachePath(dir, "m/one");
    const c = EmbeddingCache.open(file);
    expect(existsSync(file)).toBe(true);
    const a = vec(1);
    const b = vec(2);
    c.putMany([
      { hash: "ha", vector: a },
      { hash: "hb", vector: b },
    ]);
    c.close();

    const c2 = EmbeddingCache.open(file);
    const got = c2.getMany(["ha", "hb", "missing"], 4);
    expect(got.size).toBe(2);
    expect(Buffer.from((got.get("ha") as Float32Array).buffer)).toEqual(Buffer.from(a.buffer));
    expect(Buffer.from((got.get("hb") as Float32Array).buffer)).toEqual(Buffer.from(b.buffer));
    expect(c2.count()).toBe(2);
    c2.close();
  });

  it("only grows: a second put for the same hash keeps the first vector", () => {
    const c = EmbeddingCache.open(embeddingCachePath(dir, "m"));
    c.putMany([{ hash: "h", vector: vec(1) }]);
    c.putMany([{ hash: "h", vector: vec(9) }]);
    const got = c.getMany(["h"], 4).get("h") as Float32Array;
    expect(Array.from(got)).toEqual(Array.from(vec(1)));
    c.close();
  });

  it("treats a dim mismatch as a miss", () => {
    const c = EmbeddingCache.open(embeddingCachePath(dir, "m"));
    c.putMany([{ hash: "h", vector: vec(1, 4) }]);
    expect(c.getMany(["h"], 8).size).toBe(0);
    c.close();
  });

  it("returned vectors do not alias each other's memory", () => {
    const c = EmbeddingCache.open(embeddingCachePath(dir, "m"));
    c.putMany([
      { hash: "a", vector: vec(1) },
      { hash: "b", vector: vec(2) },
    ]);
    const got = c.getMany(["a", "b"], 4);
    (got.get("a") as Float32Array)[0] = 99;
    expect((got.get("b") as Float32Array)[0]).toBe(Math.fround(2));
    expect(c.getMany(["a"], 4).get("a")?.[0]).toBe(Math.fround(1));
    c.close();
  });
});

describe("EmbeddingCache open under contention (m-10)", () => {
  it("sets busy_timeout before switching to WAL, so a briefly locked file does not fail the open", async () => {
    const file = path.join(dir, "locked.sqlite");
    new Database(file).close(); // fresh file, rollback-journal mode
    // Another process holds an exclusive lock for 400 ms.
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const D = require(${JSON.stringify(require.resolve("better-sqlite3"))});
         const db = new D(${JSON.stringify(file)});
         db.exec("BEGIN EXCLUSIVE");
         process.stdout.write("locked\\n");
         setTimeout(() => { db.exec("COMMIT"); db.close(); }, 400);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise<void>((resolve) => child.stdout?.once("data", () => resolve()));
    const c = EmbeddingCache.open(file);
    c.putMany([{ hash: "h", vector: vec(1) }]);
    expect(c.getMany(["h"], 4).size).toBe(1);
    c.close();
    await new Promise((r) => child.once("exit", r));
  }, 15_000);
});
