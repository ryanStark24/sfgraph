import os from "node:os";
import { Piscina } from "piscina";
import type { ParseContext, ParseResult } from "./contract.js";

export interface WorkerPoolOptions {
  filename?: string;
  minThreads?: number;
  maxThreads?: number;
  idleTimeout?: number;
  maxQueue?: number;
}

export interface DispatchArgs {
  parserType: string;
  input: unknown;
  ctx: ParseContext;
}

/**
 * Wraps a Piscina pool for parser dispatch. The caller passes a filename that
 * exports a default async fn `({parserType,input,ctx}) => ParseResult`.
 * For tests we accept an inline `runner` to avoid spinning a worker process.
 */
export class ParserWorkerPool {
  private readonly piscina?: Piscina;
  private readonly runner?: (args: DispatchArgs) => Promise<ParseResult>;
  private readonly maxQueue: number;
  private currentDepth = 0;

  constructor(
    opts: WorkerPoolOptions & { runner?: (args: DispatchArgs) => Promise<ParseResult> } = {},
  ) {
    const cpus = Math.max(1, os.cpus().length);
    const minThreads = opts.minThreads ?? 2;
    const maxThreads = opts.maxThreads ?? Math.max(2, Math.min(10, cpus - 1));
    const idleTimeout = opts.idleTimeout ?? 30_000;
    this.maxQueue = opts.maxQueue ?? 200;
    if (opts.runner) {
      this.runner = opts.runner;
      return;
    }
    if (!opts.filename) {
      throw new Error("ParserWorkerPool requires either `runner` (in-process) or `filename`.");
    }
    this.piscina = new Piscina({
      filename: opts.filename,
      minThreads,
      maxThreads,
      idleTimeout,
      maxQueue: this.maxQueue,
      concurrentTasksPerWorker: 1,
    });
  }

  async dispatch(args: DispatchArgs): Promise<ParseResult> {
    if (this.currentDepth >= this.maxQueue) {
      throw new Error(`ParserWorkerPool: queue overflow (>${this.maxQueue})`);
    }
    this.currentDepth++;
    try {
      if (this.runner) return await this.runner(args);
      const piscina = this.piscina;
      if (!piscina) throw new Error("ParserWorkerPool: no transport configured");
      return (await piscina.run(args)) as ParseResult;
    } finally {
      this.currentDepth--;
    }
  }

  async destroy(): Promise<void> {
    if (this.piscina) await this.piscina.destroy();
  }
}
