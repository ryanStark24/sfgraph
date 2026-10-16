import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

export const EMBED_DIM = 384;

/** Request posted to the embedding worker. */
export interface EmbedRequest {
  id: number;
  texts: string[];
}

/** Reply from the embedding worker: vectors in request order, or an error. */
export type EmbedReply = { id: number; vectors: Float32Array[] } | { id: number; error: string };

export interface EmbeddingPoolOpts {
  /** Worker script (defaults to the compiled `./worker.js`). */
  workerUrl?: URL | string;
  workerData?: unknown;
  /**
   * Liveness bound: if requests are outstanding and the worker sends no reply
   * for this long, it is treated as hung (terminated; every pending and later
   * call rejects). It measures lack of progress, so queueing behind earlier
   * requests does not count. Default SFGRAPH_EMBED_TIMEOUT_MS or 10 minutes
   * (one batch normally takes well under a second, the first one also loads
   * the model).
   */
  requestTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

interface Pending {
  resolve: (v: Float32Array[]) => void;
  reject: (e: Error) => void;
}

/**
 * The compiled worker entry next to this module, or null when it is not there
 * (running from TypeScript sources, e.g. under vitest) or when
 * `SFGRAPH_EMBED_WORKER=0`. Callers fall back to in-process embedding.
 */
export function defaultEmbeddingWorkerUrl(): URL | null {
  if (process.env.SFGRAPH_EMBED_WORKER === "0") return null;
  const url = new URL("./worker.js", import.meta.url);
  try {
    return existsSync(fileURLToPath(url)) ? url : null;
  } catch {
    return null;
  }
}

/**
 * Embedding inference in a worker_thread, so ONNX, tokenisation and pooling run
 * alongside the ingest fan-out instead of on the main thread.
 *
 * One worker: onnxruntime already parallelises each run across cores, so more
 * workers would only oversubscribe the CPU. Requests are answered in FIFO order.
 * The worker is spawned on the first call (a warm-cache run never pays the
 * model load) and is unref'd while idle so it never holds the process open.
 *
 * A crash (uncaught error, non-zero exit) or a hang (no reply within
 * `requestTimeoutMs` while requests are outstanding) rejects every outstanding
 * request and every later one with that error — callers see an error, never
 * a hang.
 */
export class EmbeddingPool {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private crash: Error | null = null;
  private closed = false;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly timeoutMs: number;

  constructor(private readonly opts: EmbeddingPoolOpts = {}) {
    const env = Number.parseInt(process.env.SFGRAPH_EMBED_TIMEOUT_MS ?? "", 10);
    this.timeoutMs = opts.requestTimeoutMs ?? (env > 0 ? env : DEFAULT_TIMEOUT_MS);
  }

  /** Requests posted and not yet answered. */
  get inFlight(): number {
    return this.pending.size;
  }

  embed(texts: string[]): Promise<Float32Array[]> {
    if (this.closed) return Promise.reject(new Error("embedding pool closed"));
    if (this.crash) return Promise.reject(this.crash);
    if (texts.length === 0) return Promise.resolve([]);
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch (e) {
      this.crash = new Error(`embedding worker failed to start: ${(e as Error).message}`);
      return Promise.reject(this.crash);
    }
    const id = this.nextId++;
    return new Promise<Float32Array[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (!this.stallTimer) this.armStallTimer();
      worker.ref();
      worker.postMessage({ id, texts } satisfies EmbedRequest);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearStallTimer();
    this.failAll(new Error("embedding pool closed"));
    const w = this.worker;
    this.worker = null;
    if (w) await w.terminate();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const url = this.opts.workerUrl ?? defaultEmbeddingWorkerUrl();
    if (!url) throw new Error("no compiled embedding worker (worker.js) found");
    const w = new Worker(url, { workerData: this.opts.workerData });
    w.unref();
    w.on("message", (msg: EmbedReply) => this.onReply(msg));
    w.on("error", (err: Error) => {
      this.onCrash(new Error(`embedding worker crashed: ${err.message}`));
    });
    w.on("messageerror", (err: Error) => {
      this.onCrash(new Error(`embedding worker message error: ${err.message}`));
    });
    w.on("exit", (code) => {
      if (this.worker === w) this.worker = null;
      if (!this.closed) this.onCrash(new Error(`embedding worker exited with code ${code}`));
    });
    this.worker = w;
    return w;
  }

  private onReply(msg: EmbedReply): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    // Progress: restart the liveness window (or stop it when idle).
    this.clearStallTimer();
    if (this.pending.size === 0) this.worker?.unref();
    else this.armStallTimer();
    if ("error" in msg) p.reject(new Error(msg.error));
    else p.resolve(msg.vectors);
  }

  private onCrash(err: Error): void {
    // Keep the first cause (an 'error' event is followed by 'exit').
    if (!this.crash) this.crash = err;
    this.clearStallTimer();
    this.failAll(this.crash);
  }

  private armStallTimer(): void {
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      if (this.pending.size === 0) return;
      const w = this.worker;
      this.onCrash(
        new Error(
          `embedding worker unresponsive: no reply in ${Math.round(this.timeoutMs / 1000)}s`,
        ),
      );
      this.worker = null;
      void w?.terminate();
    }, this.timeoutMs);
    this.stallTimer.unref();
  }

  private clearStallTimer(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }

  private failAll(err: Error): void {
    const ps = [...this.pending.values()];
    this.pending.clear();
    for (const p of ps) p.reject(err);
  }
}
