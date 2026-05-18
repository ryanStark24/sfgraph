import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RawMember } from "../../../interfaces/metadata-source.js";
import { iterLwc } from "../lwc.js";

/**
 * Phase 1.5 W1.5-04 unit tests.
 *
 * Contract under test:
 *   - Per-bundle resource fetches inside `iterLwc` run as a sliding window of
 *     WINDOW=8 concurrent calls (not serial).
 *   - Each bundle's record is yielded as soon as that bundle's processing
 *     finishes — not batched at end-of-iterator. Yields can arrive out of
 *     input order (yield-as-completed). This keeps the source's
 *     `lastYieldedAt` heartbeat fresh and prevents the W1.5-02 watchdog from
 *     firing on a slow-but-not-wedged peer.
 *   - One bundle's thrown error does NOT affect peers: it emits a
 *     `wedge:lwc:bundleFetchFailed:...` warning and skips yielding (no
 *     record), but in-flight peers still complete.
 *   - The managed-namespace fast-path is unaffected (zero HTTP calls, still
 *     yields a stub) but is out of scope for this suite — separately covered.
 *
 * Real timers are used (not fake) so Promise.race against setTimeout-based
 * resolutions reflects production semantics.
 */

interface FakeBundle {
  Id: string;
  DeveloperName: string;
  NamespacePrefix?: string | null;
  LastModifiedDate?: string | null;
}

interface FakeBehavior {
  /** ms to delay before resolving (default 0) */
  delayMs?: number;
  /** if true, throw instead of resolve */
  throws?: boolean;
}

/**
 * Build a fake jsforce-shaped `conn` whose `tooling.query` returns:
 *   - the bundle list on the first call
 *   - per-bundle resources for subsequent calls, with configurable timing
 *
 * The behavior map is keyed by bundle DeveloperName.
 */
function makeConn(
  bundles: FakeBundle[],
  behaviors: Record<string, FakeBehavior>,
  onResourceCall?: (devName: string, atMs: number) => void,
) {
  const startMs = Date.now();
  return {
    tooling: {
      query: (soql: string) => {
        // First-call: the bundle-list SOQL.
        if (soql.includes("FROM LightningComponentBundle")) {
          return Promise.resolve({ records: bundles });
        }
        // Per-bundle resource SOQL — extract the bundle Id, look up its
        // DeveloperName, then honor the behavior map.
        const idMatch = soql.match(/LightningComponentBundleId\s*=\s*'([^']+)'/);
        const id = idMatch?.[1] ?? "";
        const bundle = bundles.find((b) => b.Id === id);
        const devName = bundle?.DeveloperName ?? "<unknown>";
        const b = behaviors[devName] ?? {};
        const t = Date.now() - startMs;
        onResourceCall?.(devName, t);
        if (b.throws) {
          return new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error(`mock-throw:${devName}`)), b.delayMs ?? 0);
          });
        }
        return new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                records: [{ FilePath: `lwc/${devName}/${devName}.js`, Source: `// ${devName}` }],
              }),
            b.delayMs ?? 0,
          );
        });
      },
    },
  };
}

async function collectWithTimings(
  iter: AsyncIterable<RawMember>,
): Promise<Array<{ member: RawMember; atMs: number }>> {
  const start = Date.now();
  const out: Array<{ member: RawMember; atMs: number }> = [];
  for await (const member of iter) {
    out.push({ member, atMs: Date.now() - start });
  }
  return out;
}

describe("iterLwc — W1.5-04 parallelization", () => {
  const originalEnv = { ...process.env };
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Suppress the debug log + warning noise during test runs but capture for
    // assertion. Replace process.env wholesale with a filtered snapshot
    // (biome forbids `delete`); strip the SFGRAPH_* keys that would change
    // iterLwc's branching so each test runs in a clean state.
    const cleaned: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(originalEnv)) {
      if (
        k === "SFGRAPH_DEBUG_INGEST" ||
        k === "SFGRAPH_SKIP_LWC" ||
        k === "SFGRAPH_INCLUDE_MANAGED" ||
        k === "SFGRAPH_INCLUDE_MANAGED_LWC"
      ) {
        continue;
      }
      cleaned[k] = v;
    }
    process.env = cleaned as NodeJS.ProcessEnv;
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    process.env = { ...originalEnv };
  });

  it("runs per-bundle fetches in parallel (slow bundle does NOT serialize peers)", async () => {
    // 10 bundles: one slow (200ms), nine instant. With WINDOW=8 + the
    // sliding-window draining one slot at a time, the slow bundle stays in
    // flight while the rest stream through. Total elapsed should be
    // dominated by the slow bundle (~200ms), NOT serial (10*200ms = 2s).
    const bundles: FakeBundle[] = [
      { Id: "01p0", DeveloperName: "slow-bundle" },
      ...Array.from({ length: 9 }, (_, i) => ({
        Id: `01p${i + 1}`,
        DeveloperName: `fast-${i + 1}`,
      })),
    ];
    const behaviors: Record<string, FakeBehavior> = {
      "slow-bundle": { delayMs: 200 },
    };
    const conn = makeConn(bundles, behaviors);
    const start = Date.now();
    const out = await collectWithTimings(iterLwc(conn));
    const elapsed = Date.now() - start;

    expect(out).toHaveLength(10);
    // Serial baseline would be ~2000ms (10 * 200ms); parallel with WINDOW=8
    // should finish in roughly one slow-bundle-latency. 600ms gives generous
    // slack for CI scheduler jitter and test overhead.
    expect(elapsed).toBeLessThan(600);
  });

  it("yields fast bundles BEFORE the slow bundle completes (heartbeat freshness)", async () => {
    // 6 bundles: 1 slow (500ms), 5 instant. The fast ones must yield well
    // before the 500ms mark — that's what keeps the source's lastYieldedAt
    // alive while one bundle is still in flight.
    const bundles: FakeBundle[] = [
      { Id: "01p0", DeveloperName: "slow-bundle" },
      ...Array.from({ length: 5 }, (_, i) => ({
        Id: `01p${i + 1}`,
        DeveloperName: `fast-${i + 1}`,
      })),
    ];
    const behaviors: Record<string, FakeBehavior> = {
      "slow-bundle": { delayMs: 500 },
    };
    const conn = makeConn(bundles, behaviors);
    const yieldTimings: Array<{ name: string; atMs: number }> = [];
    const start = Date.now();
    for await (const member of iterLwc(conn)) {
      yieldTimings.push({
        name: member.ref.memberName,
        atMs: Date.now() - start,
      });
    }

    expect(yieldTimings).toHaveLength(6);
    // At least one fast-* yield must arrive before 500ms (the slow-bundle
    // completion time). If the iterator were serial, only the first bundle
    // (slow-bundle) would yield by 500ms.
    const fastYieldsBeforeSlowCompletes = yieldTimings.filter(
      (y) => y.name.startsWith("fast-") && y.atMs < 500,
    );
    expect(fastYieldsBeforeSlowCompletes.length).toBeGreaterThanOrEqual(5);
    // slow-bundle should be the LAST yield (it has the longest latency).
    expect(yieldTimings[yieldTimings.length - 1]?.name).toBe("slow-bundle");
  });

  it("isolates a single bundle's failure — peers still yield, no exception escapes", async () => {
    const bundles: FakeBundle[] = [
      { Id: "01p0", DeveloperName: "bad-bundle" },
      { Id: "01p1", DeveloperName: "good-1" },
      { Id: "01p2", DeveloperName: "good-2" },
      { Id: "01p3", DeveloperName: "good-3" },
    ];
    const behaviors: Record<string, FakeBehavior> = {
      "bad-bundle": { throws: true },
    };
    const conn = makeConn(bundles, behaviors);
    // Must not throw out of the iterator.
    const out = await collectWithTimings(iterLwc(conn));
    const names = out.map((o) => o.member.ref.memberName).sort();
    expect(names).toEqual(["good-1", "good-2", "good-3"]);

    // Exactly one wedge warning for the bad bundle, namespaced per spec.
    const warningCalls = warnSpy.mock.calls.map((c) => String(c[0]));
    const bundleFailureWarnings = warningCalls.filter((w) =>
      w.includes("wedge:lwc:bundleFetchFailed"),
    );
    expect(bundleFailureWarnings).toHaveLength(1);
    expect(bundleFailureWarnings[0]).toContain("bundleName=bad-bundle");
    expect(bundleFailureWarnings[0]).toContain("bundleId=01p0");
  });

  it("handles an empty bundle list: zero yields, no errors", async () => {
    const conn = makeConn([], {});
    const out = await collectWithTimings(iterLwc(conn));
    expect(out).toEqual([]);
    // No warnings should be emitted for an empty list.
    const warningCalls = warnSpy.mock.calls.map((c) => String(c[0]));
    const lwcWarnings = warningCalls.filter((w) => w.includes("lwc"));
    expect(lwcWarnings).toEqual([]);
  });

  it("yields in completion order, not input order (yield-as-completed)", async () => {
    // Three bundles ordered [A, B, C] in input. We tune their latencies so
    // C resolves first, then A, then B. Yield order MUST mirror that
    // completion order — this documents the intentional design.
    const bundles: FakeBundle[] = [
      { Id: "01pA", DeveloperName: "A" },
      { Id: "01pB", DeveloperName: "B" },
      { Id: "01pC", DeveloperName: "C" },
    ];
    const behaviors: Record<string, FakeBehavior> = {
      A: { delayMs: 80 },
      B: { delayMs: 160 },
      C: { delayMs: 20 },
    };
    const conn = makeConn(bundles, behaviors);
    const out = await collectWithTimings(iterLwc(conn));
    const names = out.map((o) => o.member.ref.memberName);
    expect(names).toEqual(["C", "A", "B"]);
  });
});
