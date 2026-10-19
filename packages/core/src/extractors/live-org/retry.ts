/**
 * Shared retry / pagination / incomplete-source helpers for live-org
 * extractors.
 *
 * Background (large live-org ingest, 2026-10): several extractors wrapped
 * their network calls in `catch {}` / `catch { continue }` and dropped data
 * silently, so a source that lost thousands of members still logged `✓` and
 * the run reported `skips=0`. The contract now:
 *
 *   1. Every network call that fetches data is retried with backoff
 *      ({@link withRetry}). Stop-waiting (wedge cap-eviction) and read-only
 *      violations are never retried.
 *   2. Whatever still fails after retries is collected and, once the source
 *      has yielded everything it could fetch, re-thrown as an
 *      {@link IncompleteSourceError} naming the lost members. The
 *      bulk-retrieve `failSoft` wrapper turns that into a skip entry keyed by
 *      the source label, so `--retry-skipped` re-runs the source.
 *   3. SOQL reads drain every page ({@link drainSoqlPages}); a plain
 *      `await conn.query(soql)` in jsforce 3 returns ONLY the first batch
 *      (autoFetch defaults to false).
 */
import { ReadOnlyViolationError } from "./errors.js";
import { StopWaitingError, soqlWithTimeout } from "./rate-limit.js";

export interface RetryOptions {
  /** Re-tries after the first failure. Default 3 (env SFGRAPH_FETCH_RETRIES). */
  retries?: number;
  /** Base backoff in ms; doubles per attempt. Default 2000; see
   *  {@link resolveRetryOptions} for the override order. */
  retryBackoffMs?: number;
}

/** Upper bound on retries, whatever the source (env or option). */
export const MAX_RETRIES = 10;
/** Upper bound on a single backoff sleep. Without it `base * 2^attempt`
 *  grows to hours and then overflows setTimeout (Node clamps to 1 ms). */
export const MAX_RETRY_DELAY_MS = 30_000;

const warnedEnv = new Set<string>();

/** Strict non-negative integer env read: `"2s"` / `"1e3"` / `"-1"` are
 *  rejected (with a one-time warning) instead of parseInt-truncated. */
export function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  if (!warnedEnv.has(name)) {
    warnedEnv.add(name);
    console.warn(
      `sfgraph: ignoring ${name}=${JSON.stringify(raw)} (expected a non-negative integer)`,
    );
  }
  return undefined;
}

/** Production base backoff (2 s, doubling: 2 + 4 + 8 s over 3 retries). */
export const DEFAULT_RETRY_BACKOFF_MS = 2_000;

let moduleBackoffMs: number | undefined;

/**
 * Module-level override of the base backoff for callers that can't thread
 * {@link RetryOptions} through (e.g. tests driving the whole live ingest).
 * Pass `undefined` to restore the default.
 */
export function setRetryBackoffMs(ms: number | undefined): void {
  moduleBackoffMs = ms;
}

/**
 * Base backoff resolution, first match wins:
 *   1. explicit `retryBackoffMs` option
 *   2. module override ({@link setRetryBackoffMs})
 *   3. env `SFGRAPH_LIVE_RETRY_BASE_MS`, then `SFGRAPH_FETCH_RETRY_BACKOFF_MS`
 *      (valid non-negative integers only)
 *   4. 0 — ONLY when `VITEST` is set AND none of 1-3 applies
 *   5. {@link DEFAULT_RETRY_BACKOFF_MS}
 *
 * The vitest 0 exists so mocked-org suites never sleep through retries. It is
 * deliberately the LAST override: any process that inherits `VITEST` but
 * talks to a real org (e.g. an e2e test spawning the CLI) gets real backoff
 * back by setting `SFGRAPH_LIVE_RETRY_BASE_MS` (e.g. to 2000) — an explicit
 * env value always beats the vitest default (review M4).
 */
function defaultBackoffMs(): number {
  return (
    moduleBackoffMs ??
    envInt("SFGRAPH_LIVE_RETRY_BASE_MS") ??
    envInt("SFGRAPH_FETCH_RETRY_BACKOFF_MS") ??
    (process.env.VITEST ? 0 : DEFAULT_RETRY_BACKOFF_MS)
  );
}

export function resolveRetryOptions(opts: RetryOptions = {}): Required<RetryOptions> {
  return {
    retries: Math.min(
      MAX_RETRIES,
      Math.max(0, opts.retries ?? envInt("SFGRAPH_FETCH_RETRIES") ?? 3),
    ),
    retryBackoffMs: Math.max(0, opts.retryBackoffMs ?? defaultBackoffMs()),
  };
}

/** Errors that must not be re-tried: the source was told to stop waiting
 *  (wedge cap-eviction), the read-only guard refused the call, or the org
 *  rejected the request outright ({@link isOrgRejection}). */
export function isNonRetryable(e: unknown): boolean {
  return e instanceof StopWaitingError || e instanceof ReadOnlyViolationError || isOrgRejection(e);
}

/** Sleep before retry `attempt` (0-based): base doubling per attempt, capped
 *  at {@link MAX_RETRY_DELAY_MS}. */
export function retryDelayMs(baseMs: number, attempt: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, baseMs * 2 ** attempt);
}

/** Run `fn`, re-trying failures with exponential backoff. `fn` must create a
 *  fresh request per call (jsforce Query objects are single-shot). */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { retries, retryBackoffMs } = resolveRetryOptions(opts);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries || isNonRetryable(e)) throw e;
      const delay = retryDelayMs(retryBackoffMs, attempt);
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/**
 * The org rejected the request itself (unknown type/object/field, no access).
 * Re-trying cannot help and the member is not fetchable at all, so callers
 * treat it as "nothing to fetch" rather than as lost data.
 */
export function isOrgRejection(e: unknown): boolean {
  const msg =
    e instanceof Error
      ? `${(e as { errorCode?: string }).errorCode ?? ""} ${e.name} ${e.message}`
      : String(e);
  return /INVALID_TYPE|INSUFFICIENT_ACCESS|INVALID_FIELD|not a valid metadata type|is not supported|UNSUPPORTED_API_VERSION/i.test(
    msg,
  );
}

/*
 * `unreadable` = "the org refuses this deterministically; do not auto-retry
 * it within this run" (it stays in the skip report and an explicit
 * `--retry-skipped` re-runs it). The bar is deliberately high: an error is a
 * refusal ONLY when
 *   (a) it is a recognised deterministic org rejection (allowlist below), or
 *   (b) the SAME `UNKNOWN_EXCEPTION` came back on
 *       {@link UNKNOWN_EXCEPTION_CONFIRM_ATTEMPTS} attempts spaced by growing
 *       backoff (>= ~10 s in production, see singleItemConfirmDelaysMs).
 * Everything else is ALWAYS transient however often it repeats: HTTP errors
 * (jsforce `ERROR_HTTP_<status>` — 5xx / 408 / 429, html maintenance pages),
 * any fault code not listed here, session / lock / rate-limit faults, and
 * code-less client errors (network, timeouts). (Review C1 / I1.)
 */

/**
 * Fault codes that mean the org rejects THIS request as malformed for it,
 * on every call:
 *  - INVALID_TYPE: the type/sObject does not exist (or is not readable) here.
 *  - INVALID_FIELD: a field the request names does not exist.
 *  - INVALID_CROSS_REFERENCE_KEY: the member references an id that does not
 *    resolve (large live org, NetworkBranding: identical on 9 reads over 3 rounds).
 *  - UNSUPPORTED_API_VERSION: the API version cannot serve this type.
 * INSUFFICIENT_ACCESS is deliberately absent: a permission grant fixes it, so
 * it keeps its own `insufficient_access` skip category and remediation.
 */
const DETERMINISTIC_REJECTION_CODES = new Set([
  "INVALID_TYPE",
  "INVALID_FIELD",
  "INVALID_CROSS_REFERENCE_KEY",
  "UNSUPPORTED_API_VERSION",
]);

/**
 * Deterministic rejections the Metadata API reports under a generic code
 * (usually UNKNOWN_EXCEPTION), recognised by their message:
 *  - "invalid ID field": a server-side internal SOQL on a Data Cloud object
 *    (DataStreamDefinition / ObjectSourceTargetMap on a large live org).
 *  - "Invalid input. See <X> documentation.": the type cannot be listed this
 *    way (ManagedTopic; its container ManagedTopics can).
 *  - "targetObject is invalid": a QuickAction whose target cannot be resolved.
 *  - "not a valid metadata type": the type cannot be read/listed under that
 *    name (e.g. bare `Settings` — an extractor routing problem, but the org's
 *    answer will not change on retry).
 */
const DETERMINISTIC_REJECTION_MESSAGES: RegExp[] = [
  /\binvalid ID field\b/i,
  /\bInvalid input\. See \w+ documentation\b/i,
  /\btargetObject is invalid\b/i,
  /\bnot a valid metadata type\b/i,
];

/** Identical UNKNOWN_EXCEPTION attempts that confirm a refusal. */
export const UNKNOWN_EXCEPTION_CONFIRM_ATTEMPTS = 3;

/**
 * Backoff before re-try 2 and 3 of a single-item read: one doubling step
 * ahead of {@link withRetry}'s schedule (4 s then 8 s at the 2 s production
 * base = 12 s), so a gack is only confirmed after it outlived a short
 * server-side incident.
 */
export function singleItemConfirmDelaysMs(baseMs: number): number[] {
  return [retryDelayMs(baseMs, 1), retryDelayMs(baseMs, 2)];
}

/** The fault code an error carries (`sf:UNKNOWN_EXCEPTION` →
 *  `UNKNOWN_EXCEPTION`, `ERROR_HTTP_503` as is), from jsforce's `errorCode`
 *  or a `CODE:` message prefix. Undefined for code-less client errors. */
function faultCode(e: unknown): string | undefined {
  if (!(e instanceof Error)) return undefined;
  const raw = (e as { errorCode?: unknown }).errorCode;
  if (typeof raw === "string") {
    const code = raw.replace(/^sf:/, "");
    if (/^[A-Z][A-Z0-9_]+$/.test(code)) return code;
  }
  return /^([A-Z][A-Z0-9_]{2,}):/.exec(e.message)?.[1];
}

function isHttpError(code: string | undefined): boolean {
  return code !== undefined && /^ERROR_HTTP_\d+$/.test(code);
}

/** Gack messages carry a fresh ErrorId per call; with a trailing stack hash
 *  `(-?\d+)` the hash identifies the failure, so drop the id. Without a hash
 *  keep the whole message: two different gacks must not compare equal (M1). */
function normaliseGack(msg: string): string {
  return msg
    .replace(
      /(ErrorId if you contact support:\s*)[\w-]+(\s*\(-?\d+\))/gi,
      (_m, pre: string, hash: string) => `${pre}<id>${hash}`,
    )
    .trim();
}

/** Session / lock / rate-limit / server-busy fault codes, and Node network
 *  error codes: always transient, whatever their message says. */
const TRANSIENT_CODE =
  /SESSION|LOCK|LIMIT_EXCEEDED|RATE_LIMIT|TOO_MANY|CONCURRENT|SERVER_UNAVAILABLE|RUNNING_TOO_LONG|TIMEOUT|TIMED_OUT|^E[A-Z]{3,}$/;
/** Network / timeout wording of code-less errors (jsforce, Node, our own
 *  withTimeout): always transient. */
const TRANSIENT_MESSAGE =
  /\b(ECONN\w*|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH)\b|socket hang up|network|timed? ?out\b|timeout/i;

/** True when the message allowlist may be consulted for this error (review
 *  N4): never for an HTTP error, a transient fault code, or a code-less
 *  network / timeout error — those stay transient even if their text
 *  happens to contain an allowlisted phrase. */
function messagePatternsApply(code: string | undefined, msg: string): boolean {
  if (code === undefined) return !TRANSIENT_MESSAGE.test(msg);
  return !isHttpError(code) && !TRANSIENT_CODE.test(code);
}

/**
 * Signature of a recognised deterministic rejection, else undefined. The
 * signature is the code plus the full (ErrorId-normalised) message — not
 * the matched pattern — so ten QuickActions refused for ten DIFFERENT
 * targets are ten signatures, not one (review N1b).
 */
function deterministicRejection(e: unknown): string | undefined {
  if (!(e instanceof Error)) return undefined;
  const code = faultCode(e);
  if (isHttpError(code)) return undefined;
  const sig = `${code ?? ""}|${normaliseGack(e.message)}`;
  if (code && DETERMINISTIC_REJECTION_CODES.has(code)) return sig;
  if (!messagePatternsApply(code, e.message)) return undefined;
  return DETERMINISTIC_REJECTION_MESSAGES.some((re) => re.test(e.message)) ? sig : undefined;
}

/** Signature of an UNKNOWN_EXCEPTION gack (normalised), else undefined. */
function gackSignature(e: unknown): string | undefined {
  if (!(e instanceof Error) || faultCode(e) !== "UNKNOWN_EXCEPTION") return undefined;
  return `UNKNOWN_EXCEPTION|${normaliseGack(e.message)}`;
}

/** True when `e` is a recognised deterministic org rejection: re-trying it
 *  cannot help, so callers stop re-trying at once. */
export function isDeterministicRejection(e: unknown): boolean {
  return deterministicRejection(e) !== undefined;
}

/**
 * True when at least {@link UNKNOWN_EXCEPTION_CONFIRM_ATTEMPTS} attempts all
 * failed with the SAME UNKNOWN_EXCEPTION (ErrorId-normalised when hashed).
 */
export function isSameRefusal(errors: unknown[]): boolean {
  if (errors.length < UNKNOWN_EXCEPTION_CONFIRM_ATTEMPTS) return false;
  const first = gackSignature(errors[0]);
  return first !== undefined && errors.every((e) => gackSignature(e) === first);
}

/**
 * A member (or type listing) the org refuses deterministically (see the
 * rules above). Re-running within the same ingest cannot recover it, so the
 * skip report files it under `unreadable`: listed with the error, not
 * auto-retried, re-run by an explicit `--retry-skipped`. Message / errorCode
 * are the cause's.
 */
export class PlatformRefusalError extends Error {
  readonly unreadable = true;
  readonly errorCode: string | undefined;
  constructor(cause: unknown) {
    super(errMessage(cause), { cause });
    this.name = "PlatformRefusalError";
    this.errorCode = (cause as { errorCode?: string } | null)?.errorCode;
  }
}

export function isPlatformRefusal(e: unknown): e is PlatformRefusalError {
  return e instanceof PlatformRefusalError;
}

/**
 * A whole type the extractor stopped reading after its first
 * {@link UNREADABLE_EARLY_STOP} members were all refused with the same
 * signature: `unreadCount` members were never requested. Filed under
 * `unreadable` like the per-member refusals; message / errorCode are those
 * of the shared refusal.
 */
export class TypeUnreadableError extends PlatformRefusalError {
  readonly unreadCount: number;
  constructor(cause: unknown, unreadCount: number) {
    super(cause instanceof PlatformRefusalError ? (cause.cause ?? cause) : cause);
    this.name = "TypeUnreadableError";
    this.unreadCount = unreadCount;
  }
}

/** Members a type must have refused, all with one signature, before the
 *  generic extractor stops reading the rest of it. */
export const UNREADABLE_EARLY_STOP = 10;

/** Signature of an unreadable member's refusal (the same deterministic
 *  rejection, or the same confirmed gack), or undefined when `e` is not a
 *  platform refusal. */
export function unreadableSignature(e: unknown): string | undefined {
  if (!isPlatformRefusal(e)) return undefined;
  const cause = e.cause ?? e;
  return deterministicRejection(cause) ?? gackSignature(cause);
}

/** Wrap `e` as a {@link PlatformRefusalError} (idempotent). */
export function asPlatformRefusal(e: unknown): PlatformRefusalError {
  return e instanceof PlatformRefusalError ? e : new PlatformRefusalError(e);
}

/**
 * Classify the final error of a fetch that was attempted `attempts` times:
 * a recognised deterministic rejection, or the same UNKNOWN_EXCEPTION on
 * every one of at least 3 attempts, becomes a {@link PlatformRefusalError};
 * anything else is returned unchanged and stays retryable.
 */
export function classifyFinalError(attempts: unknown[]): unknown {
  const last = attempts[attempts.length - 1];
  if (last instanceof StopWaitingError || last instanceof ReadOnlyViolationError) return last;
  if (isDeterministicRejection(last)) return asPlatformRefusal(last);
  return isSameRefusal(attempts) ? asPlatformRefusal(last) : last;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A member (or batch) a source could not fetch after retries. */
export interface FetchFailure {
  name: string;
  error: unknown;
}

/**
 * Thrown by an extractor AFTER it yielded everything it could fetch, when
 * some members were lost. The message names them (truncated to keep the
 * skip line readable) and `failures` carries the full list.
 */
export class IncompleteSourceError extends Error {
  readonly failures: FetchFailure[];
  readonly source: string;
  constructor(source: string, failures: FetchFailure[]) {
    const MAX_NAMES = 25;
    const names = failures.map((f) => f.name);
    const shown = names.slice(0, MAX_NAMES).join(", ");
    const more = names.length > MAX_NAMES ? ` (+${names.length - MAX_NAMES} more)` : "";
    const first = failures[0] ? errMessage(failures[0].error) : "";
    super(
      `${source}: ${failures.length} member(s) not fetched after retries: ${shown}${more}; first error: ${first}`,
      { cause: failures[0]?.error },
    );
    this.name = "IncompleteSourceError";
    this.failures = failures;
    this.source = source;
  }
}

/** Throw an {@link IncompleteSourceError} when `failures` is non-empty. */
export function throwIfIncomplete(source: string, failures: FetchFailure[]): void {
  if (failures.length > 0) throw new IncompleteSourceError(source, failures);
}

interface SoqlPage<T> {
  records?: T[];
  done?: boolean;
  nextRecordsUrl?: string;
}

/** Minimal query surface shared by `conn` (REST) and `conn.tooling`. */
export interface SoqlApi {
  query(soql: string): PromiseLike<unknown>;
  queryMore?(locatorOrUrl: string): PromiseLike<unknown>;
}

/**
 * Drain a SOQL query across ALL pages, re-trying each page fetch. Throws
 * `"<label> drain truncated after N rows (P pages): <cause>"` when a page
 * still fails — rows already yielded stay yielded, so callers keep what was
 * fetched and the truncation still surfaces.
 */
export async function* drainSoqlPages<T>(
  api: SoqlApi,
  soql: string,
  label: string,
  schedule: <R>(fn: () => Promise<R>) => Promise<R>,
  opts: RetryOptions = {},
): AsyncIterable<T> {
  let drained = 0;
  let pages = 0;
  const fetchPage = (fn: () => PromiseLike<unknown>, pageLabel: string) =>
    withRetry(
      () => schedule(() => soqlWithTimeout(Promise.resolve(fn()), pageLabel)),
      opts,
    ) as Promise<SoqlPage<T> | null>;
  const fail = (e: unknown): never => {
    throw new Error(
      `${label} drain truncated after ${drained} rows (${pages} pages): ${errMessage(e)}`,
      { cause: e },
    );
  };
  let page: SoqlPage<T> | null = null;
  try {
    page = await fetchPage(() => api.query(soql), label);
  } catch (e) {
    fail(e);
  }
  while (page) {
    pages += 1;
    for (const r of page.records ?? []) {
      drained += 1;
      yield r;
    }
    if (page.done || !page.nextRecordsUrl || typeof api.queryMore !== "function") break;
    const url = page.nextRecordsUrl;
    const more = api.queryMore.bind(api);
    try {
      page = await fetchPage(() => more(url), `${label} more`);
    } catch (e) {
      fail(e);
    }
  }
}

/** Collect {@link drainSoqlPages} into an array. */
export async function querySoqlAll<T>(
  api: SoqlApi,
  soql: string,
  label: string,
  schedule: <R>(fn: () => Promise<R>) => Promise<R>,
  opts: RetryOptions = {},
): Promise<T[]> {
  const out: T[] = [];
  for await (const r of drainSoqlPages<T>(api, soql, label, schedule, opts)) out.push(r);
  return out;
}

/**
 * Run `it` to completion, recording a thrown error into `failures` (as
 * `name`) instead of propagating it. Used to wrap sub-streams fed to
 * `mergeAsyncIterablesParallel`, which otherwise treats a rejected
 * sub-iterator as silently "done".
 */
export async function* catchInto<T>(
  name: string,
  it: AsyncIterable<T>,
  failures: FetchFailure[],
): AsyncIterable<T> {
  try {
    yield* it;
  } catch (e) {
    if (e instanceof IncompleteSourceError) failures.push(...e.failures);
    else failures.push({ name, error: e });
  }
}
