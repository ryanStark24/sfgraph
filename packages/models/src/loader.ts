import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { ErrorCode, SfgraphError } from "@ryanstark24/sfgraph-shared";
import { verifyVendoredModel } from "./checksum.js";
import { MODEL_DATA_DIR, VENDORED_MODEL_DIM, VENDORED_MODEL_ID } from "./paths.js";

export interface EmbedderHandle {
  modelId: string;
  dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
  close(): Promise<void>;
}

export interface LoadOptions {
  /** Override the vendored model. Provide an absolute path to a directory
   *  laid out like `<modelDir>/<MODEL_ID>/onnx/model.onnx` (transformers.js
   *  expects `localModelPath` to be the *parent* of `<MODEL_ID>/`). The
   *  dimension and model id are inferred or can be overridden. */
  modelPath?: string;
  /** Override the model id (defaults to the vendored MiniLM L6 v2). */
  modelId?: string;
  /** Override the embedding dimension (defaults to 384 for MiniLM). */
  dim?: number;
  /** Whether to use the quantized variant (transformers.js flag). Default true. */
  quantized?: boolean;
}

/**
 * Resolve effective load options from explicit args + env vars. Env vars take
 * second priority after explicit args; the vendored defaults are last.
 *
 *   SFGRAPH_EMBED_MODEL_PATH   absolute path to a custom model dir
 *   SFGRAPH_EMBED_MODEL_ID     model id under that dir (e.g. "MyOrg/MyModel")
 *   SFGRAPH_EMBED_MODEL_DIM    embedding dimension as integer
 */
function resolveLoadOptions(opts: LoadOptions): Required<LoadOptions> {
  const envPath = process.env.SFGRAPH_EMBED_MODEL_PATH;
  const envId = process.env.SFGRAPH_EMBED_MODEL_ID;
  const envDim = process.env.SFGRAPH_EMBED_MODEL_DIM;
  const modelPath = opts.modelPath ?? envPath ?? MODEL_DATA_DIR;
  const modelId = opts.modelId ?? envId ?? VENDORED_MODEL_ID;
  const dim = opts.dim ?? (envDim ? Number.parseInt(envDim, 10) : VENDORED_MODEL_DIM);
  const quantized = opts.quantized ?? true;
  return { modelPath, modelId, dim, quantized };
}

/**
 * Load an embedder. By default uses the vendored MiniLM L6 v2 model shipped
 * with this package. Users can BYO model via:
 *   - the `modelPath`/`modelId`/`dim` options
 *   - or env vars `SFGRAPH_EMBED_MODEL_PATH`, `SFGRAPH_EMBED_MODEL_ID`,
 *     `SFGRAPH_EMBED_MODEL_DIM`
 *
 * When a custom model is provided, checksum verification is skipped (it is
 * the user's model, not ours to validate).
 *
 * Throws SfgraphError(E_MODEL_NOT_VENDORED) when the default path is missing.
 */
export async function load(opts: LoadOptions = {}): Promise<EmbedderHandle> {
  const cfg = resolveLoadOptions(opts);
  const isCustom = cfg.modelPath !== MODEL_DATA_DIR || cfg.modelId !== VENDORED_MODEL_ID;
  const resolvedPath = isAbsolute(cfg.modelPath) ? cfg.modelPath : resolve(cfg.modelPath);

  if (isCustom) {
    if (!existsSync(resolvedPath)) {
      throw new SfgraphError(
        ErrorCode.E_MODEL_NOT_VENDORED,
        `Custom embedding model path not found: ${resolvedPath}. Expected layout: <path>/${cfg.modelId}/<files>. Set SFGRAPH_EMBED_MODEL_PATH or pass --embed-model.`,
      );
    }
  } else {
    await verifyVendoredModel();
  }

  // Lazy dynamic import — keeps transformers.js + onnxruntime out of the
  // module graph for callers that never embed.
  // Module is optional + dynamic; type it loosely to keep compile working
  // even when the package isn't installed.
  interface TransformersModule {
    env: { allowRemoteModels: boolean; localModelPath: string };
    pipeline: (
      task: string,
      model: string,
      opts?: { quantized?: boolean },
    ) => Promise<
      (
        text: string,
        opts: { pooling: string; normalize: boolean },
      ) => Promise<{
        data: Float32Array;
      }>
    >;
  }
  let transformersMod: TransformersModule;
  try {
    // Cast through unknown because @xenova/transformers is an optional dep
    // and may not have type declarations available at compile time.
    transformersMod = (await import("@xenova/transformers")) as unknown as TransformersModule;
  } catch (err) {
    throw new SfgraphError(
      ErrorCode.E_MODEL_NOT_VENDORED,
      `Failed to import @xenova/transformers: ${(err as Error).message}. Ensure dependencies are installed.`,
      { cause: err as Error },
    );
  }
  const { env, pipeline } = transformersMod;
  // Force fully-local model resolution; no network fetch.
  env.allowRemoteModels = false;
  env.localModelPath = resolvedPath;

  const extractor = await pipeline("feature-extraction", cfg.modelId, {
    quantized: cfg.quantized,
  });

  return {
    modelId: cfg.modelId,
    dim: cfg.dim,
    async embed(texts: string[]): Promise<Float32Array[]> {
      const out: Float32Array[] = [];
      for (const t of texts) {
        const tensor = await extractor(t, { pooling: "mean", normalize: true });
        // tensor.data is a Float32Array of length=dim
        out.push(new Float32Array(tensor.data as Float32Array));
      }
      return out;
    },
    async close(): Promise<void> {
      // transformers.js pipelines have no explicit close; rely on GC.
    },
  };
}
