/**
 * W1.5-07 — Per-label deletion-sweep guard.
 *
 * The `--detect-deletions` full-sync sweep at `live-ingest.ts` used to skip
 * only when `streamAborted === true`. A wedged source (W1.5-02) completes
 * with `streamAborted === false`, `parseErrors === 0`, and an empty
 * `touchedQnames` for its label. The set-difference sweep therefore wiped
 * every node of that label — a graph-extinction risk that compounded
 * catastrophically with the wedge cascade.
 *
 * This module encodes the per-label decision: given the prior persisted
 * count, the current run's touched count, and a configurable drop-ratio
 * ceiling, return either `{ proceed: true }` or `{ proceed: false, warning }`
 * with a namespaced-string warning describing why the deletion was refused.
 *
 * Pure / no I/O — the live-ingest sweep wraps this and applies the deletion
 * (or skips it) according to the verdict.
 */

export interface DeletionGuardVerdict {
  proceed: boolean;
  /** Populated only when `proceed === false`. Format documented in
   *  PLAN.md §W1.5-07:
   *  `wedge:detect-deletions:refuse:label=<L>:reason=<R>:...`. */
  warning?: string;
}

/**
 * Parse the `SFGRAPH_DETECT_DELETIONS_MAX_DROP_RATIO` env var (or the value
 * supplied as `raw`) and clamp to `[0, 1]`. Returns the default 0.30 when
 * unset/invalid. Exported so the live-ingest call site and the tests
 * stay in lockstep with the env-var contract.
 */
export function resolveMaxDropRatio(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 0.3;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return 0.3;
  return Math.min(1, Math.max(0, parsed));
}

/**
 * Evaluate the deletion-sweep guard for a single label.
 *
 * - `priorCount === 0` → proceed (no-op anyway).
 * - `priorCount > 0 && touchedCount === 0` → refuse with `reason=empty-stream`.
 * - `dropRatio > maxDropRatio` → refuse with `reason=drop-ratio`.
 * - Otherwise → proceed.
 *
 * Edge case: `touchedCount > priorCount` (new nodes created this run) — the
 * raw ratio would be negative; clamped to 0 → proceed.
 */
export function evaluateDeletionGuard(
  label: string,
  priorCount: number,
  touchedCount: number,
  maxDropRatio: number,
): DeletionGuardVerdict {
  if (priorCount <= 0) return { proceed: true };

  if (touchedCount === 0) {
    return {
      proceed: false,
      warning: `wedge:detect-deletions:refuse:label=${label}:reason=empty-stream:priorCount=${priorCount}`,
    };
  }

  const rawDropRatio = (priorCount - touchedCount) / priorCount;
  const dropRatio = rawDropRatio < 0 ? 0 : rawDropRatio;

  if (dropRatio > maxDropRatio) {
    return {
      proceed: false,
      warning: `wedge:detect-deletions:refuse:label=${label}:reason=drop-ratio:dropped=${priorCount - touchedCount}:prior=${priorCount}:ratio=${dropRatio.toFixed(2)}`,
    };
  }

  return { proceed: true };
}
