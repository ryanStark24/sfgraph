import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { BetterSqlite3Database } from "../storage/interfaces.js";

/**
 * Persistent text → vector cache, kept OUTSIDE the graph DB so `--rebuild`
 * (which wipes the graph DB) reuses the vectors of unchanged texts.
 *
 * One file per model: `<dataDir>/embedding-cache/<key>.sqlite`, table
 * `vectors(text_sha256 PRIMARY KEY, dim, vector BLOB)`. The CLI's key is
 * `<modelId>@<model file sha256 prefix>[@<token cap>]`, and the row key is the
 * SHA-256 of the exact embedded text, so a hit returns the bytes the same
 * weights produced for the same text. Inserts are
 * `OR IGNORE`: the cache only grows and an entry never changes once written.
 */
export interface EmbeddingCacheLike {
  getMany(hashes: readonly string[], dim: number): Map<string, Float32Array>;
  putMany(entries: ReadonlyArray<{ hash: string; vector: Float32Array }>): void;
}

/** `<dataDir>/embedding-cache/<safe key>.sqlite`. Every character outside
 *  `[A-Za-z0-9._@-]` becomes `_` and leading dots are stripped, so a model id
 *  such as `Xenova/all-MiniLM-L6-v2` maps to one file in the cache dir and no
 *  id can escape it. */
export function embeddingCachePath(dataDir: string, modelId: string): string {
  const safe = modelId.replace(/[^A-Za-z0-9._@-]/g, "_").replace(/^\.+/, "") || "model";
  return path.join(dataDir, "embedding-cache", `${safe}.sqlite`);
}

export class EmbeddingCache implements EmbeddingCacheLike {
  private readonly getStmt;
  private readonly putTx: (entries: ReadonlyArray<{ hash: string; vector: Float32Array }>) => void;

  private constructor(private readonly db: BetterSqlite3Database) {
    // busy_timeout first, so switching to WAL waits out another process's
    // lock instead of failing. (better-sqlite3 already defaults to a 5 s
    // timeout at construction; open() also passes it explicitly.)
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS vectors (
         text_sha256 TEXT PRIMARY KEY,
         dim INTEGER NOT NULL,
         vector BLOB NOT NULL
       ) WITHOUT ROWID`,
    );
    this.getStmt = this.db.prepare("SELECT dim, vector FROM vectors WHERE text_sha256 = ?");
    const put = this.db.prepare(
      "INSERT OR IGNORE INTO vectors(text_sha256, dim, vector) VALUES (?, ?, ?)",
    );
    this.putTx = this.db.transaction(
      (entries: ReadonlyArray<{ hash: string; vector: Float32Array }>) => {
        for (const e of entries) {
          put.run(
            e.hash,
            e.vector.length,
            Buffer.from(e.vector.buffer, e.vector.byteOffset, e.vector.byteLength),
          );
        }
      },
    );
  }

  /** Open (creating the directory and table if needed). Throws on failure. */
  static open(file: string): EmbeddingCache {
    mkdirSync(path.dirname(file), { recursive: true });
    return new EmbeddingCache(
      new Database(file, { timeout: 5000 }) as unknown as BetterSqlite3Database,
    );
  }

  /** Cached vectors for the given hashes; entries of another dim are misses.
   *  Each returned vector owns a fresh copy of its bytes. */
  getMany(hashes: readonly string[], dim: number): Map<string, Float32Array> {
    const out = new Map<string, Float32Array>();
    for (const h of hashes) {
      if (out.has(h)) continue;
      const row = this.getStmt.get(h) as { dim: number; vector: Buffer } | undefined;
      if (!row || row.dim !== dim || row.vector.byteLength !== dim * 4) continue;
      const v = new Float32Array(dim);
      new Uint8Array(v.buffer).set(row.vector);
      out.set(h, v);
    }
    return out;
  }

  putMany(entries: ReadonlyArray<{ hash: string; vector: Float32Array }>): void {
    if (entries.length > 0) this.putTx(entries);
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM vectors").get() as { c: number }).c;
  }

  close(): void {
    this.db.close();
  }
}
