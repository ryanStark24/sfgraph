import Bottleneck from "bottleneck";
import pLimit from "p-limit";

/** Cap concurrent query invocations against a single org connection. */
export const queryLimit = pLimit(5);

/**
 * A set of three independent rate-limit pools for one logical scope (a single
 * org token, typically). Splitting head-of-line blocking is the whole point.
 *
 * Use {@link createRateLimitPools} to spawn a fresh set for per-org parallel
 * ingest. Module-level singletons ({@link toolingPool} etc.) remain available
 * as the process-wide default for the single-org case.
 */
export interface RateLimitPools {
  toolingPool: Bottleneck;
  metadataPool: Bottleneck;
  dataPool: Bottleneck;
  scheduleQuery<T>(fn: () => Promise<T>): Promise<T>;
  scheduleMetadata<T>(fn: () => Promise<T>): Promise<T>;
  scheduleData<T>(fn: () => Promise<T>): Promise<T>;
}

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

function attachRetryHandler(pool: Bottleneck): void {
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
 * Build a fresh independent {@link RateLimitPools} set. Each pool has its own
 * Bottleneck reservoir, so two pool sets do not contend for budget.
 */
export function createRateLimitPools(): RateLimitPools {
  const toolingPool = new Bottleneck({
    maxConcurrent: 5,
    minTime: 50,
    reservoir: 100,
    reservoirRefreshAmount: 100,
    reservoirRefreshInterval: 10_000,
  });
  const metadataPool = new Bottleneck({
    maxConcurrent: 3,
    minTime: 100,
    reservoir: 50,
    reservoirRefreshAmount: 50,
    reservoirRefreshInterval: 10_000,
  });
  const dataPool = new Bottleneck({
    maxConcurrent: 10,
    minTime: 50,
    reservoir: 200,
    reservoirRefreshAmount: 200,
    reservoirRefreshInterval: 10_000,
  });
  for (const p of [toolingPool, metadataPool, dataPool]) attachRetryHandler(p);

  return {
    toolingPool,
    metadataPool,
    dataPool,
    scheduleQuery<T>(fn: () => Promise<T>): Promise<T> {
      return toolingPool.schedule(() => queryLimit(fn));
    },
    scheduleMetadata<T>(fn: () => Promise<T>): Promise<T> {
      return metadataPool.schedule(fn);
    },
    scheduleData<T>(fn: () => Promise<T>): Promise<T> {
      return dataPool.schedule(fn);
    },
  };
}

// Process-level default set. Existing module-level singletons continue to work.
const defaultPools = createRateLimitPools();

export const toolingPool = defaultPools.toolingPool;
export const metadataPool = defaultPools.metadataPool;
export const dataPool = defaultPools.dataPool;

/**
 * Back-compat alias. The original `limiter` export is preserved so callers
 * that haven't migrated to a specific pool continue to work; it points at
 * the tooling pool (the closest match to the previous single-pool defaults).
 */
export const limiter = toolingPool;

/** Helper that runs a single SOQL/Tooling callable through both gates. */
export function scheduleQuery<T>(fn: () => Promise<T>): Promise<T> {
  return defaultPools.scheduleQuery(fn);
}

/** Schedule a Metadata API call (list/read/retrieve/deploy). */
export function scheduleMetadata<T>(fn: () => Promise<T>): Promise<T> {
  return defaultPools.scheduleMetadata(fn);
}

/** Schedule a SObject SOQL / Bulk query (Vlocity, CMDT, generic records). */
export function scheduleData<T>(fn: () => Promise<T>): Promise<T> {
  return defaultPools.scheduleData(fn);
}
