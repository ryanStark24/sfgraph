import { expect } from "vitest";
import type { GraphPayload } from "../api.js";

/**
 * Endpoint integrity for every graph-returning web endpoint: each edge's
 * source and target must be an id in the returned node list, and node ids
 * must be unique. Use on the payload of /api/neighborhood, /api/overview,
 * /api/full and /api/schema.
 */
export function assertGraphIntegrity(g: GraphPayload, where: string): void {
  const ids = new Set(g.nodes.map((n) => n.id));
  expect(ids.size, `${where}: duplicate node ids`).toBe(g.nodes.length);
  const dangling = g.edges.filter((e) => !ids.has(e.source) || !ids.has(e.target));
  expect(dangling, `${where}: edges with an endpoint missing from nodes`).toEqual([]);
}
