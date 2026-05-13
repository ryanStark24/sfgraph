import type { ParseResult } from "../contract.js";

/**
 * Fallback path used when a DataPack type isn't recognized. Emits zero nodes
 * and lets the caller decide what to do.
 */
export function vlocityFallback(): ParseResult {
  return { nodes: [], edges: [] };
}
