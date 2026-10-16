export { EmbeddingQueue } from "./queue.js";
export type { EmbeddingItem, EmbeddingQueueOpts, VectorSink } from "./queue.js";
export { EMBED_DIM } from "./pool.js";
export { embedTexts, embedSingle } from "./embed.js";
export type { EmbedOptions } from "./embed.js";
export { hashEmbedText } from "./queue.js";
export type { EmbeddingQueueStats } from "./queue.js";
export { EmbeddingPool, defaultEmbeddingWorkerUrl } from "./pool.js";
export type { EmbeddingPoolOpts } from "./pool.js";
export { EmbeddingCache, embeddingCachePath } from "./cache.js";
export type { EmbeddingCacheLike } from "./cache.js";
export {
  EMBED_MAX_TOKENS,
  embedMaxTokens,
  embedModelFingerprint,
  resolveEmbedModelFile,
  resolveEmbedModelId,
} from "./embed.js";
