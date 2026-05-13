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
  const bundles = (await scheduleQuery(() =>
    conn.tooling.query(
      "SELECT Id, DeveloperName, NamespacePrefix, LastModifiedDate FROM LightningComponentBundle",
    ),
  )) as { records?: BundleRow[] } | null;
  for (const b of bundles?.records ?? []) {
    const escapedId = b.Id.replace(/'/g, "\\'");
    const resources = (await scheduleQuery(() =>
      conn.tooling.query(
        `SELECT FilePath, Source FROM LightningComponentResource WHERE LightningComponentBundleId = '${escapedId}'`,
      ),
    )) as { records?: ResourceRow[] } | null;
    const files: Record<string, string> = {};
    for (const r of resources?.records ?? []) {
      files[r.FilePath] = r.Source ?? "";
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
      content: JSON.stringify({ bundleName: b.DeveloperName, files }),
    };
  }
}
