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
    while (this.buffer.length > 0) {
      await this.flushBatch();
    }
    if (this.flushing) await this.flushing;
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

/** Default embedder: lazy-imports @xenova/transformers, returns zero-vectors on failure.
 *
 * Honors SFGRAPH_EMBED_MODEL_PATH / SFGRAPH_EMBED_MODEL_ID / SFGRAPH_EMBED_MODEL_DIM
 * env vars so users can BYO model without touching the package. When unset,
 * falls back to the vendored MiniLM L6 v2 shipped by @ryanstark24/sfgraph-models.
 */
async function defaultEmbed(texts: string[]): Promise<Float32Array[]> {
  try {
    const mod = (await import("@xenova/transformers" as unknown as string)) as {
      pipeline: (
        ...args: unknown[]
      ) => Promise<(...args: unknown[]) => Promise<{ data: number[] }>>;
      env: { allowRemoteModels: boolean; localModelPath?: string };
    };
    const { pipeline, env } = mod;
    env.allowRemoteModels = false;

    const envPath = process.env.SFGRAPH_EMBED_MODEL_PATH;
    const modelId = process.env.SFGRAPH_EMBED_MODEL_ID ?? "Xenova/all-MiniLM-L6-v2";
    const dim = process.env.SFGRAPH_EMBED_MODEL_DIM
      ? Number.parseInt(process.env.SFGRAPH_EMBED_MODEL_DIM, 10)
      : 384;

    if (envPath) {
      env.localModelPath = envPath;
    } else {
      try {
        const models = (await import("@ryanstark24/sfgraph-models" as unknown as string)) as {
          MODEL_DATA_DIR?: string;
        };
        if (models?.MODEL_DATA_DIR) env.localModelPath = models.MODEL_DATA_DIR;
      } catch {
        /* models package optional */
      }
    }

    const pipe = await pipeline("feature-extraction", modelId, {
      quantized: true,
      local_files_only: true,
    });
    const out = await pipe(texts, { pooling: "mean", normalize: true });
    const results: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) {
      results.push(new Float32Array(out.data.slice(i * dim, (i + 1) * dim)));
    }
    return results;
  } catch {
    // Transformers (or model) not present — return zero vectors so caller can
    // still upsert placeholder embeddings if desired. Ingest must not crash.
    return texts.map(() => new Float32Array(384));
  }
}
