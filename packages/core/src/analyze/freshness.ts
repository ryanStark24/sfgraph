import type { NodeFact } from "../domain/index.js";

/**
 * Returns a 0-1 freshness score. 1 = recently modified, 0 = very stale.
 * Uses lastModifiedAt; default 0.5 if missing.
 */
export function freshnessScore(node: NodeFact, now = Date.now()): number {
  const t = node.lastModifiedAt;
  if (!t || t <= 0) return 0.5;
  const ageDays = (now - t) / (1000 * 60 * 60 * 24);
  if (ageDays <= 7) return 1;
  if (ageDays <= 30) return 0.8;
  if (ageDays <= 90) return 0.6;
  if (ageDays <= 180) return 0.4;
  if (ageDays <= 365) return 0.2;
  return 0.05;
}

export type FreshnessBucket = "hot" | "current" | "stale" | "dead";

export function freshnessBucket(score: number): FreshnessBucket {
  if (score >= 0.8) return "hot";
  if (score >= 0.5) return "current";
  if (score >= 0.2) return "stale";
  return "dead";
}
