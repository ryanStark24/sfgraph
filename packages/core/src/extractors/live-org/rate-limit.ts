import Bottleneck from "bottleneck";
import pLimit from "p-limit";

/** Cap concurrent query invocations against a single org connection. */
export const queryLimit = pLimit(5);

/**
 * Three Bottleneck pools, each with its own concurrency + reservoir budget.
 * Splitting them avoids head-of-line blocking: a slow Metadata API retrieve
 * doesn't starve fast Tooling SOQL calls.
 */

// Tooling SOQL (fast path for code metadata)
export const toolingPool = new Bottleneck({
  maxConcurrent: 5,
  minTime: 50,
  reservoir: 100,
  reservoirRefreshAmount: 100,
  reservoirRefreshInterval: 10_000,
});

// Metadata API retrieve (slow, async retrieve-then-poll)
export const metadataPool = new Bottleneck({
  maxConcurrent: 3,
  minTime: 100,
  reservoir: 50,
  reservoirRefreshAmount: 50,
  reservoirRefreshInterval: 10_000,
});

// SObject SOQL + Bulk (Vlocity, CMDT records, anything record-shaped)
export const dataPool = new Bottleneck({
  maxConcurrent: 10,
  minTime: 50,
  reservoir: 200,
  reservoirRefreshAmount: 200,
  reservoirRefreshInterval: 10_000,
});

function parseRetryAfter(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const e = err as {
    retryAfter?: number | string;
    headers?: Record<string, string>;
    errorCode?: string;
    name?: string;
  };
  const direct = e.retryAfter;
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  if (typeof direct === "string") {
    const n = Number(direct);
    if (Number.isFinite(n)) return n;
  }
  const hdr = e.headers?.["retry-after"] ?? e.headers?.["Retry-After"];
  if (hdr) {
    const n = Number(hdr);
    if (Number.isFinite(n)) return n;
  }
  if (e.errorCode === "REQUEST_LIMIT_EXCEEDED" || e.name === "REQUEST_LIMIT_EXCEEDED") {
    return 30;
  }
  return null;
}

for (const pool of [toolingPool, metadataPool, dataPool]) {
  pool.on("failed", (err: unknown, jobInfo) => {
    const e = err as { errorCode?: string } | undefined;
    if (e?.errorCode === "REQUEST_LIMIT_EXCEEDED" && jobInfo.retryCount < 3) {
      const wait = parseRetryAfter(err);
      if (wait != null) return wait * 1000;
      return 5000 * (jobInfo.retryCount + 1);
    }
    const wait = parseRetryAfter(err);
    if (wait != null && jobInfo.retryCount < 1) {
      return wait * 1000;
    }
    return null;
  });
}

/**
 * Back-compat alias. The original `limiter` export is preserved so callers
 * that haven't migrated to a specific pool continue to work; it points at
 * the tooling pool (the closest match to the previous single-pool defaults).
 */
export const limiter = toolingPool;

/** Helper that runs a single SOQL/Tooling callable through both gates. */
export function scheduleQuery<T>(fn: () => Promise<T>): Promise<T> {
  return toolingPool.schedule(() => queryLimit(fn));
}

/** Schedule a Metadata API call (list/read/retrieve/deploy). */
export function scheduleMetadata<T>(fn: () => Promise<T>): Promise<T> {
  return metadataPool.schedule(fn);
}

/** Schedule a SObject SOQL / Bulk query (Vlocity, CMDT, generic records). */
export function scheduleData<T>(fn: () => Promise<T>): Promise<T> {
  return dataPool.schedule(fn);
}
