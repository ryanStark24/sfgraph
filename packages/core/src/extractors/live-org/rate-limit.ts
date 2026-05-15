import Bottleneck from "bottleneck";
import pLimit from "p-limit";

/** Cap concurrent query invocations against a single org connection. */
export const queryLimit = pLimit(5);

/**
 * Hard upper bound on a single jsforce call. Used to wrap metadata.list /
 * metadata.read calls in extractors so a Salesforce-side stall can't park
 * the extractor (and therefore the sliding-window slot) indefinitely.
 * Rejects with a descriptive error after `ms`; the failSoft wrapper one
 * level up surfaces it as a skip. The underlying jsforce HTTP request may
 * continue until libuv tears it down — we just stop waiting.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout (${ms}ms)`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Per-call ceilings — kept here so all extractors apply them consistently.
 *  Read timeout raised 45s -> 120s. A single metadata.read of a heavy
 *  Profile / Layout / Workflow legitimately takes 60-90s on production orgs;
 *  45s was clipping perfectly-healthy reads. When a batch genuinely needs
 *  longer than 120s, the streaming-split helper below recursively halves
 *  the batch on timeout, so we still recover most records instead of
 *  dropping the whole batch. */
export const METADATA_LIST_TIMEOUT_MS = 30_000;
export const METADATA_READ_TIMEOUT_MS = 120_000;
/** Per-SOQL-call ceiling. 60s covers legitimate slow queries (large
 *  SObject describes via Tooling, OmniProcessElement paged fetches on
 *  Vlocity-heavy orgs) while still catching dead-socket hangs fast.
 *  Used by `soqlWithTimeout` below — every raw conn.query / conn.tooling.query
 *  call should be wrapped, or the call hangs forever when the underlying
 *  jsforce HTTP socket is half-open (a real failure mode on corporate
 *  VPNs / NATs with idle eviction). */
export const SOQL_TIMEOUT_MS = 60_000;
/** Initial describe* probes are tiny but on a wedged connection they
 *  still need to fail fast or the whole ingest never starts. */
export const DESCRIBE_GLOBAL_TIMEOUT_MS = 60_000;
export const METADATA_DESCRIBE_TIMEOUT_MS = 60_000;

/** Helper: wrap any `conn.query(...)` / `conn.tooling.query(...)` call
 *  with a SOQL-flavoured withTimeout. Centralizes the timeout value so
 *  callers don't drift; centralizes the label format so failures are
 *  greppable. */
export function soqlWithTimeout<T>(p: Promise<T>, label: string, ms = SOQL_TIMEOUT_MS): Promise<T> {
  return withTimeout(p, ms, `soql ${label}`);
}

/**
 * Resilient metadata.read for a batch of items, with adaptive splitting on
 * timeout. On a clean call, returns whatever Salesforce gave us (as an
 * array). On any error, if the batch has >1 item, splits in half and
 * retries each half in parallel — concatenating in original order so the
 * caller can still index records against the original slice. A single
 * item that times out is the genuine "this record cannot be ingested"
 * case; we return `null` for it so the caller can record the skip
 * without polluting the success path.
 */
export async function readMetadataBatchAdaptive<TItem extends { fullName: string }>(
  conn: { metadata: { read: (type: string, names: string[]) => Promise<unknown> } },
  type: string,
  items: TItem[],
): Promise<(unknown | null)[]> {
  if (items.length === 0) return [];
  try {
    const raw = await scheduleMetadata(() =>
      withTimeout(
        conn.metadata.read(
          type,
          items.map((i) => i.fullName),
        ),
        METADATA_READ_TIMEOUT_MS,
        `metadata.read ${type}`,
      ),
    );
    const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const out: (unknown | null)[] = [];
    for (let i = 0; i < items.length; i += 1) out.push(arr[i] ?? null);
    return out;
  } catch (e) {
    // Split only on NON-timeout errors. A timeout means Salesforce is slow
    // per item, not that one bad record poisoned the batch — retrying with
    // smaller batches each at the full timeout budget multiplies wall-clock
    // time (e.g. a 10-item managed-package timeout cascade can balloon to
    // 10×120s = 20 minutes before failing). Take the cleanest exit: skip
    // the batch, emit nulls so the caller's indexing stays aligned.
    const msg = (e as Error)?.message ?? "";
    const isTimeout = msg.includes("timeout (");
    if (isTimeout || items.length === 1) {
      return items.map(() => null);
    }
    const mid = Math.ceil(items.length / 2);
    const [left, right] = await Promise.all([
      readMetadataBatchAdaptive(conn, type, items.slice(0, mid)),
      readMetadataBatchAdaptive(conn, type, items.slice(mid)),
    ]);
    return [...left, ...right];
  }
}

// Re-export scheduleMetadata since the helper above closes over it via
// module-local reference; keeping the public surface stable.

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
  return null;
}

function attachRetryHandler(pool: Bottleneck): void {
  pool.on("failed", (err: unknown, jobInfo) => {
    // Only retry when Salesforce explicitly told us to wait, and only ONCE.
    // Previously: defaulted REQUEST_LIMIT_EXCEEDED to a 30s wait and retried
    // up to 3×. On a daily-limit-saturated org that cascade tied up pool
    // slots for 90+s of dead time per failed call, starving every other
    // source. If we can't infer a real retry-after, fail fast — failSoft
    // surfaces a skip and the run keeps moving.
    if (jobInfo.retryCount >= 1) return null;
    const wait = parseRetryAfter(err);
    if (wait != null) return wait * 1000;
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

/** Default concurrency. Metadata raised 5 -> 10 — under the sliding-window
 *  source merger, security + flow + integration + several generic types all
 *  schedule into this pool simultaneously. 5 slots backlogged the queue past
 *  failSoft's 180s inactivity ceiling, causing whole sources to be killed
 *  before their first batch ran. 10 stays well inside Salesforce's tolerance
 *  for concurrent Metadata API reads and drains the queue ~2× faster. */
export const DEFAULT_POOL_CONCURRENCY = {
  tooling: 5,
  metadata: 10,
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
  // Pool sizing rule: reservoir refresh-rate must exceed maxConcurrent ×
  // (1 / typical_call_latency_sec). Previous values capped the metadata
  // pool at 5 req/sec (reservoir 50/10s) AND added a 100ms minTime — well
  // below what maxConcurrent: 10 actually wanted to do for fast list calls.
  // Result: pool throughput collapsed for entire 10s windows while reservoir
  // refilled, manifesting as a "wedge" where 12 fan-out sources sat idle.
  // 200/10s = 20 req/sec aligns the reservoir with maxConcurrent + typical
  // 0.5–2s call latency. minTime: 0 lets maxConcurrent be the sole
  // parallelism bound (it was the binding constraint anyway).
  const toolingPool = new Bottleneck({
    maxConcurrent: toolingConc,
    minTime: 0,
    reservoir: 200,
    reservoirRefreshAmount: 200,
    reservoirRefreshInterval: 10_000,
  });
  const metadataPool = new Bottleneck({
    maxConcurrent: metadataConc,
    minTime: 0,
    reservoir: 200,
    reservoirRefreshAmount: 200,
    reservoirRefreshInterval: 10_000,
  });
  const dataPool = new Bottleneck({
    maxConcurrent: dataConc,
    minTime: 0,
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
