import type { OrgId } from "@ryanstark24/sfgraph-shared";
import type { RawMember } from "../interfaces/metadata-source.js";
import type { OrgCapabilities } from "./capabilities.js";
import { discoverMetadataTypes } from "./discovery.js";
import { buildDispatchTable } from "./dispatch.js";
import { iterApex } from "./extractors/apex.js";
import { iterFlow } from "./extractors/flow.js";
import { iterGenericMetadata } from "./extractors/generic-metadata.js";
import { iterIntegration } from "./extractors/integration.js";
import { iterLwc } from "./extractors/lwc.js";
import { iterObject } from "./extractors/object.js";
import { iterOmnistudio } from "./extractors/omnistudio.js";
import { iterSecurity } from "./extractors/security.js";
import { iterVlocity } from "./extractors/vlocity.js";

/** Naive sequential merge — predictable order, simpler back-pressure semantics. */
export async function* mergeAsyncIterables<T>(...iters: Array<AsyncIterable<T>>): AsyncIterable<T> {
  for (const it of iters) {
    for await (const v of it) yield v;
  }
}

/** Typed-extractor ownership map: which XML type names a dedicated extractor covers. */
const APEX_TYPES = new Set(["ApexClass", "ApexTrigger"]);
const LWC_TYPES = new Set(["LightningComponentBundle"]);
const FLOW_TYPES = new Set(["Flow"]);
const OBJECT_TYPES = new Set(["CustomObject"]);
const SECURITY_TYPES = new Set(["Profile", "PermissionSet", "SharingRules"]);
const INTEGRATION_TYPES = new Set(["NamedCredential", "ExternalServiceRegistration"]);

export async function* bulkRetrieve(
  conn: any,
  caps: OrgCapabilities,
  orgId: OrgId,
): AsyncIterable<RawMember> {
  // Discover the type list this org actually supports. If discovery fails or
  // returns nothing usable, fall back to invoking every known extractor —
  // preserves Commit-A behavior for mocks that don't implement describe.
  let types: Awaited<ReturnType<typeof discoverMetadataTypes>> = [];
  try {
    types = await discoverMetadataTypes(conn);
  } catch {
    types = [];
  }

  const sources: Array<AsyncIterable<RawMember>> = [];
  const invoked = new Set<string>(); // source-key dedup

  const invoke = (key: string, factory: () => AsyncIterable<RawMember>) => {
    if (invoked.has(key)) return;
    invoked.add(key);
    sources.push(factory());
  };

  if (types.length === 0) {
    // Discovery unavailable: invoke every dedicated extractor once.
    invoke("apex", () => iterApex(conn));
    invoke("lwc", () => iterLwc(conn));
    invoke("flow", () => iterFlow(conn));
    invoke("object", () => iterObject(conn));
    invoke("security", () => iterSecurity(conn));
    invoke("integration", () => iterIntegration(conn));
  } else {
    const dispatch = buildDispatchTable(types, caps);
    for (const [type, route] of dispatch.entries()) {
      switch (route.strategy) {
        case "toolingSoql":
          if (APEX_TYPES.has(type)) invoke("apex", () => iterApex(conn));
          else if (LWC_TYPES.has(type)) invoke("lwc", () => iterLwc(conn));
          else invoke(`generic:${type}`, () => iterGenericMetadata(conn, String(orgId), type));
          break;
        case "metadataReadList":
          if (FLOW_TYPES.has(type)) invoke("flow", () => iterFlow(conn));
          else if (OBJECT_TYPES.has(type)) invoke("object", () => iterObject(conn));
          else if (SECURITY_TYPES.has(type)) invoke("security", () => iterSecurity(conn));
          else if (INTEGRATION_TYPES.has(type)) invoke("integration", () => iterIntegration(conn));
          else invoke(`generic:${type}`, () => iterGenericMetadata(conn, String(orgId), type));
          break;
        case "vlocityRunner":
          // Single invocation handled below.
          break;
        case "sobjectSoql":
          // Reserved for future CMDT/etc. — none routed here in Commit B.
          break;
        case "genericOpaque":
          // No-op for now: we don't pollute the graph with sentinel-only nodes.
          break;
      }
    }
  }

  if (caps.vlocityLegacy) {
    invoke("vlocity", () => iterVlocity(conn, caps, String(orgId)));
  }
  if (caps.omnistudioOncore) {
    invoke("omnistudio", () => iterOmnistudio(conn));
  }

  yield* mergeAsyncIterables(...sources);
}
