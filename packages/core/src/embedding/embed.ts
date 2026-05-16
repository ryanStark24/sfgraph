/**
 * Standalone embedder. Lazy-imports @xenova/transformers (optionalDependency
 * on @ryanstark24/sfgraph-core), uses the vendored MiniLM-L6 weights from
 * @ryanstark24/sfgraph-models when no override is set, and gracefully falls
 * back to zero-vectors when either is unavailable.
 *
 * Env overrides (also accepted by the ingest CLI):
 *   SFGRAPH_EMBED_MODEL_PATH   absolute path to a model directory
 *   SFGRAPH_EMBED_MODEL_ID     model id inside that dir (default: Xenova/all-MiniLM-L6-v2)
 *   SFGRAPH_EMBED_MODEL_DIM    embedding dim (default: 384)
 *
 * Exported because callers outside the ingest pipeline (e.g. the MCP
 * `find_similar` tool's free-text mode) need to embed ad-hoc strings.
 * Until this lived as a module-private closure inside queue.ts, ad-hoc
 * embeddings weren't possible.
 */
export interface EmbedOptions {
  /** Override the default model path (otherwise @ryanstark24/sfgraph-models). */
  modelPath?: string;
  /** Override model id. */
  modelId?: string;
  /** Override embedding dimension. */
  dim?: number;
}

const DEFAULT_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_DIM = 384;

export async function embedTexts(
  texts: string[],
  opts: EmbedOptions = {},
): Promise<Float32Array[]> {
  try {
    const mod = (await import("@xenova/transformers")) as unknown as {
      pipeline: (
        ...args: unknown[]
      ) => Promise<(...args: unknown[]) => Promise<{ data: number[] }>>;
      env: { allowRemoteModels: boolean; localModelPath?: string };
    };
    const { pipeline, env } = mod;
    env.allowRemoteModels = false;

    const envPath = opts.modelPath ?? process.env.SFGRAPH_EMBED_MODEL_PATH;
    const modelId =
      opts.modelId ?? process.env.SFGRAPH_EMBED_MODEL_ID ?? DEFAULT_MODEL_ID;
    const dim =
      opts.dim ??
      (process.env.SFGRAPH_EMBED_MODEL_DIM
        ? Number.parseInt(process.env.SFGRAPH_EMBED_MODEL_DIM, 10)
        : DEFAULT_DIM);

    if (envPath) {
      env.localModelPath = envPath;
    } else {
      try {
        const models = (await import(
          "@ryanstark24/sfgraph-models" as unknown as string
        )) as { MODEL_DATA_DIR?: string };
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
    return texts.map(() => new Float32Array(DEFAULT_DIM));
  }
}

/** Convenience: embed a single string. Returns null when transformers/model
 *  unavailable — distinct from a zero-vector so callers can distinguish
 *  "the runtime can't embed" from "I embedded but the result happens to be
 *  all zeros." */
export async function embedSingle(
  text: string,
  opts: EmbedOptions = {},
): Promise<Float32Array | null> {
  try {
    // Probe import directly so we can return null on missing runtime,
    // without conflating that with "zero-vector fallback."
    await import("@xenova/transformers");
  } catch {
    return null;
  }
  const [vec] = await embedTexts([text], opts);
  if (!vec) return null;
  // Heuristic: if every element is exactly 0, the model load failed silently
  // inside embedTexts and we got the fallback. Surface that to the caller.
  let allZero = true;
  for (let i = 0; i < vec.length; i++) {
    if (vec[i] !== 0) {
      allZero = false;
      break;
    }
  }
  return allZero ? null : vec;
}
