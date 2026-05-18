import { METADATA_CATEGORY } from "../../../domain/index.js";
import type { RawMember } from "../../interfaces/metadata-source.js";
import { scheduleQuery, soqlWithTimeout } from "../rate-limit.js";

interface BundleRow {
  Id: string;
  DeveloperName: string;
  NamespacePrefix?: string | null;
  LastModifiedDate?: string | null;
}

interface ResourceRow {
  FilePath: string;
  Source: string;
}

export async function* iterLwc(conn: any): AsyncIterable<RawMember> {
  const debug = process.env.SFGRAPH_DEBUG_INGEST === "1";
  const bundles = (await scheduleQuery(() =>
    soqlWithTimeout(
      conn.tooling.query(
        "SELECT Id, DeveloperName, NamespacePrefix, LastModifiedDate FROM LightningComponentBundle",
      ),
      "tooling LightningComponentBundle list",
    ),
  )) as { records?: BundleRow[] } | null;
  const allBundles = bundles?.records ?? [];
  if (debug) {
    const managedCount = allBundles.filter((b) => b.NamespacePrefix).length;
    console.log(`ingest: [debug] lwc bundles total=${allBundles.length} managed=${managedCount}`);
  }
  // Skip-list via env: comma-separated DeveloperNames to silently skip.
  // Lets users work around a specific bundle that crashes the run
  // (e.g. `SFGRAPH_SKIP_LWC=blackholeBundle,otherBadBundle`) without
  // touching the rest of ingest.
  const skipSet = new Set(
    (process.env.SFGRAPH_SKIP_LWC ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
  // Managed-package LWCs return Source = `<hidden>` (Salesforce redacts
  // source unless the package is unlocked + user has View All Source).
  // Their content is unusable for graph analysis, *and* fetching their
  // resources through jsforce reliably crashes the Node process for some
  // bundles on macOS 26+ (silent SIGKILL with no error). We emit a
  // metadata-only node for each (so the bundle still appears in the
  // graph for inventory / cross-org diff purposes) and skip the doomed
  // resource fetch.
  //
  // Override via SFGRAPH_INCLUDE_MANAGED=1 (global, applies to all
  // managed-package extractors) or SFGRAPH_INCLUDE_MANAGED_LWC=1 (LWC-
  // specific). Either turns this off — fetches resources for managed
  // bundles too, accepting the crash risk for users who explicitly want it.
  const includeManaged =
    process.env.SFGRAPH_INCLUDE_MANAGED === "1" || process.env.SFGRAPH_INCLUDE_MANAGED_LWC === "1";

  // W1.5-04: sliding-window of WINDOW=8 concurrent per-bundle resource fetches.
  // Mirrors the vlocity/runner.ts pattern (WINDOW=4). We pick 8 here for LWC
  // because the Tooling pool cap is 5 (rate-limit.ts:286-292); WINDOW=8 keeps
  // 5 in-flight at the pool layer and Bottleneck queues the remaining 3 — no
  // oversubscription. We don't go higher because per-bundle parsing
  // (HTML/JS bind resolution downstream) is non-trivial, and bounded WINDOW
  // keeps memory and parser load predictable. Yield-as-completed (not in
  // input order) is intentional: it keeps the source's lastYieldedAt
  // heartbeat fresh as bundles complete, even if one bundle stalls near its
  // 60s per-call SOQL ceiling. Downstream processOne does not depend on
  // order. Managed-namespace bundles bypass the window entirely — they yield
  // synchronously without an HTTP call.
  const WINDOW = 8;

  type BundleResult = { member: RawMember } | { skipped: true };

  const processBundle = async (b: BundleRow): Promise<BundleResult> => {
    if (debug) console.log(`ingest: [debug] lwc ← ${b.DeveloperName} (${b.Id})`);
    // Per-bundle try/catch: a single bad bundle's resource fetch must NOT
    // kill iterLwc. Catch + log + emit a stub so the rest of the run lands.
    const files: Record<string, string> = {};
    try {
      const escapedId = b.Id.replace(/'/g, "\\'");
      const resources = (await scheduleQuery(() =>
        soqlWithTimeout(
          conn.tooling.query(
            `SELECT FilePath, Source FROM LightningComponentResource WHERE LightningComponentBundleId = '${escapedId}'`,
          ),
          `tooling LightningComponentResource ${b.DeveloperName}`,
        ),
      )) as { records?: ResourceRow[] } | null;
      let totalSourceBytes = 0;
      for (const r of resources?.records ?? []) {
        const src = r.Source ?? "";
        files[r.FilePath] = src;
        totalSourceBytes += src.length;
      }
      if (debug)
        console.log(
          `ingest: [debug] lwc ✓ ${b.DeveloperName} files=${Object.keys(files).length} bytes=${totalSourceBytes}`,
        );
    } catch (e) {
      // The resource fetch failed for this one bundle (network, malformed
      // payload, etc.). Per W1.5-04: emit a namespaced warning and skip
      // (do not yield). Other bundles in the window continue unaffected.
      const msg = (e as Error).message ?? String(e);
      console.warn(
        `wedge:lwc:bundleFetchFailed:bundleId=${b.Id}:bundleName=${b.DeveloperName}:error=${msg}`,
      );
      return { skipped: true };
    }
    let content: string;
    try {
      content = JSON.stringify({ bundleName: b.DeveloperName, files });
    } catch (e) {
      // JSON.stringify can throw on circular refs or invalid UTF-16 surrogate
      // pairs inside the Source text. Fall back to an empty file map so
      // ingest keeps moving.
      console.warn(
        `ingest: lwc bundle ${b.DeveloperName} JSON.stringify failed: ${(e as Error).message}`,
      );
      content = JSON.stringify({ bundleName: b.DeveloperName, files: {} });
    }
    return {
      member: {
        ref: {
          category: METADATA_CATEGORY.LWC,
          memberType: "LightningComponentBundle",
          memberName: b.DeveloperName,
          lastModifiedAt: b.LastModifiedDate ?? null,
          sourceUri: `sf://tooling/LightningComponentBundle/${b.DeveloperName}`,
          namespace: b.NamespacePrefix ?? null,
        },
        content,
      },
    };
  };

  // In-flight Map<token, Promise<{token, result}>> — wrapper resolves with
  // a stable token so we can delete the settled entry from the map after
  // Promise.race returns. Without the token, we'd need to await each
  // settled promise twice to identify it.
  type Settled = { token: number; result: BundleResult };
  const inFlight = new Map<number, Promise<Settled>>();
  let nextToken = 0;

  const launch = (b: BundleRow): void => {
    const token = nextToken++;
    const p: Promise<Settled> = processBundle(b).then((result) => ({ token, result }));
    inFlight.set(token, p);
  };

  for (const b of allBundles) {
    if (skipSet.has(b.DeveloperName)) {
      if (debug) console.log(`ingest: [debug] lwc skip ${b.DeveloperName} (in SFGRAPH_SKIP_LWC)`);
      continue;
    }
    if (b.NamespacePrefix && !includeManaged) {
      // Managed fast-path — yield synchronously, does NOT consume a window
      // slot (per W1.5-04 spec). No HTTP call, no parsing cost.
      if (debug)
        console.log(
          `ingest: [debug] lwc skip-managed ${b.DeveloperName} (ns=${b.NamespacePrefix}; set SFGRAPH_INCLUDE_MANAGED_LWC=1 to override)`,
        );
      yield {
        ref: {
          category: METADATA_CATEGORY.LWC,
          memberType: "LightningComponentBundle",
          memberName: b.DeveloperName,
          lastModifiedAt: b.LastModifiedDate ?? null,
          sourceUri: `sf://tooling/LightningComponentBundle/${b.DeveloperName}`,
          namespace: b.NamespacePrefix,
        },
        content: JSON.stringify({ bundleName: b.DeveloperName, files: {}, managed: true }),
      };
      continue;
    }

    // Window full → drain one before launching the next. Yield as soon as
    // any in-flight bundle completes (order-independent) so the source's
    // lastYieldedAt stays fresh.
    if (inFlight.size >= WINDOW) {
      const settled = await Promise.race(inFlight.values());
      inFlight.delete(settled.token);
      if ("member" in settled.result) yield settled.result.member;
    }
    launch(b);
  }

  // Drain remaining in-flight bundles. Yield as each completes.
  while (inFlight.size > 0) {
    const settled = await Promise.race(inFlight.values());
    inFlight.delete(settled.token);
    if ("member" in settled.result) yield settled.result.member;
  }
}
