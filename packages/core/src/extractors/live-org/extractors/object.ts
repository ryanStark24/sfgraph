import { XMLBuilder } from "fast-xml-parser";
import { METADATA_CATEGORY } from "../../../domain/index.js";
import type { RawMember } from "../../interfaces/metadata-source.js";
import { scheduleData, scheduleQuery } from "../rate-limit.js";

const xml = new XMLBuilder({ ignoreAttributes: false, format: false, suppressEmptyNode: true });

interface SObjectGlobal {
  name: string;
  label?: string;
  custom?: boolean;
  customSetting?: boolean;
  createable?: boolean;
  queryable?: boolean;
  deprecatedAndHidden?: boolean;
  keyPrefix?: string | null;
}

interface FieldDescribe {
  name: string;
  label?: string;
  type?: string;
  length?: number;
  precision?: number;
  scale?: number;
  unique?: boolean;
  externalId?: boolean;
  nillable?: boolean;
  custom?: boolean;
  referenceTo?: string[];
  relationshipName?: string | null;
  picklistValues?: Array<{ value: string; label?: string; active?: boolean }>;
  calculatedFormula?: string | null;
  inlineHelpText?: string | null;
}

/** Suffixes that Salesforce uses for auto-generated companion tables.
 *  These tables proxy the parent SObject's full field map (so a describe()
 *  on `AccountFeed` returns ~100+ fields — every Account field plus
 *  feed-specific ones), but they're never referenced in user code as graph
 *  dependency targets. Skipping them collapses the SObject set by ~70% on
 *  typical orgs (every Account/Contact/etc. has 3–5 companion tables) and
 *  eliminates a major class of ingest-time slowness + crash risk. */
const COMPANION_SUFFIXES = [
  "Feed", // Chatter feed
  "History", // field history tracking
  "Share", // sharing records
  "ChangeEvent", // Change Data Capture event
  "StatusChangeEvent", // case/quote status CDC variant
  "Tag", // entity tag join table
  "OwnerSharingRule", // sharing rule definition (owner-based)
  "CriteriaSharingRule", // sharing rule definition (criteria-based)
  "TerritorySharingRule", // sharing rule definition (territory-based)
];

/** Custom-object suffixes — we use these to detect "real" user-or-package
 *  SObjects so we don't accidentally false-positive on user objects whose
 *  name happens to end in 'Feed' (e.g. `MyFeed__c` is real, not a companion). */
const CUSTOM_SUFFIXES = ["__c", "__e", "__b", "__mdt", "__x", "__ka", "__kav", "__chn"];

function isCustomSObject(name: string): boolean {
  return CUSTOM_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function isCompanionTable(name: string): boolean {
  if (isCustomSObject(name)) return false;
  return COMPANION_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** Legacy big-object skip — matches both `*__b` (handled separately) and
 *  Salesforce's audit-trail variants that aren't covered by COMPANION_SUFFIXES. */
const LEGACY_SKIP_PATTERNS = [/__b$/];

/**
 * High-volume platform / telemetry / audit SObjects that never appear in
 * user code as references and frequently crash `describe()` mid-run on
 * macOS 26+ because of their enormous field maps (100+ fields, multi-MB
 * response payloads). Skipped by default; opt back in via
 * SFGRAPH_INCLUDE_SYSTEM_SOBJECTS=1.
 */
const SYSTEM_SKIP_NAMES = new Set([
  // Apex telemetry / debug
  "ApexLog",
  "ApexTestResult",
  "ApexTestQueueItem",
  "ApexTestResultLimits",
  "ApexTestRunResult",
  "ApexClassMember",
  "ApexComponentMember",
  "ApexExecutionOverlayAction",
  "ApexExecutionOverlayResult",
  "ApexPageMember",
  "ApexTriggerMember",
  "AsyncApexJob",
  "BackgroundOperation",
  // Event monitoring / Lightning usage
  "EventLogFile",
  "LoginEvent",
  "LightningUsageByPageMetrics",
  "LightningUsageByBrowserMetrics",
  "LightningUsageByFlexiPageMetrics",
  "LightningUsageByAppTypeMetrics",
  "LightningExitByPageMetrics",
  "LightningToggleMetrics",
  // Sessions / login
  "LoginHistory",
  "LoginGeo",
  "LoginIp",
  "AuthSession",
  "UserLogin",
  // Setup audit
  "SetupAuditTrail",
  "SecurityCustomBaseline",
  // Job / async / queue plumbing
  "CronTrigger",
  "CronJobDetail",
  "BatchApexErrorEvent",
  // Auth / SSO config (internal platform tables, not referenced in user
  // code by SObject name)
  "AuditTrailFileExport",
  "AuthConfig",
  "AuthConfigProviders",
  "AuthFormRequestRecord",
  "AuthProvParamFwdAllowlist",
  "AuthProviderScope",
  "TwoFactorMethodsInfo",
  "TwoFactorTempCode",
  "SamlSsoConfig",
  "ConnectedAppPlugin",
  "OauthCustomScope",
  "OauthToken",
  // Async / events plumbing
  "AsyncOperationLog",
  "AsyncOperationStatus",
  "AsyncOperationEvent",
  "AsyncOperationResult",
  // Aura framework internals (the Aura *bundle* metadata is captured via
  // the generic-metadata path; these SObjects are platform internals)
  "AuraDefinitionInfo",
  "AuraDefinitionBundleInfo",
  // High-volume system tables that are queryable but have hundreds of
  // fields; never useful as graph dependency targets.
  "PlatformAction",
  "ListView",
  "PicklistValueInfo",
  "RecentlyViewed",
  "UserRecordAccess",
  "TenantUsageEntitlement",
  "EntityParticle",
  "FieldDefinition",
  "RelationshipDomain",
  "RelationshipInfo",
  "Organization",
  "ColorDefinition",
  "IconDefinition",
]);

function shouldIncludeSObject(s: SObjectGlobal): boolean {
  if (!s.name) return false;
  if (s.deprecatedAndHidden) return false;
  if (!s.queryable) return false;
  // Filter out auto-generated companion tables — works for BOTH the custom
  // form (`MyObj__c` → `MyObj__Feed`) AND the standard form (`Account` →
  // `AccountFeed`). The previous skip-patterns only caught the custom form
  // and let through ~70% of unnecessary describes.
  if (isCompanionTable(s.name)) return false;
  for (const re of LEGACY_SKIP_PATTERNS) {
    if (re.test(s.name)) return false;
  }
  // Default-skip Salesforce system / telemetry / audit tables. Opt back in
  // for users who actually want every queryable surface in their graph.
  //
  // Note: we intentionally do NOT blanket-skip managed-package SObjects
  // (e.g. vlocity_cmt__*). Unlike Apex Body / LWC Source — both of which
  // Salesforce redacts to `(hidden)` / `<hidden>` for managed packages —
  // SObject describe() returns the FULL field map for managed objects,
  // including their lookups, formulas, and references. That's real graph
  // value: user code that touches a Vlocity custom object needs the
  // managed schema to resolve edges. So managed-package SObjects are
  // included by default.
  const includeSystem = process.env.SFGRAPH_INCLUDE_SYSTEM_SOBJECTS === "1";
  if (!includeSystem && SYSTEM_SKIP_NAMES.has(s.name)) return false;
  return true;
}

/** Wrap a promise with a hard timeout. Used to bound describe() calls so a
 *  single hung / pathological SObject can't stall the whole ingest. The
 *  underlying request keeps running until libuv decides to clean up — but
 *  we move on. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`describe timeout (${ms}ms): ${label}`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Iterate every SObject visible to the current user. Uses `describeGlobal()`
 * to enumerate + `sobject(name).describe()` per object to fetch the field
 * map. Works universally for any user with record-read access — no Metadata
 * API permissions, no EntityDefinition Tooling quirks.
 *
 * Each yielded RawMember has content = JSON-stringified envelope matching
 * what the CustomObject parser expects (object-level props + fields list).
 * The parser can derive CustomObject + CustomField nodes from this.
 */
export async function* iterObject(conn: any): AsyncIterable<RawMember> {
  let global: { sobjects?: SObjectGlobal[] } | null = null;
  try {
    global = (await scheduleQuery(() => conn.describeGlobal())) as {
      sobjects?: SObjectGlobal[];
    };
  } catch {
    return; // describeGlobal failed; let fail-soft catch it
  }
  const all = global?.sobjects ?? [];
  const included = all.filter(shouldIncludeSObject);

  const debug = process.env.SFGRAPH_DEBUG_INGEST === "1";
  // SFGRAPH_SKIP_SOBJECT=name1,name2,... lets users work around a specific
  // SObject whose describe crashes jsforce (same failure mode as managed-
  // package LWC bundles — silent SIGKILL on macOS 26+, no error in any
  // log). Skipped objects don't appear in the graph at all.
  const skipSet = new Set(
    (process.env.SFGRAPH_SKIP_SOBJECT ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

  if (debug) {
    console.log(
      `ingest: [debug] object total=${included.length} (filtered from ${all.length}) skip=${skipSet.size}`,
    );
  }

  // Fan out describe() in parallel chunks. Bottleneck's data pool throttles
  // actual concurrency to maxConcurrent (default 10). Was strictly serial:
  // 200 SObjects * ~500ms each = ~100s. With 10-way parallel: ~10s.
  // Chunk size matches the pool's maxConcurrent — going higher just queues
  // jobs in Bottleneck without adding parallelism, AND it buffers more
  // describe responses simultaneously in memory (some SObject describes are
  // 1MB+ JSON; 25 in flight = 25MB+ of buffered response per chunk).
  // Default 10 keeps memory pressure flat at any one moment.
  const CHUNK = 10;
  for (let i = 0; i < included.length; i += CHUNK) {
    const slice = included.slice(i, i + CHUNK).filter((s) => {
      if (skipSet.has(s.name)) {
        if (debug) console.log(`ingest: [debug] object skip ${s.name} (in SFGRAPH_SKIP_SOBJECT)`);
        return false;
      }
      return true;
    });
    if (debug) {
      console.log(
        `ingest: [debug] object chunk ← ${slice.map((s) => s.name).join(",")}`,
      );
    }
    // 45-second hard timeout per describe — far above the typical 200-
    // 500ms cost, so a normal call is never affected. But a pathological
    // SObject whose describe never returns (or that triggers a hung
    // jsforce response handler) doesn't get to wedge the whole pool.
    const DESCRIBE_TIMEOUT_MS = 45_000;
    const descs: Array<{ s: SObjectGlobal; desc: any }> = await Promise.all(
      slice.map(async (s) => {
        try {
          if (debug) console.log(`ingest: [debug] object describe ← ${s.name}`);
          const d = await scheduleData(() =>
            withTimeout(conn.sobject(s.name).describe(), DESCRIBE_TIMEOUT_MS, s.name),
          );
          if (debug)
            console.log(
              `ingest: [debug] object describe ✓ ${s.name} fields=${(d as { fields?: unknown[] })?.fields?.length ?? 0}`,
            );
          return { s, desc: d };
        } catch (e) {
          if (debug)
            console.log(
              `ingest: [debug] object describe ✗ ${s.name}: ${(e as Error)?.message ?? "(unknown)"}`,
            );
          return { s, desc: null };
        }
      }),
    );
    for (const { s, desc } of descs) {
      if (!desc) continue;
      const fields: FieldDescribe[] = Array.isArray(desc?.fields) ? desc.fields : [];

    // Build the CustomObject-shaped envelope expected by the Phase-2 Object
    // parser (which already knows how to walk this structure).
    const objectXml = xml.build({
      CustomObject: {
        fullName: s.name,
        label: desc?.label ?? s.label ?? s.name,
        pluralLabel: desc?.labelPlural ?? null,
        sharingModel: desc?.sharingModel ?? null,
        customSettingsType: s.customSetting ? "List" : null,
        enableHistory: Boolean(desc?.replicateable),
        description: desc?.description ?? null,
        fields: fields.map((f) => ({
          fullName: f.name,
          label: f.label ?? f.name,
          type: f.type ?? "Text",
          length: f.length,
          precision: f.precision,
          scale: f.scale,
          unique: f.unique,
          externalId: f.externalId,
          required: f.nillable === false,
          custom: f.custom,
          referenceTo: f.referenceTo ?? [],
          relationshipName: f.relationshipName ?? null,
          formula: f.calculatedFormula ?? null,
          description: f.inlineHelpText ?? null,
          picklistValues: f.picklistValues ?? [],
        })),
      },
    });

    yield {
      ref: {
        category: METADATA_CATEGORY.OBJECT,
        memberType: "CustomObject",
        memberName: s.name,
        lastModifiedAt: null,
        sourceUri: `sf://describe/${s.name}`,
        namespace: null,
      },
      content: typeof objectXml === "string" ? objectXml : String(objectXml),
    };
    }
  }
}
