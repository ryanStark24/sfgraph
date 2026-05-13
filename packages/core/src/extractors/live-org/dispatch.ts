import type { OrgCapabilities } from "./capabilities.js";
import type { DescribedType } from "./discovery.js";

export type FetchStrategy =
  | "toolingSoql" // fast, code metadata via Tooling API
  | "metadataReadList" // metadata.list + metadata.read
  | "sobjectSoql" // SOQL on SObject (Vlocity, CMDT records)
  | "vlocityRunner" // YAML-driven Vlocity runner (Commit A)
  | "genericOpaque"; // emit opaque-node, no real fetch

/** Types best fetched via Tooling SOQL because they have code bodies. */
const TOOLING_TYPES = new Set([
  "ApexClass",
  "ApexTrigger",
  "ApexPage",
  "ApexComponent",
  "AuraDefinitionBundle",
  "LightningComponentBundle",
  "StaticResource",
]);

/**
 * XmlName prefixes that are Vlocity DataPack types when the org has a
 * vlocity namespace installed. Actual fetching uses the YAML registry; this
 * set just routes dispatch decisions.
 */
const VLOCITY_DATAPACK_TYPES = new Set([
  "DataRaptor",
  "IntegrationProcedure",
  "OmniScript",
  "VlocityCard",
]);

export interface DispatchRoute {
  strategy: FetchStrategy;
  type: string;
}

export function routeFor(type: DescribedType, caps: OrgCapabilities): DispatchRoute {
  if (caps.vlocityLegacy && VLOCITY_DATAPACK_TYPES.has(type.xmlName)) {
    return { strategy: "vlocityRunner", type: type.xmlName };
  }
  if (TOOLING_TYPES.has(type.xmlName)) {
    return { strategy: "toolingSoql", type: type.xmlName };
  }
  return { strategy: "metadataReadList", type: type.xmlName };
}

/**
 * Materialize a dispatch table from described types + capabilities. Vlocity
 * DataPack types are added explicitly when `vlocityLegacy` is true so legacy
 * DataPack-only orgs that don't describe them still get fetched.
 */
export function buildDispatchTable(
  types: DescribedType[],
  caps: OrgCapabilities,
): Map<string, DispatchRoute> {
  const table = new Map<string, DispatchRoute>();
  for (const t of types) {
    table.set(t.xmlName, routeFor(t, caps));
  }
  if (caps.vlocityLegacy) {
    for (const v of VLOCITY_DATAPACK_TYPES) {
      if (!table.has(v)) {
        table.set(v, { strategy: "vlocityRunner", type: v });
      }
    }
  }
  return table;
}

/** Internal: exposed for tests. */
export const _internals = { TOOLING_TYPES, VLOCITY_DATAPACK_TYPES };
