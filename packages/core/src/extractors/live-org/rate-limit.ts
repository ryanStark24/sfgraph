import Bottleneck from "bottleneck";
import pLimit from "p-limit";

/** Cap concurrent query invocations against a single org connection. */
export const queryLimit = pLimit(5);

/**
 * Per-org Salesforce REST rate-limiter. Conservative defaults; reservoir replenishes
 * every minute. On 429-style failures with Retry-After, retry once after the indicated
 * delay (or fall back to a 30s back-off).
 */
export const limiter = new Bottleneck({
  maxConcurrent: 10,
  minTime: 50,
  reservoir: 100,
  reservoirRefreshAmount: 100,
  reservoirRefreshInterval: 60_000,
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

limiter.on("failed", (err, jobInfo) => {
  const wait = parseRetryAfter(err);
  if (wait != null && jobInfo.retryCount < 1) {
    return wait * 1000;
  }
  return null;
});

/** Helper that runs a single SOQL/Tooling callable through both gates. */
export function scheduleQuery<T>(fn: () => Promise<T>): Promise<T> {
  return limiter.schedule(() => queryLimit(fn));
}
