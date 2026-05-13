/**
 * Placeholder for a future piscina-backed embedding pool.
 *
 * For Commit C we ship an in-process queue (see `./queue.ts`) since
 * worker-thread loading of transformers.js has its own bootstrapping cost
 * that exceeds the budget for a single-batch run. A worker-thread pool is
 * a v1.1 optimization.
 */
export const EMBED_DIM = 384;
