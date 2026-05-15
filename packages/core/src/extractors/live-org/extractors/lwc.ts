import { METADATA_CATEGORY } from "../../../domain/index.js";
import type { RawMember } from "../../interfaces/metadata-source.js";
import { scheduleQuery } from "../rate-limit.js";

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
    conn.tooling.query(
      "SELECT Id, DeveloperName, NamespacePrefix, LastModifiedDate FROM LightningComponentBundle",
    ),
  )) as { records?: BundleRow[] } | null;
  const allBundles = bundles?.records ?? [];
  if (debug) {
    console.log(`ingest: [debug] lwc bundles total=${allBundles.length}`);
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
  for (const b of allBundles) {
    if (skipSet.has(b.DeveloperName)) {
      if (debug) console.log(`ingest: [debug] lwc skip ${b.DeveloperName} (in SFGRAPH_SKIP_LWC)`);
      continue;
    }
    if (debug) console.log(`ingest: [debug] lwc ← ${b.DeveloperName} (${b.Id})`);
    // Per-bundle try/catch: a single bad bundle's resource fetch must NOT
    // kill iterLwc. Catch + log + continue so the rest of the run lands.
    let files: Record<string, string> = {};
    try {
      const escapedId = b.Id.replace(/'/g, "\\'");
      const resources = (await scheduleQuery(() =>
        conn.tooling.query(
          `SELECT FilePath, Source FROM LightningComponentResource WHERE LightningComponentBundleId = '${escapedId}'`,
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
      // payload, etc.). Log + emit a stub so the bundle still appears as
      // a node in the graph but with no inner files.
      const msg = (e as Error).message ?? String(e);
      console.warn(`ingest: lwc bundle ${b.DeveloperName} resource fetch failed: ${msg}`);
      files = {};
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
    yield {
      ref: {
        category: METADATA_CATEGORY.LWC,
        memberType: "LightningComponentBundle",
        memberName: b.DeveloperName,
        lastModifiedAt: b.LastModifiedDate ?? null,
        sourceUri: `sf://tooling/LightningComponentBundle/${b.DeveloperName}`,
        namespace: b.NamespacePrefix ?? null,
      },
      content,
    };
  }
}
