/**
 * W1.5-07 — Per-label drop-ratio guard on `--detect-deletions` sweep.
 *
 * The pure-decision helper is unit-tested at the function level (cases 1–5);
 * case 6 (multi-label) drives the helper across an in-memory graph store +
 * a hand-rolled touched-by-label map, exercising the same loop body that
 * the live-ingest sweep runs.
 */

import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { evaluateDeletionGuard, resolveMaxDropRatio } from "../detect-deletions-guard.js";

const ORG = asOrgId("00Dxx0000000W1507");

function node(label: string, qname: string, hash = "a".repeat(64)): NodeFact {
  const now = Date.now();
  return {
    orgId: ORG,
    qualifiedName: asQualifiedName(qname),
    label,
    attributes: { name: qname },
    sourceHash: asSha256(hash),
    firstSeenAt: now,
    lastSeenAt: now,
    lastModifiedAt: now,
  };
}

async function freshStore(): Promise<SqliteGraphStore> {
  const store = new SqliteGraphStore({ dbPath: ":memory:" });
  await store.init();
  store.upsertOrg({
    id: ORG,
    alias: "guard-test",
    instanceUrl: "https://x",
    apiVersion: "60.0",
    createdAt: Date.now(),
  });
  return store;
}

describe("W1.5-07 resolveMaxDropRatio", () => {
  it("defaults to 0.30 when env unset", () => {
    expect(resolveMaxDropRatio(undefined)).toBeCloseTo(0.3);
    expect(resolveMaxDropRatio("")).toBeCloseTo(0.3);
  });

  it("parses and clamps to [0, 1]", () => {
    expect(resolveMaxDropRatio("0.5")).toBeCloseTo(0.5);
    expect(resolveMaxDropRatio("1.0")).toBeCloseTo(1.0);
    expect(resolveMaxDropRatio("0.0")).toBeCloseTo(0.0);
    expect(resolveMaxDropRatio("2.0")).toBeCloseTo(1.0); // clamp upper
    expect(resolveMaxDropRatio("-0.5")).toBeCloseTo(0.0); // clamp lower
  });

  it("returns default on garbage input", () => {
    expect(resolveMaxDropRatio("not-a-number")).toBeCloseTo(0.3);
  });
});

describe("W1.5-07 evaluateDeletionGuard (pure decision)", () => {
  // Case 1 — empty-stream refuses.
  it("refuses with empty-stream when priorCount > 0 && touchedCount === 0", () => {
    const v = evaluateDeletionGuard("Profile", 100, 0, 0.3);
    expect(v.proceed).toBe(false);
    expect(v.warning).toBe(
      "wedge:detect-deletions:refuse:label=Profile:reason=empty-stream:priorCount=100",
    );
  });

  // Case 2 — drop-ratio above threshold refuses.
  it("refuses with drop-ratio when dropRatio > maxDropRatio", () => {
    const v = evaluateDeletionGuard("Profile", 100, 50, 0.3);
    expect(v.proceed).toBe(false);
    expect(v.warning).toBe(
      "wedge:detect-deletions:refuse:label=Profile:reason=drop-ratio:dropped=50:prior=100:ratio=0.50",
    );
  });

  // Case 3 — drop-ratio below threshold proceeds.
  it("proceeds when dropRatio <= maxDropRatio", () => {
    const v = evaluateDeletionGuard("Profile", 100, 80, 0.3);
    expect(v.proceed).toBe(true);
    expect(v.warning).toBeUndefined();
  });

  // Case 4 — env override (maxDropRatio = 1.0 still refuses empty-stream).
  it("env override SFGRAPH_DETECT_DELETIONS_MAX_DROP_RATIO=1.0 disables drop-ratio path but empty-stream still refuses", () => {
    const max = resolveMaxDropRatio("1.0");
    // 100% drop with touched > 0 -> dropRatio == 1.0; not strictly > 1.0 -> proceed.
    // But touchedCount === 0 -> empty-stream refusal takes precedence.
    expect(evaluateDeletionGuard("X", 100, 0, max).proceed).toBe(false);
    // touchedCount > 0 path: dropRatio 0.99 > 1.0 is false -> proceed.
    expect(evaluateDeletionGuard("X", 100, 1, max).proceed).toBe(true);
  });

  // Case 5 — priorCount=0 no-op (no warning).
  it("proceeds silently when priorCount === 0", () => {
    const v = evaluateDeletionGuard("Profile", 0, 0, 0.3);
    expect(v.proceed).toBe(true);
    expect(v.warning).toBeUndefined();
  });

  it("clamps negative drop-ratio to 0 (more touched than persisted)", () => {
    const v = evaluateDeletionGuard("Profile", 10, 15, 0.3);
    expect(v.proceed).toBe(true);
    expect(v.warning).toBeUndefined();
  });
});

describe("W1.5-07 sweep loop applied to real graph store", () => {
  let store: SqliteGraphStore;

  beforeEach(async () => {
    store = await freshStore();
  });

  afterEach(async () => {
    await store.close();
  });

  // Replicates the per-label loop body from live-ingest.ts so the test
  // exercises (countNodesByLabel + evaluateDeletionGuard + per-label delete)
  // without needing the full bulkRetrieve fan-out machinery.
  function runSweep(
    touchedByLabel: Map<string, Set<string>>,
    maxDropRatio: number,
  ): { deletions: number; warnings: string[] } {
    const warnings: string[] = [];
    let deletions = 0;
    for (const label of store.listAllLabels()) {
      const priorCount = store.countNodesByLabel(ORG, label);
      const touchedCount = touchedByLabel.get(label)?.size ?? 0;
      const verdict = evaluateDeletionGuard(label, priorCount, touchedCount, maxDropRatio);
      if (!verdict.proceed) {
        if (verdict.warning) warnings.push(verdict.warning);
        continue;
      }
      const touchedSet = touchedByLabel.get(label);
      for (const n of store.listNodesByLabel(ORG, label)) {
        const q = String(n.qualifiedName);
        if (touchedSet?.has(q)) continue;
        store.deleteEdgesFor(ORG, asQualifiedName(q));
        store.deleteNode(ORG, asQualifiedName(q));
        deletions += 1;
      }
    }
    return { deletions, warnings };
  }

  // Case 1 — integration: pre-seed 100 Profile + touched=0 → refuse, no deletes.
  it("empty-stream: refuses to delete any Profile when touchedCount=0", () => {
    const facts: NodeFact[] = [];
    for (let i = 0; i < 100; i++) facts.push(node("Profile", `Profile:P${i}`, "h".repeat(64)));
    store.mergeNodes(facts);

    const { deletions, warnings } = runSweep(new Map(), 0.3);
    expect(deletions).toBe(0);
    expect(store.countNodesByLabel(ORG, "Profile")).toBe(100);
    expect(warnings).toContain(
      "wedge:detect-deletions:refuse:label=Profile:reason=empty-stream:priorCount=100",
    );
  });

  // Case 2 — pre-seed 100 + touched=50 (50% drop) → refuse.
  it("drop-ratio above threshold: refuses to delete any Profile at 50% drop", () => {
    const facts: NodeFact[] = [];
    for (let i = 0; i < 100; i++) facts.push(node("Profile", `Profile:P${i}`, "h".repeat(64)));
    store.mergeNodes(facts);

    const touched = new Map<string, Set<string>>();
    const touchedSet = new Set<string>();
    for (let i = 0; i < 50; i++) touchedSet.add(`Profile:P${i}`);
    touched.set("Profile", touchedSet);

    const { deletions, warnings } = runSweep(touched, 0.3);
    expect(deletions).toBe(0);
    expect(store.countNodesByLabel(ORG, "Profile")).toBe(100);
    expect(warnings).toContain(
      "wedge:detect-deletions:refuse:label=Profile:reason=drop-ratio:dropped=50:prior=100:ratio=0.50",
    );
  });

  // Case 3 — pre-seed 100 + touched=80 (20% drop) → proceed; 20 deletions; no refuse warning.
  it("drop-ratio below threshold: deletes the 20 missing Profiles", () => {
    const facts: NodeFact[] = [];
    for (let i = 0; i < 100; i++) facts.push(node("Profile", `Profile:P${i}`, "h".repeat(64)));
    store.mergeNodes(facts);

    const touched = new Map<string, Set<string>>();
    const touchedSet = new Set<string>();
    for (let i = 0; i < 80; i++) touchedSet.add(`Profile:P${i}`);
    touched.set("Profile", touchedSet);

    const { deletions, warnings } = runSweep(touched, 0.3);
    expect(deletions).toBe(20);
    expect(store.countNodesByLabel(ORG, "Profile")).toBe(80);
    expect(warnings.filter((w) => w.startsWith("wedge:detect-deletions:refuse"))).toEqual([]);
  });

  // Case 4 — env override SFGRAPH_DETECT_DELETIONS_MAX_DROP_RATIO=1.0 disables
  // drop-ratio refusal; but empty-stream is still refused (W1.5-07 spec).
  // The test simulates the override directly via the resolved value.
  it("env override 1.0: drop-ratio path off, but empty-stream still refuses", () => {
    const facts: NodeFact[] = [];
    for (let i = 0; i < 100; i++) facts.push(node("Profile", `Profile:P${i}`, "h".repeat(64)));
    store.mergeNodes(facts);

    const prevEnv = process.env.SFGRAPH_DETECT_DELETIONS_MAX_DROP_RATIO;
    process.env.SFGRAPH_DETECT_DELETIONS_MAX_DROP_RATIO = "1.0";
    try {
      const max = resolveMaxDropRatio(process.env.SFGRAPH_DETECT_DELETIONS_MAX_DROP_RATIO);

      // touched=0 → STILL refuses (empty-stream is independent of the
      // drop-ratio threshold; this is by design per W1.5-07).
      const empty = runSweep(new Map(), max);
      expect(empty.deletions).toBe(0);
      expect(empty.warnings).toContain(
        "wedge:detect-deletions:refuse:label=Profile:reason=empty-stream:priorCount=100",
      );
      // re-seed because nothing was deleted; counts unchanged.
      expect(store.countNodesByLabel(ORG, "Profile")).toBe(100);

      // touched=1 of 100 → 99% drop, but threshold is 1.0 so dropRatio > max
      // is false (0.99 > 1.0 === false) → proceed → 99 deletions.
      const touched = new Map<string, Set<string>>();
      touched.set("Profile", new Set(["Profile:P0"]));
      const heavy = runSweep(touched, max);
      expect(heavy.deletions).toBe(99);
      expect(heavy.warnings.filter((w) => w.startsWith("wedge:detect-deletions:refuse"))).toEqual(
        [],
      );
      expect(store.countNodesByLabel(ORG, "Profile")).toBe(1);
    } finally {
      if (prevEnv === undefined) {
        // biome-ignore lint/performance/noDelete: cleanest reset of an env var override
        delete process.env.SFGRAPH_DETECT_DELETIONS_MAX_DROP_RATIO;
      } else {
        process.env.SFGRAPH_DETECT_DELETIONS_MAX_DROP_RATIO = prevEnv;
      }
    }
  });

  // Case 5 — empty graph + empty touch: no-op, no warnings.
  it("priorCount=0 + touched empty: no-op, no warnings", () => {
    const { deletions, warnings } = runSweep(new Map(), 0.3);
    expect(deletions).toBe(0);
    expect(warnings).toEqual([]);
  });

  // Case 6 — multi-label: Profile clean, PermissionSet empty-stream refused,
  // CustomObject 10% drop proceeds. Exactly ONE refuse warning emitted.
  it("multi-label: refuse only the empty-stream label; sweep other labels normally", () => {
    const facts: NodeFact[] = [];
    for (let i = 0; i < 100; i++) facts.push(node("Profile", `Profile:P${i}`, "h".repeat(64)));
    for (let i = 0; i < 50; i++)
      facts.push(node("PermissionSet", `PermissionSet:PS${i}`, "i".repeat(64)));
    for (let i = 0; i < 200; i++)
      facts.push(node("CustomObject", `CustomObject:CO${i}`, "j".repeat(64)));
    store.mergeNodes(facts);

    const touched = new Map<string, Set<string>>();
    const profileTouched = new Set<string>();
    for (let i = 0; i < 100; i++) profileTouched.add(`Profile:P${i}`);
    touched.set("Profile", profileTouched);
    // PermissionSet: intentionally NOT in the map (touchedCount === 0).
    const coTouched = new Set<string>();
    for (let i = 0; i < 180; i++) coTouched.add(`CustomObject:CO${i}`);
    touched.set("CustomObject", coTouched);

    const { deletions, warnings } = runSweep(touched, 0.3);

    // Profile: no drop, nothing deleted.
    expect(store.countNodesByLabel(ORG, "Profile")).toBe(100);
    // PermissionSet: refused, all 50 survive.
    expect(store.countNodesByLabel(ORG, "PermissionSet")).toBe(50);
    // CustomObject: 20 missing nodes deleted; 180 remain.
    expect(store.countNodesByLabel(ORG, "CustomObject")).toBe(180);
    expect(deletions).toBe(20);

    const refuseWarnings = warnings.filter((w) => w.startsWith("wedge:detect-deletions:refuse"));
    expect(refuseWarnings).toHaveLength(1);
    expect(refuseWarnings[0]).toBe(
      "wedge:detect-deletions:refuse:label=PermissionSet:reason=empty-stream:priorCount=50",
    );
  });
});
