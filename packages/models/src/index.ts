export {
  E_MODEL_CHECKSUM_MISMATCH,
  E_MODEL_NOT_VENDORED,
  type ChecksumManifest,
  readChecksumManifest,
  verifyVendoredModel,
} from "./checksum.js";
export { type EmbedderHandle, type LoadOptions, load } from "./loader.js";
export { MODEL_DATA_DIR, VENDORED_MODEL_DIM, VENDORED_MODEL_ID } from "./paths.js";

// Back-compat alias from Phase 0.
export { MODEL_DATA_DIR as MODELS_DIR } from "./paths.js";
