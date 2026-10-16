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

/**
 * Task 11c: the sweep must not delete a node whose source this run skipped
 * (skipReport.skips, unreadable entries included): a skipped source touched
 * nothing, so "not touched" says nothing about whether the node still exists.
 *
 * A skip label is mapped to the metadata types it covers. A node's type is
 * read from its `sourceUri` (`sf://<scope>/<Type>/...`; `sf://describe/` is
 * CustomObject), falling back to the node label. A label this table does not
 * know (`discovery`, a whole-source `vlocity` failure, anything new) refuses
 * the whole sweep. `mcd-baseline:*` skips protect nothing: the baseline only
 * adds edges, it never touches nodes.
 */
export interface SkipProtection {
  /** No node may be deleted this run. */
  refuseAll: boolean;
  /** Protected metadata types (exact). */
  types: ReadonlySet<string>;
  /** Protected type prefixes (e.g. `Omni` for a whole OmniStudio source skip). */
  prefixes: readonly string[];
  /** The skip labels behind `refuseAll` (for the log line). */
  unknownLabels: readonly string[];
}

const SOURCE_LABEL_TYPES: Record<string, readonly string[]> = {
  apex: ["ApexClass", "ApexTrigger"],
  lwc: ["LightningComponentBundle"],
  flow: ["Flow"],
  object: ["CustomObject"],
  security: ["Profile", "PermissionSet", "SharingRules"],
  integration: ["NamedCredential", "ExternalServiceRegistration"],
  "custom-settings": ["CustomSetting"],
};

export function skipProtection(skips: ReadonlyArray<{ label: string }>): SkipProtection {
  const types = new Set<string>();
  const prefixes: string[] = [];
  const unknown: string[] = [];
  for (const { label } of skips) {
    const fixed = SOURCE_LABEL_TYPES[label];
    if (fixed) {
      for (const t of fixed) types.add(t);
      continue;
    }
    if (label.startsWith("mcd-baseline:")) continue;
    const [head, t] = label.split(":");
    if ((head === "generic" || head === "vlocity" || head === "omnistudio-retrieve") && t) {
      types.add(t);
      continue;
    }
    if (label === "omnistudio" || label === "omnistudio-retrieve") {
      if (!prefixes.includes("Omni")) prefixes.push("Omni");
      continue;
    }
    unknown.push(label);
  }
  return { refuseAll: unknown.length > 0, types, prefixes, unknownLabels: unknown };
}

const SF_URI_TYPE = /^sf:\/\/[^/]+\/([^/]+)\//;

/** The metadata type a node came from (sourceUri first, node label fallback). */
export function nodeSourceType(node: {
  label: string;
  attributes?: Record<string, unknown>;
}): string {
  const uri = node.attributes?.sourceUri;
  if (typeof uri === "string") {
    if (uri.startsWith("sf://describe/")) return "CustomObject";
    const m = SF_URI_TYPE.exec(uri);
    if (m?.[1]) return m[1];
  }
  return node.label;
}

export function isSkipProtected(
  p: SkipProtection,
  node: { label: string; attributes?: Record<string, unknown> },
): boolean {
  if (p.refuseAll) return true;
  if (p.types.size === 0 && p.prefixes.length === 0) return false;
  const t = nodeSourceType(node);
  if (p.types.has(t) || p.types.has(node.label)) return true;
  return p.prefixes.some((x) => t.startsWith(x) || node.label.startsWith(x));
}
