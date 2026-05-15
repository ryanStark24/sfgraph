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
 * Per-pool concurrency overrides. Each value, when provided, replaces the
 * default `maxConcurrent` for that pool. Used by {@link createRateLimitPools}
 * and {@link configureDefaultPools}.
 */
export interface PoolConcurrencyOverrides {
  tooling?: number;
  metadata?: number;
  data?: number;
}

/** Default concurrency. Metadata raised from 3 -> 5 — Salesforce's Metadata
 *  API tolerates 5-10 concurrent read calls comfortably; 3 was leaving
 *  perf on the table for orgs with many Profile/PermissionSet/Layout records. */
export const DEFAULT_POOL_CONCURRENCY = {
  tooling: 5,
  metadata: 5,
  data: 10,
} as const;

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw == null) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

/** Read `SFGRAPH_{TOOLING,METADATA,DATA}_POOL` env vars. Invalid / unset
 *  entries leave the corresponding pool at its default. */
function envOverrides(): PoolConcurrencyOverrides {
  const out: PoolConcurrencyOverrides = {};
  const t = parsePositiveInt(process.env.SFGRAPH_TOOLING_POOL);
  const m = parsePositiveInt(process.env.SFGRAPH_METADATA_POOL);
  const d = parsePositiveInt(process.env.SFGRAPH_DATA_POOL);
  if (t !== undefined) out.tooling = t;
  if (m !== undefined) out.metadata = m;
  if (d !== undefined) out.data = d;
  return out;
}

/**
 * Build a fresh independent {@link RateLimitPools} set. Each pool has its own
 * Bottleneck reservoir, so two pool sets do not contend for budget.
 *
 * Concurrency resolution order: explicit `overrides` arg > `SFGRAPH_*_POOL`
 * env vars > {@link DEFAULT_POOL_CONCURRENCY}.
 */
export function createRateLimitPools(overrides: PoolConcurrencyOverrides = {}): RateLimitPools {
  const env = envOverrides();
  const toolingConc = overrides.tooling ?? env.tooling ?? DEFAULT_POOL_CONCURRENCY.tooling;
  const metadataConc = overrides.metadata ?? env.metadata ?? DEFAULT_POOL_CONCURRENCY.metadata;
  const dataConc = overrides.data ?? env.data ?? DEFAULT_POOL_CONCURRENCY.data;
  const toolingPool = new Bottleneck({
    maxConcurrent: toolingConc,
    minTime: 50,
    reservoir: 100,
    reservoirRefreshAmount: 100,
    reservoirRefreshInterval: 10_000,
  });
  const metadataPool = new Bottleneck({
    maxConcurrent: metadataConc,
    minTime: 100,
    reservoir: 50,
    reservoirRefreshAmount: 50,
    reservoirRefreshInterval: 10_000,
  });
  const dataPool = new Bottleneck({
    maxConcurrent: dataConc,
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

/**
 * Mutate the *default* (process-level) pools' concurrency caps at runtime.
 * Used by the CLI when `--tooling-pool` / `--metadata-pool` / `--data-pool`
 * flags are passed — by the time those flags are parsed, the singletons have
 * already been instantiated, so we can't influence them through the
 * constructor. Bottleneck supports live updates via `updateSettings`.
 *
 * Returns the concurrency caps actually applied (after merging defaults +
 * env vars + overrides), so callers can log what the user got.
 */
export async function configureDefaultPools(
  overrides: PoolConcurrencyOverrides = {},
): Promise<{ tooling: number; metadata: number; data: number }> {
  const env = envOverrides();
  const tooling = overrides.tooling ?? env.tooling ?? DEFAULT_POOL_CONCURRENCY.tooling;
  const metadata = overrides.metadata ?? env.metadata ?? DEFAULT_POOL_CONCURRENCY.metadata;
  const data = overrides.data ?? env.data ?? DEFAULT_POOL_CONCURRENCY.data;
  // Bottleneck.updateSettings returns a Promise — must await so subsequent
  // schedules see the new cap.
  await Promise.all([
    toolingPool.updateSettings({ maxConcurrent: tooling }),
    metadataPool.updateSettings({ maxConcurrent: metadata }),
    dataPool.updateSettings({ maxConcurrent: data }),
  ]);
  return { tooling, metadata, data };
}
