import { METADATA_DESCRIBE_TIMEOUT_MS, scheduleMetadata, withTimeout } from "./rate-limit.js";

export interface DescribedType {
  xmlName: string; // 'ApexClass', 'Profile', 'OmniProcess', ...
  suffix?: string; // 'cls', 'profile', 'omniProcess'
  directoryName?: string; // 'classes', 'profiles'
  childXmlNames: string[]; // e.g. Profile's ['ProfileFieldLevelSecurity', ...]
  inFolder: boolean;
  metaFile: boolean;
}

/**
 * Call `conn.metadata.describe(apiVersion)` and normalize the result into a
 * stable `DescribedType[]`. Entries with empty xmlName are filtered out.
 */
export async function discoverMetadataTypes(
  conn: any,
  apiVersion?: string,
): Promise<DescribedType[]> {
  const result = (await scheduleMetadata(() =>
    withTimeout<{ metadataObjects?: unknown[] }>(
      conn.metadata.describe(apiVersion),
      METADATA_DESCRIBE_TIMEOUT_MS,
      "metadata.describe",
    ),
  )) as { metadataObjects?: unknown[] } | null | undefined;
  const arr: any[] = Array.isArray(result?.metadataObjects) ? result.metadataObjects : [];
  return arr
    .map((o) => ({
      xmlName: String(o?.xmlName ?? ""),
      suffix: o?.suffix,
      directoryName: o?.directoryName,
      childXmlNames: Array.isArray(o?.childXmlNames) ? o.childXmlNames.map(String) : [],
      inFolder: Boolean(o?.inFolder),
      metaFile: Boolean(o?.metaFile),
    }))
    .filter((t) => t.xmlName.length > 0);
}
