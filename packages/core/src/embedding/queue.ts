import { createHash } from "node:crypto";
import type { OrgId, QualifiedName, Sha256 } from "@ryanstark24/sfgraph-shared";
import { asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";

/** Real SHA-256 of the embedded text. The vector store dedups on this hash
 *  (skips re-embedding when it matches), so it MUST reflect the actual text —
 *  otherwise re-ingest never refreshes a vector. Previously this was
 *  `asSha256("rule:" + qname)`, but asSha256 is a branded-type CAST, not a
 *  hash, so the value was constant per node and every vector was write-once
 *  (config-value enrichment, description changes, etc. never re-embedded). */
function hashEmbedText(text: string): Sha256 {
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
  /** Override embedding function — primarily for tests. */
  embed?: (texts: string[]) => Promise<Float32Array[]>;
}

/**
 * In-process batched embedding queue. push() accumulates; once buffer reaches
 * batchSize, flushBatch() is scheduled. drain() awaits the queue to empty.
 *
 * When the underlying embedder fails to load (e.g. transformers missing), the
 * queue logs via onError and silently skips vector upserts — ingest must not
 * crash because embeddings are unavailable.
 */
export class EmbeddingQueue {
  private buffer: EmbeddingItem[] = [];
  private flushing: Promise<void> | null = null;
  private readonly batchSize: number;
  private readonly embedFn: (texts: string[]) => Promise<Float32Array[]>;

  constructor(private readonly opts: EmbeddingQueueOpts) {
    this.batchSize = opts.batchSize ?? 16;
    this.embedFn = opts.embed ?? defaultEmbed;
  }

  push(item: EmbeddingItem): void {
    this.buffer.push(item);
    if (this.buffer.length >= this.batchSize && !this.flushing) {
      this.flushing = this.flushBatch().finally(() => {
        this.flushing = null;
      });
    }
  }

  async drain(): Promise<void> {
    // Cooperate with any in-flight flush from a prior push(): if `flushing`
    // is set, await it before starting our own — otherwise we'd run two
    // concurrent embedFn() calls into @xenova/transformers' WASM runtime
    // (unsafe / slow). After it settles, check the buffer again and flush
    // any remaining batches ourselves serially.
    while (true) {
      if (this.flushing) {
        await this.flushing;
        continue;
      }
      if (this.buffer.length === 0) return;
      this.flushing = this.flushBatch().finally(() => {
        this.flushing = null;
      });
      await this.flushing;
    }
  }

  /** Test introspection. */
  get pending(): number {
    return this.buffer.length;
  }

  private async flushBatch(): Promise<void> {
    const batch = this.buffer.splice(0, this.batchSize);
    if (batch.length === 0) return;
    const sink = this.opts.vectorStore;
    const getHash =
      typeof sink.getContentHash === "function" ? sink.getContentHash.bind(sink) : null;
    // Pre-embed dedup: skip the MiniLM model for items whose stored vector hash
    // already matches the new text hash (unchanged on re-ingest). Previously the
    // hash was only checked at write time, so an unchanged org re-paid 100% of
    // embedding inference every full sync. Compute the hash once here and reuse.
    const toEmbed: Array<{ item: EmbeddingItem; hash: Sha256 }> = [];
    for (const b of batch) {
      const hash = hashEmbedText(b.text);
      if (getHash && getHash(b.orgId as unknown as OrgId, asQualifiedName(b.qname)) === hash) {
        continue;
      }
      toEmbed.push({ item: b, hash });
    }
    if (toEmbed.length === 0) return;
    try {
      const vectors = await this.embedFn(toEmbed.map((t) => t.item.text));
      for (let i = 0; i < toEmbed.length; i++) {
        const v = vectors[i];
        if (!v) continue;
        // Skip all-zero vectors (the embedder's failure fallback). Inserting
        // them poisons find_similar — a zero vector sits at a fixed mid-range
        // similarity and outranks genuine weak matches. Better no vector than
        // a misleading one; the node is simply absent from semantic search.
        if (isAllZero(v)) continue;
        const { item, hash } = toEmbed[i] as { item: EmbeddingItem; hash: Sha256 };
        sink.upsertNodeVector(
          item.orgId as unknown as OrgId,
          asQualifiedName(item.qname),
          item.label,
          v,
          hash,
        );
      }
    } catch (e) {
      this.opts.onError?.(e as Error);
    }
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
