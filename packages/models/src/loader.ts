import { ErrorCode, SfgraphError } from "@ryanstark24/sfgraph-shared";
import { verifyVendoredModel } from "./checksum.js";
import { MODEL_DATA_DIR, VENDORED_MODEL_DIM, VENDORED_MODEL_ID } from "./paths.js";

export interface EmbedderHandle {
  modelId: string;
  dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
  close(): Promise<void>;
}

/**
 * Load the vendored MiniLM embedder. Verifies checksums first, then lazily
 * imports `@xenova/transformers` so importing this module without calling
 * `load()` triggers no network resolution or heavy dependency load.
 *
 * Throws SfgraphError(E_MODEL_NOT_VENDORED) when files are missing.
 */
export async function load(): Promise<EmbedderHandle> {
  await verifyVendoredModel();

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
  // Force fully-local model resolution.
  env.allowRemoteModels = false;
  env.localModelPath = MODEL_DATA_DIR;

  const extractor = await pipeline("feature-extraction", VENDORED_MODEL_ID, {
    quantized: true,
  });

  return {
    modelId: VENDORED_MODEL_ID,
    dim: VENDORED_MODEL_DIM,
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
