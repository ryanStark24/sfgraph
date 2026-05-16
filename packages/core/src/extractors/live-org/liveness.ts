/**
 * Background connection-liveness probe.
 *
 * The dead-socket failure mode reproduces cleanly on corporate VPNs / NATs
 * with idle eviction: jsforce's HTTP socket goes half-open, every
 * outstanding request hangs forever, and the only escape is the per-call
 * 60s `withTimeout` wrap inside each extractor. That works — the run
 * doesn't wedge — but the user-visible experience is "10 sources each
 * fail with timeout errors, ingest finishes with a giant skip list, no
 * obvious cause." This probe makes the cause obvious.
 *
 * Every `intervalMs` we call `conn.identity()` (the cheapest jsforce
 * request: a single REST hit to `/services/oauth2/userinfo`). If it
 * succeeds, the connection is alive; we reset the failure counter and
 * keep going. If it times out or rejects, we increment a counter; once
 * `consecutiveFailures >= maxFailures` we declare the connection dead,
 * log a prominent warning, and fire `onDead` once.
 *
 * We do NOT abort the ingest. Aborting mid-flight would need an AbortSignal
 * threaded through every extractor — too invasive for marginal benefit
 * given the per-call timeouts already cap exposure. The probe's value is
 * SIGNALLING: the user sees "ingest: ⚠ connection lost — surviving
 * extractors will time out within ~60s" and knows to re-run from a fresh
 * terminal, instead of guessing at pool tuning.
 */
export interface LivenessProbeOptions {
  intervalMs?: number;
  identityTimeoutMs?: number;
  maxFailures?: number;
  onDead?: (failureReason: string) => void;
  /** Override the logger; falls back to console. Tests inject silent. */
  log?: (line: string) => void;
}

export interface LivenessProbeHandle {
  stop(): void;
  isDead(): boolean;
  failureCount(): number;
}

const DEFAULTS = {
  intervalMs: 30_000,
  identityTimeoutMs: 10_000,
  maxFailures: 2,
};

/** Race a promise against a setTimeout; reject if the promise doesn't
 *  settle within `ms`. Kept local so this module has no dependency on
 *  rate-limit.ts's withTimeout (which would create a circular ref). */
function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} deadline (${ms}ms)`)), ms);
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

export function startLivenessProbe(
  conn: { identity: () => Promise<unknown> },
  options: LivenessProbeOptions = {},
): LivenessProbeHandle {
  const intervalMs = options.intervalMs ?? DEFAULTS.intervalMs;
  const identityTimeoutMs = options.identityTimeoutMs ?? DEFAULTS.identityTimeoutMs;
  const maxFailures = options.maxFailures ?? DEFAULTS.maxFailures;
  const log = options.log ?? ((line: string) => console.log(line));

  let consecutiveFailures = 0;
  let dead = false;
  let firedDead = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped || dead) return;
    try {
      await withDeadline(conn.identity(), identityTimeoutMs, "liveness identity()");
      // Success — reset counter. Don't log on success or we'd flood.
      consecutiveFailures = 0;
    } catch (e) {
      consecutiveFailures += 1;
      const reason = (e as Error)?.message ?? String(e);
      // Soft warning at the first failure, escalation at the threshold.
      // The intermediate state ("1 of 2 failures") is real signal that
      // something's wrong even before we're sure.
      if (consecutiveFailures < maxFailures) {
        log(
          `ingest: [liveness] probe failed (${consecutiveFailures}/${maxFailures}): ${reason.slice(0, 120)}`,
        );
      } else if (!firedDead) {
        dead = true;
        firedDead = true;
        log("");
        log(
          `ingest: ⚠ CONNECTION LOST — ${consecutiveFailures} consecutive identity() probes failed. Surviving extractors will fail within ~60s as their per-call timeouts trip. The ingest will finish with a skip list. Re-run \`sfgraph ingest --org <alias> --retry-skipped\` from a fresh terminal once connectivity is restored.`,
        );
        log("");
        options.onDead?.(reason);
      }
    }
  };

  // Fire-and-forget interval. The first tick fires after intervalMs (not
  // immediately) — startup is when the connection is freshest and we
  // don't want to add latency to ingest's first API calls by racing
  // identity() against probeCapabilities().
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  // Don't keep the event loop alive on this timer alone; the ingest's
  // own keep-alive sentinel handles that.
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    isDead: () => dead,
    failureCount: () => consecutiveFailures,
  };
}
