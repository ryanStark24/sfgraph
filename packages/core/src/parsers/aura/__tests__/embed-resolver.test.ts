import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeFact, NodeFact } from "../../../domain/index.js";
import { SqliteGraphStore } from "../../../storage/sqlite/graph-store.js";
import { resolveAuraEmbeds } from "../embed-resolver.js";

// review R1-4: the re-target (delete + re-merge) is one transaction, so a
// failure part-way never leaves an Aura bundle without its embed edges.
const ORG = asOrgId("org1");
let dir: string;
let store: SqliteGraphStore;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-r14-"));
  store = new SqliteGraphStore({ dbPath: path.join(dir, "g.sqlite") });
  await store.init();
});
afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

const node = (q: string): NodeFact => ({
  orgId: ORG,
  qualifiedName: asQualifiedName(q),
  label: q.split(":")[0] as string,
  attributes: {},
  sourceHash: asSha256("h"),
  firstSeenAt: 1,
  lastSeenAt: 1,
  lastModifiedAt: 1,
});
const edge = (src: string, rel: string, dst: string): EdgeFact => ({
  orgId: ORG,
  srcQualifiedName: asQualifiedName(src),
  dstQualifiedName: asQualifiedName(dst),
  relType: rel as EdgeFact["relType"],
  attributes: {},
  firstSeenAt: 1,
  lastSeenAt: 1,
});

describe("review R1-4: resolveAuraEmbeds is atomic", () => {
  it("rolls the deletes back when the re-merge fails", () => {
    store.mergeNodes([node("AuraComponent:Shell"), node("AuraComponent:lowerAura")]);
    store.mergeEdges([edge("AuraComponent:Shell", "EMBEDS_LWC", "LWC:lowerAura")]);
    vi.spyOn(store, "mergeEdges").mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() => resolveAuraEmbeds(store, ORG)).toThrow("boom");
    vi.restoreAllMocks();
    const out = store
      .listEdgesFrom(ORG, asQualifiedName("AuraComponent:Shell"))
      .map((e) => `${e.relType}|${String(e.dstQualifiedName)}`);
    expect(out).toEqual(["EMBEDS_LWC|LWC:lowerAura"]);
    // And without the failure it re-targets.
    expect(resolveAuraEmbeds(store, ORG).retargeted).toBe(1);
    expect(
      store
        .listEdgesFrom(ORG, asQualifiedName("AuraComponent:Shell"))
        .map((e) => `${e.relType}|${String(e.dstQualifiedName)}`),
    ).toEqual(["EMBEDS_AURA|AuraComponent:lowerAura"]);
  });
});
