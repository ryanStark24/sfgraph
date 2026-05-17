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
 * BOTH timeout and non-timeout errors. On error we halve the batch and
 * retry each half in parallel until either the half succeeds or we hit a
 * single-item slice (in which case we record null for the genuine "this
 * record cannot be ingested" case).
 *
 * Original behavior dropped the entire batch on timeout (the rationale was
 * that smaller batches each at full timeout budget multiplies wall-clock).
 * That was too coarse: a single slow record in a batch of 10 would
 * silently drop the other 9 healthy records. We now bisect on timeouts
 * too, bounded by `MAX_BISECT_DEPTH` so a systemic outage can't recurse
 * indefinitely. At depth ceiling, return nulls without further attempts.
 */
const MAX_BISECT_DEPTH = (() => {
  const env = Number.parseInt(process.env.SFGRAPH_BISECT_MAX_DEPTH ?? "", 10);
  return Number.isFinite(env) && env > 0 ? env : 6;
})();

export async function readMetadataBatchAdaptive<TItem extends { fullName: string }>(
  conn: { metadata: { read: (type: string, names: string[]) => Promise<unknown> } },
  type: string,
  items: TItem[],
  depth = 0,
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
    const isDebug = process.env.SFGRAPH_DEBUG_INGEST === "1";
    const errMsg = (e as Error)?.message ?? String(e);
    // Single-item slice → genuine skip.
    if (items.length === 1) {
      if (isDebug) {
        console.warn(
          `metadata.read ${type}: dropping ${items[0]?.fullName ?? "?"} after single-item failure: ${errMsg}`,
        );
      }
      return [null];
    }
    // Bisect ceiling → drop the slice to bound wall-clock cost.
    if (depth >= MAX_BISECT_DEPTH) {
      if (isDebug) {
        console.warn(
          `metadata.read ${type}: bisect depth ceiling (${MAX_BISECT_DEPTH}) reached; dropping ${items.length} record(s): ${items.map((i) => i.fullName).join(",")} (${errMsg})`,
        );
      }
      return items.map(() => null);
    }
    const mid = Math.ceil(items.length / 2);
    const [left, right] = await Promise.all([
      readMetadataBatchAdaptive(conn, type, items.slice(0, mid), depth + 1),
      readMetadataBatchAdaptive(conn, type, items.slice(mid), depth + 1),
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
// ---------------------------------------------------------------------------
// W2-05: Tooling/Data SOQL auto-rebatcher for oversized IN-clauses
// ---------------------------------------------------------------------------
//
// Some Tooling and Data SOQL calls embed a SOQL `IN (...)` set built from
// dynamic ID lists. When that list grows the SOQL string can exceed
// Salesforce's per-request size limit (414 URI Too Long for GET-routed
// queries; 431 Request Header Fields Too Large in some proxy paths) before
// the query gets a chance to run. Older Happy-Soup-style toolchains
// rebatched by halving the ID set; sfgraph extractors had been chunking
// defensively at 200 IDs each. This helper centralizes both: the caller
// passes an ID list and a SOQL template, the helper picks a batch size and
// recursively splits on rebatchable errors.
//
// Anti-features (intentionally NOT done here): retry on rate-limit (the
// pools above handle that), retry on auth/permission errors (those need
// caller-side classification), or any logic that mutates the SOQL beyond
// substituting the IDs placeholder.

export interface SoqlRebatchOpts<TRecord> {
  /** Quoted, comma-joined ID list. The caller has already escaped each id. */
  ids: string[];
  /** SOQL template containing `${IDS}` exactly once — replaced with the
   *  quoted, comma-joined list at execution time. */
  template: string;
  /** Greppable label for timeouts + warning messages. */
  label: string;
  /** Maximum IDs per request before the helper pre-splits. Default 300 —
   *  conservative below the documented SOQL `IN()` 4000 cap but above the
   *  200 most extractors hand-chunked at. */
  rebatchAt?: number;
  /** Maximum recursive split depth before giving up on a slice. Default 6 —
   *  enough to cover (300 × 2^6 = 19200) IDs in a single starting batch. */
  maxDepth?: number;
  /**
   * Pool to schedule each individual SOQL call through. Defaults to the
   * Tooling pool; pass `scheduleQuery`/`scheduleData` for non-Tooling
   * paths. The helper does NOT pick a pool based on the SOQL itself —
   * staying explicit avoids "this call went to the wrong pool, why is
   * Tooling starved" surprises.
   */
  scheduler?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Per-call timeout label override. Defaults to SOQL_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Function that runs the actual SOQL on the right API surface
   *  (`conn.tooling.query` or `conn.query`). Returning a value with a
   *  `records` array is required. */
  runner: (soql: string) => Promise<{ records?: TRecord[] }>;
}

/** Detect errors that should trigger a smaller-batch retry rather than
 *  failing the whole call. Tries the canonical jsforce error shape first
 *  (`statusCode` / `errorCode`) then falls back to message matching. */
export function isRebatchableSoqlError(err: unknown): boolean {
  const e = err as { statusCode?: number; errorCode?: string; message?: string } | undefined;
  if (e?.statusCode === 414 || e?.statusCode === 431) return true;
  if (e?.errorCode === "URI_TOO_LONG" || e?.errorCode === "REQUEST_HEADER_FIELDS_TOO_LARGE") {
    return true;
  }
  const msg = (e?.message ?? String(err)).toLowerCase();
  if (msg.includes("uri too long") || msg.includes("414")) return true;
  if (msg.includes("request header fields too large") || msg.includes("431")) return true;
  if (msg.includes("malformed_query") && msg.includes("characters")) return true;
  return false;
}

/**
 * Execute `template` against `ids`, splitting the ID set on a rebatchable
 * error or when it exceeds `rebatchAt`. Returns the merged record set.
 * Throws only on non-rebatchable errors (the caller's existing failSoft /
 * onError plumbing handles those).
 */
export async function runSoqlInRebatchable<TRecord>(
  opts: SoqlRebatchOpts<TRecord>,
): Promise<TRecord[]> {
  const rebatchAt = opts.rebatchAt ?? 300;
  const maxDepth = opts.maxDepth ?? 6;
  const scheduler = opts.scheduler ?? scheduleQuery;
  const timeoutMs = opts.timeoutMs ?? SOQL_TIMEOUT_MS;

  if (opts.ids.length === 0) return [];

  if (!opts.template.includes("${IDS}")) {
    throw new Error(
      `runSoqlInRebatchable(${opts.label}): template must contain \`\${IDS}\` placeholder`,
    );
  }

  const runSlice = async (slice: string[], depth: number): Promise<TRecord[]> => {
    const idList = slice.join(",");
    const soql = opts.template.replace("${IDS}", idList);
    try {
      const res = await scheduler(() =>
        withTimeout(opts.runner(soql), timeoutMs, `soql ${opts.label}`),
      );
      return res?.records ?? [];
    } catch (e) {
      if (slice.length === 1 || depth >= maxDepth) throw e;
      if (!isRebatchableSoqlError(e)) throw e;
      // Halve and recurse.
      const mid = Math.ceil(slice.length / 2);
      const [left, right] = await Promise.all([
        runSlice(slice.slice(0, mid), depth + 1),
        runSlice(slice.slice(mid), depth + 1),
      ]);
      return [...left, ...right];
    }
  };

  // Pre-chunk to rebatchAt. Each chunk runs through the scheduler
  // independently so the pool's concurrency cap controls fan-out.
  const chunks: string[][] = [];
  for (let i = 0; i < opts.ids.length; i += rebatchAt) {
    chunks.push(opts.ids.slice(i, i + rebatchAt));
  }
  const results = await Promise.all(chunks.map((c) => runSlice(c, 0)));
  return results.flat();
}

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
