import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * Directory where the vendored ONNX embedding model + tokenizer/config files live.
 * Resolved relative to this package so it works in both `src/` (vitest) and
 * post-build `dist/` execution.
 */
export const MODEL_DATA_DIR = join(here, "..", "data");

/** Canonical model id we ship. */
export const VENDORED_MODEL_ID = "Xenova/all-MiniLM-L6-v2";

/** Embedding dimension for all-MiniLM-L6-v2. */
export const VENDORED_MODEL_DIM = 384;
