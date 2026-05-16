import type { OrgId, QualifiedName, Sha256 } from "@ryanstark24/sfgraph-shared";
import { asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";

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
    try {
      const vectors = await this.embedFn(batch.map((b) => b.text));
      for (let i = 0; i < batch.length; i++) {
        const v = vectors[i];
        if (!v) continue;
        const b = batch[i] as EmbeddingItem;
        this.opts.vectorStore.upsertNodeVector(
          b.orgId as unknown as OrgId,
          asQualifiedName(b.qname),
          b.label,
          v,
          asSha256(`rule:${b.qname}`),
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
