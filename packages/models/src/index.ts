import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

export const MODELS_DIR = join(here, "..", "data");

export function loadEmbeddingModel(): never {
  throw new Error("loadEmbeddingModel: not implemented in Phase 0");
}
