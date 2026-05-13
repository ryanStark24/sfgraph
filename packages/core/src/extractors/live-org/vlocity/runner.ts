import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { METADATA_CATEGORY } from "../../../domain/index.js";
import type { RawMember } from "../../interfaces/metadata-source.js";
import type { OrgCapabilities } from "../capabilities.js";
import { scheduleQuery } from "../rate-limit.js";

export interface VlocityTypeDef {
  vlocityDataPackType: string;
  /** Raw SOQL with `%vlocity_namespace%` placeholder. */
  query: string;
}

interface RawYamlEntry {
  VlocityDataPackType?: string;
  query?: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = join(HERE, "query-definitions.yml");

let CACHED_REGISTRY: Record<string, VlocityTypeDef> | null = null;

/** Load and cache the vendored Vlocity DataPack query registry. */
export function loadVlocityRegistry(): Record<string, VlocityTypeDef> {
  if (CACHED_REGISTRY) return CACHED_REGISTRY;
  const text = readFileSync(REGISTRY_PATH, "utf8");
  const parsed = parseYaml(text) as Record<string, RawYamlEntry> | null;
  const out: Record<string, VlocityTypeDef> = {};
  if (parsed && typeof parsed === "object") {
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue;
      const vdpType = value.VlocityDataPackType;
      const query = value.query;
      if (typeof vdpType !== "string" || typeof query !== "string") continue;
      out[key] = { vlocityDataPackType: vdpType, query };
    }
  }
  CACHED_REGISTRY = out;
  return out;
}

interface VRow {
  Id?: string;
  Name?: string;
  LastModifiedDate?: string;
  [k: string]: unknown;
}

/**
 * Yield a RawMember per record across every detected Vlocity namespace and every
 * registry entry. Namespace substitution is `%vlocity_namespace%` → `<ns>`.
 */
export async function* iterVlocityRecords(
  conn: any,
  caps: OrgCapabilities,
  orgId: string,
): AsyncIterable<RawMember> {
  const namespaces = caps.vlocityNamespaces ?? [];
  if (namespaces.length === 0) return;
  const registry = loadVlocityRegistry();
  const entries = Object.values(registry);

  for (const namespace of namespaces) {
    for (const typeDef of entries) {
      const soql = typeDef.query.split("%vlocity_namespace%").join(namespace);
      let res: { records?: VRow[] } | null = null;
      try {
        res = (await scheduleQuery(() => conn.query(soql))) as { records?: VRow[] } | null;
      } catch {
        continue;
      }
      for (const r of res?.records ?? []) {
        const name = String(r.Name ?? r.Id ?? "");
        yield {
          ref: {
            category: METADATA_CATEGORY.VLOCITY,
            memberType: typeDef.vlocityDataPackType,
            memberName: name,
            lastModifiedAt: r.LastModifiedDate ?? "",
            sourceUri: `sf://${orgId}/${typeDef.vlocityDataPackType}/${name}`,
            namespace,
          },
          content: JSON.stringify(r),
        };
      }
    }
  }
}
