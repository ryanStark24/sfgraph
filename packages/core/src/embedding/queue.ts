import { createHash } from "node:crypto";
import type { OrgId, QualifiedName, Sha256 } from "@ryanstark24/sfgraph-shared";
import { asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import type { EmbeddingCacheLike } from "./cache.js";

/** Real SHA-256 of the embedded text. The vector store dedups on this hash
 *  (skips re-embedding when it matches), so it MUST reflect the actual text —
 *  otherwise re-ingest never refreshes a vector. Previously this was
 *  `asSha256("rule:" + qname)`, but asSha256 is a branded-type CAST, not a
 *  hash, so the value was constant per node and every vector was write-once
 *  (config-value enrichment, description changes, etc. never re-embedded). */
export function hashEmbedText(text: string): Sha256 {
  return asSha256(createHash("sha256").update(text).digest("hex"));
}

/** True when every component is 0 — the embedder's zero-vector failure
 *  fallback. Such vectors must not enter the index (they outrank real matches). */
function isAllZero(v: Float32Array): boolean {
  for (let i = 0; i < v.length; i++) if (v[i] !== 0) return false;
  return true;
}

export interface EmbeddingItem {
  qname: string;
  text: string;
  orgId: string;
  label: string;
}

export interface VectorSink {
  upsertNodeVector(
    orgId: OrgId,
    qname: QualifiedName,
    label: string,
    vector: Float32Array,
    contentHash: Sha256,
  ): unknown;
  /**
   * Remove a node's stored vector (+ meta) when the node is deleted, so it
   * stops surfacing as a phantom find_similar hit. Optional: lightweight test
   * sinks may omit it; callers must feature-detect before invoking.
   */
  deleteNodeVector?(orgId: OrgId, qname: QualifiedName): unknown;
  /**
   * The content_hash of the node's stored vector, or null if none. Used to skip
   * the (expensive) embedding model entirely when the text is unchanged — not
   * just the DB write. Optional: sinks that don't implement it fall back to
   * always embedding.
   */
  getContentHash?(orgId: OrgId, qname: QualifiedName): Sha256 | null;
}

export interface EmbeddingQueueOpts {
  vectorStore: VectorSink;
  batchSize?: number;
  onError?: (err: Error) => void;
  /** Override embedding function — primarily for tests, and how ingest plugs
   *  in the worker-thread pool. */
  embed?: (texts: string[]) => Promise<Float32Array[]>;
  /** Persistent text → vector cache consulted before the model. */
  cache?: EmbeddingCacheLike;
  /** Vector dimension expected from the cache (default SFGRAPH_EMBED_MODEL_DIM or 384). */
  dim?: number;
  /**
   * Batches dispatched to `embed` but not yet written. Default 1, which keeps
   * the in-process embedder strictly serial (concurrent calls into the
   * transformers runtime are unsafe/slow). The worker pool runs batches one
   * at a time in its own thread, so ingest raises this to keep it fed while the
   * main thread is busy.
   */
  maxInFlight?: number;
  /**
   * Backpressure bound on queued text (buffered + in flight), in UTF-16 code
   * units. Above it, partial batches are dispatched and `waitForCapacity()`
   * blocks the producer. Default 64M (at most ~128 MB of text).
   */
  maxPendingChars?: number;
  /**
   * Start held: buffer pushes and run no model calls (not even full batches)
   * until `release()`, except what backpressure forces out. Ingest holds the
   * queue until "graph ready" so inference never competes for CPU with the
   * graph build.
   */
  hold?: boolean;
  /**
   * Called once, the first time the queue has real vector work: an item that
   * survives the unchanged check at dispatch, or live items dropped by
   * abandon(). Ingest uses it to set the org's embeddings_pending flag
   * lazily, so a re-sync with nothing to embed never turns off the
   * find_similar vector leg.
   */
  onWork?: () => void;
  /**
   * Persistent-cache write failures (SQLITE_BUSY, disk full, ...). These are
   * not embedding failures: the graph's vectors were written. Default: a
   * console warning.
   */
  onCacheError?: (err: Error) => void;
}

export interface EmbeddingQueueStats {
  /** Vectors served from the persistent cache (no model call). */
  cached: number;
  /** Texts sent to the model successfully. */
  computed: number;
  /** Items skipped because the stored vector already matches the text. */
  unchanged: number;
  /** Texts whose model call failed (left unembedded). */
  failed: number;
  /** Emissions dropped because a later emission of the same (org, qname)
   *  replaced them before they were written. */
  superseded: number;
}

/** A queued emission and its sequence number within its (org, qname) key. */
interface QueuedItem extends EmbeddingItem {
  key: string;
  seq: number;
}

interface PreparedEntry {
  item: QueuedItem;
  hash: Sha256;
}

/** Copy a string into fresh flat storage. Embed texts are concatenations with
 *  `snippet.slice(0, 4000)`; V8 keeps such cons/sliced strings pointing at the
 *  whole parent source, so a queued text could pin an entire file. */
function flatten(s: string): string {
  return ` ${s}`.slice(1);
}

/**
 * Batched embedding queue. push() accumulates; each full batch (or any partial
 * batch once draining / over capacity) is dispatched to `embed`, up to
 * `maxInFlight` at a time. drain() awaits the queue to empty.
 *
 * Last-writer-wins: every push of an (org, qname) gets a sequence number and
 * supersedes all earlier pushes of that key. A superseded emission is never
 * embedded if it is still buffered, and never written (to the vector store or
 * the cache) if it is already in flight. The "unchanged" check (stored hash
 * equals the text hash) runs at dispatch and only for the latest emission;
 * skipping it settles the key, so an earlier, different text still in flight
 * is discarded rather than written over it. The vector store therefore ends
 * with the last emission's vector and hash, whatever the batching or
 * completion order.
 *
 * When the underlying embedder fails (e.g. transformers missing, worker
 * crash), the queue reports via onError and skips those vector upserts —
 * ingest must not crash because embeddings are unavailable.
 */
export class EmbeddingQueue {
  private buffer: QueuedItem[] = [];
  /** Latest sequence number per outstanding (org, qname). An entry is removed
   *  once that latest emission is written, skipped or dropped, so a missing
   *  key means every queued emission of it is superseded. */
  private latestSeq = new Map<string, number>();
  private seq = 0;
  private workSignalled = false;
  private bufferChars = 0;
  private inFlight = 0;
  private inFlightItems = 0;
  private inFlightChars = 0;
  private writeTail: Promise<void> = Promise.resolve();
  private draining = false;
  private held: boolean;
  private generation = 0;
  private capacityWaiters: Array<() => void> = [];
  private readonly batchSize: number;
  private readonly maxInFlight: number;
  private readonly maxPendingChars: number;
  private readonly dim: number;
  private readonly embedFn: (texts: string[]) => Promise<Float32Array[]>;
  readonly stats: EmbeddingQueueStats = {
    cached: 0,
    computed: 0,
    unchanged: 0,
    failed: 0,
    superseded: 0,
  };

  constructor(private readonly opts: EmbeddingQueueOpts) {
    // 64 (was 16): fewer model calls; embedTexts length-sorts and sub-batches
    // internally, so the larger flush does not inflate padding.
    this.batchSize = opts.batchSize ?? 64;
    this.maxInFlight = Math.max(1, opts.maxInFlight ?? 1);
    this.maxPendingChars = opts.maxPendingChars ?? 64 * 1024 * 1024;
    this.dim = opts.dim ?? (Number.parseInt(process.env.SFGRAPH_EMBED_MODEL_DIM ?? "", 10) || 384);
    this.embedFn = opts.embed ?? defaultEmbed;
    this.held = opts.hold ?? false;
  }

  /** Lift `hold`: dispatch everything buffered (subject to maxInFlight). */
  release(): void {
    this.held = false;
    this.pump();
  }

  push(item: EmbeddingItem): void {
    // Supersede every earlier emission of this (org, qname). Cheap on purpose:
    // push runs on the graph-build path; hashing and the stored-hash lookup
    // wait for dispatch.
    const key = `${item.orgId}\u0000${item.qname}`;
    const seq = ++this.seq;
    this.latestSeq.set(key, seq);
    const text = flatten(item.text);
    this.buffer.push({ qname: item.qname, text, orgId: item.orgId, label: item.label, key, seq });
    this.bufferChars += text.length;
    this.pump();
  }

  private signalWork(): void {
    if (this.workSignalled) return;
    this.workSignalled = true;
    this.opts.onWork?.();
  }

  private isLatest(q: QueuedItem): boolean {
    return this.latestSeq.get(q.key) === q.seq;
  }

  /** The latest emission of its key is done (written, failed or dropped). */
  private settle(q: QueuedItem): void {
    if (this.isLatest(q)) this.latestSeq.delete(q.key);
  }

  /**
   * Settle every buffered item that needs no model call: drop superseded and
   * unchanged ones, and write those whose vector is in the persistent cache.
   * Only items that need inference stay buffered. Lets a no-wait run persist
   * the cheap part of its work before abandoning the rest. Returns the number
   * of vectors written.
   */
  flushCached(): number {
    if (this.buffer.length === 0) return 0;
    const batch = this.buffer;
    this.buffer = [];
    this.bufferChars = 0;
    const { entries, vectors, misses } = this.prepare(batch);
    let written = 0;
    const missSet = new Set(misses);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i] as PreparedEntry;
      if (missSet.has(i)) {
        this.buffer.push(e.item);
        this.bufferChars += e.item.text.length;
        continue;
      }
      if (this.writeOne(e, vectors[i] as Float32Array)) written += 1;
      this.settle(e.item);
    }
    this.notifyCapacity();
    return written;
  }

  /** Flush everything (including a partial batch) in the background. */
  startDrain(): void {
    this.draining = true;
    this.pump();
  }

  async drain(): Promise<void> {
    this.draining = true;
    try {
      this.pump();
      if (this.held) this.release();
      while (this.inFlight > 0 || this.buffer.length > 0) {
        await this.writeTail;
        this.pump();
      }
    } finally {
      this.draining = false;
    }
  }

  /** Drop all buffered and in-flight work (their results are discarded).
   *  Returns the number of items dropped. */
  abandon(): number {
    const dropped = this.buffer.filter((q) => this.isLatest(q)).length + this.inFlightItems;
    if (dropped > 0) this.signalWork();
    this.generation += 1;
    this.buffer = [];
    this.bufferChars = 0;
    this.latestSeq.clear();
    this.notifyCapacity();
    return dropped;
  }

  /** True when queued text exceeds the backpressure bound. */
  get overCapacity(): boolean {
    return this.bufferChars + this.inFlightChars > this.maxPendingChars;
  }

  /** Resolves once queued text is back under the backpressure bound. */
  waitForCapacity(): Promise<void> {
    if (!this.overCapacity) return Promise.resolve();
    this.pump();
    return new Promise((resolve) => this.capacityWaiters.push(resolve));
  }

  /** Test introspection: buffered (not yet dispatched) items. */
  get pending(): number {
    return this.buffer.length;
  }

  /** Buffered plus in-flight items. */
  get outstanding(): number {
    return this.buffer.length + this.inFlightItems;
  }

  /**
   * Task 11c N-1: true when some outstanding item will still write a vector
   * (in flight, or a latest buffered emission whose stored vector differs).
   * Stops at the first one; hashes buffered texts, so call it once, off the
   * per-member path.
   */
  hasVectorWork(): boolean {
    if (this.inFlightItems > 0) return true;
    const sink = this.opts.vectorStore;
    const getHash =
      typeof sink.getContentHash === "function" ? sink.getContentHash.bind(sink) : null;
    for (const b of this.buffer) {
      if (!this.isLatest(b)) continue;
      if (!getHash) return true;
      if (getHash(b.orgId as unknown as OrgId, asQualifiedName(b.qname)) !== hashEmbedText(b.text))
        return true;
    }
    return false;
  }

  private notifyCapacity(): void {
    if (this.capacityWaiters.length === 0 || this.overCapacity) return;
    const ws = this.capacityWaiters;
    this.capacityWaiters = [];
    for (const w of ws) w();
  }

  private pump(): void {
    while (
      this.inFlight < this.maxInFlight &&
      this.buffer.length > 0 &&
      (this.overCapacity || (!this.held && (this.draining || this.buffer.length >= this.batchSize)))
    ) {
      this.dispatch();
    }
  }

  private dispatch(): void {
    const batch = this.buffer.splice(0, this.batchSize);
    let chars = 0;
    for (const b of batch) chars += b.text.length;
    this.bufferChars -= chars;
    this.inFlight += 1;
    this.inFlightItems += batch.length;
    this.inFlightChars += chars;
    const gen = this.generation;

    // Prepare synchronously: hash, skip unchanged, consult the cache.
    let entries: PreparedEntry[] = [];
    let vectors: Array<Float32Array | undefined> = [];
    let misses: number[] = [];
    let inference: Promise<Float32Array[]> = Promise.resolve([]);
    try {
      ({ entries, vectors, misses } = this.prepare(batch));
      // Cache hits are written now: with sequence-based supersede the write
      // order no longer matters, and this keeps them out of abandon().
      const missSet = new Set(misses);
      for (let i = 0; i < entries.length; i++) {
        if (missSet.has(i)) continue;
        const e = entries[i] as PreparedEntry;
        this.writeOne(e, vectors[i] as Float32Array);
        this.settle(e.item);
      }
      if (misses.length > 0) {
        // Length-sort (stable) for inference only, to cut padding.
        misses.sort((a, b) => {
          const d =
            (entries[a] as PreparedEntry).item.text.length -
            (entries[b] as PreparedEntry).item.text.length;
          return d !== 0 ? d : a - b;
        });
        inference = this.embedFn(misses.map((i) => (entries[i] as PreparedEntry).item.text));
      }
    } catch (e) {
      inference = Promise.reject(e);
    }
    // Observed below; this stops an early rejection being reported as unhandled
    // while earlier batches are still writing.
    inference.catch(() => {});

    this.writeTail = this.writeTail.then(async () => {
      try {
        let sorted: Float32Array[] | null = null;
        try {
          sorted = await inference;
        } catch (e) {
          if (gen === this.generation) {
            this.stats.failed += misses.length;
            this.opts.onError?.(e as Error);
          }
        }
        if (gen !== this.generation) return;
        const computed: Array<{ hash: string; vector: Float32Array }> = [];
        try {
          if (sorted) this.stats.computed += misses.length;
          // Emission order within the batch (misses are length-sorted).
          const order = [...misses].sort((a, b) => a - b);
          const byIndex = new Map<number, Float32Array | undefined>();
          misses.forEach((i, k) => byIndex.set(i, sorted?.[k]));
          for (const i of order) {
            const e = entries[i] as PreparedEntry;
            const v = byIndex.get(i);
            if (v && this.isLatest(e.item)) {
              if (this.writeOne(e, v)) computed.push({ hash: e.hash, vector: v });
            } else if (v) {
              this.stats.superseded += 1;
            }
            this.settle(e.item);
          }
        } catch (e) {
          this.opts.onError?.(e as Error);
        }
        // Separate from the vector writes: a cache failure is not an embedding
        // failure (every vector above already reached the graph).
        if (computed.length > 0 && this.opts.cache) {
          try {
            this.opts.cache.putMany(computed);
          } catch (e) {
            const onCacheError =
              this.opts.onCacheError ??
              ((err: Error) => console.warn(`embedding cache write failed: ${err.message}`));
            onCacheError(e as Error);
          }
        }
      } finally {
        this.inFlight -= 1;
        this.inFlightItems -= batch.length;
        this.inFlightChars -= chars;
        this.notifyCapacity();
        this.pump();
      }
    });
  }

  private prepare(batch: QueuedItem[]): {
    entries: PreparedEntry[];
    vectors: Array<Float32Array | undefined>;
    misses: number[];
  } {
    const sink = this.opts.vectorStore;
    const getHash =
      typeof sink.getContentHash === "function" ? sink.getContentHash.bind(sink) : null;
    const entries: PreparedEntry[] = [];
    for (const b of batch) {
      // Drop emissions a later push already replaced: never embed them.
      if (!this.isLatest(b)) {
        this.stats.superseded += 1;
        continue;
      }
      // Pre-embed dedup: skip the model when the stored vector already
      // matches this (latest) text. Settling the key makes any earlier,
      // different emission still in flight a no-op at write time.
      const hash = hashEmbedText(b.text);
      if (getHash && getHash(b.orgId as unknown as OrgId, asQualifiedName(b.qname)) === hash) {
        this.stats.unchanged += 1;
        this.settle(b);
        continue;
      }
      entries.push({ item: b, hash });
    }
    if (entries.length > 0) this.signalWork();
    const vectors: Array<Float32Array | undefined> = new Array(entries.length);
    const hits = this.opts.cache
      ? this.opts.cache.getMany(
          entries.map((e) => e.hash),
          this.dim,
        )
      : null;
    const misses: number[] = [];
    for (let i = 0; i < entries.length; i++) {
      const hit = hits?.get((entries[i] as PreparedEntry).hash);
      if (hit) {
        vectors[i] = hit;
        this.stats.cached += 1;
      } else {
        misses.push(i);
      }
    }
    return { entries, vectors, misses };
  }

  /** Upsert one vector. Returns false (and writes nothing) for an all-zero
   *  vector, the embedder's failure fallback: a zero vector sits at a fixed
   *  mid-range similarity and outranks genuine weak matches in find_similar,
   *  so no vector is better than a misleading one. */
  private writeOne(e: PreparedEntry, v: Float32Array): boolean {
    if (isAllZero(v)) return false;
    this.opts.vectorStore.upsertNodeVector(
      e.item.orgId as unknown as OrgId,
      asQualifiedName(e.item.qname),
      e.item.label,
      v,
      e.hash,
    );
    return true;
  }
}

// Ingest's batched embedder is now a thin wrapper around the shared
// `embedTexts` function exported from ./embed.ts. The function used to be a
// closure here; pulling it out means the MCP `find_similar` tool (and any
// future ad-hoc embedding caller) gets the same pipeline + same env-var
// overrides, with no risk of drift.
async function defaultEmbed(texts: string[]): Promise<Float32Array[]> {
  const { embedTexts } = await import("./embed.js");
  return embedTexts(texts);
}
