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

/**
 * Whitelist of standard (non-custom) Salesforce SObjects that user code
 * commonly references. Curated for Sales / Service / Marketing / Platform /
 * Communities. Anything not in this list AND not a custom-suffix SObject
 * is skipped by default to avoid the long tail of industry-cloud /
 * platform-internal tables that bloat the graph, take seconds-each to
 * describe, and have no user-code reference path.
 *
 * Override: SFGRAPH_INCLUDE_ALL_SOBJECTS=1 brings back every queryable
 * SObject (still filtered by companion-table + SYSTEM_SKIP_NAMES).
 */
const STANDARD_SOBJECT_WHITELIST = new Set([
  // Sales core
  "Account",
  "AccountContactRelation",
  "AccountContactRole",
  "AccountTeamMember",
  "AccountPartner",
  "Contact",
  "ContactPointAddress",
  "ContactPointEmail",
  "ContactPointPhone",
  "Opportunity",
  "OpportunityContactRole",
  "OpportunityLineItem",
  "OpportunityHistory",
  "OpportunityFieldHistory",
  "OpportunityTeamMember",
  "OpportunityStage",
  "Lead",
  "LeadStatus",
  "Quote",
  "QuoteLineItem",
  "Order",
  "OrderItem",
  "Contract",
  "ContractContactRole",
  "Asset",
  "AssetRelationship",
  "Product2",
  "PricebookEntry",
  "Pricebook2",
  "Campaign",
  "CampaignMember",
  "CampaignMemberStatus",
  "Partner",
  // Service
  "Case",
  "CaseComment",
  "CaseTeamMember",
  "CaseTeamRole",
  "CaseTeamTemplate",
  "CaseSolution",
  "CaseContactRole",
  "CaseMilestone",
  "Solution",
  "ServiceContract",
  "ServiceAppointment",
  "ServiceTerritory",
  "ServiceTerritoryMember",
  "ServiceResource",
  "ServiceResourceCapacity",
  "ServiceResourceSkill",
  "WorkOrder",
  "WorkOrderLineItem",
  "WorkType",
  "WorkTypeGroup",
  "Entitlement",
  "EntitlementContact",
  "EntitlementTemplate",
  "MilestoneType",
  "SlaProcess",
  // Activities
  "Task",
  "Event",
  "EventRelation",
  "OpenActivity",
  "ActivityHistory",
  "Reminder",
  // Content / Files
  "ContentDocument",
  "ContentVersion",
  "ContentDocumentLink",
  "ContentNote",
  "ContentWorkspace",
  "Attachment",
  "Note",
  "Document",
  "Folder",
  "Library",
  // Marketing / Email
  "EmailMessage",
  "EmailTemplate",
  "EmailRelay",
  "ListEmail",
  // Setup / Identity / Access
  "User",
  "UserRole",
  "UserLicense",
  "Group",
  "GroupMember",
  "Queue",
  "QueueSObject",
  "Profile",
  "PermissionSet",
  "PermissionSetAssignment",
  "PermissionSetGroup",
  "PermissionSetGroupComponent",
  "PermissionSetLicense",
  "PermissionSetLicenseAssign",
  "RecordType",
  "BusinessProcess",
  "BusinessHours",
  "Holiday",
  "FiscalYearSettings",
  "Period",
  "Territory2",
  "Territory2Model",
  "Territory2Type",
  "UserTerritory2Association",
  // Experience Cloud / Communities / Topics
  "Network",
  "NetworkMember",
  "Site",
  "Domain",
  "DomainSite",
  "Topic",
  "TopicAssignment",
  "FeedItem",
  "FeedComment",
  "FeedAttachment",
  // Knowledge
  "Knowledge__kav",
  "KnowledgeArticle",
  "KnowledgeArticleVersion",
  "DataCategory",
  // Reports / Dashboards
  "Report",
  "Dashboard",
  "ReportType",
  // CMS / DigEx
  "ManagedContent",
  "ManagedContentVersion",
  "ManagedContentType",
  // Platform staples that DO show up in user code
  "Idea",
  "Question",
  "FAQ",
  "AggregateResult",
  "AuthProvider",
  "ConnectedApplication",
  "NamedCredential",
  "ExternalCredential",
  // Salesforce DX-style metadata SObjects user code sometimes joins
  "ApexClass",
  "ApexTrigger",
  "ApexPage",
  "ApexComponent",
  "AuraDefinitionBundle",
  "AuraDefinition",
  "LightningComponentBundle",
  "LightningComponentResource",
  "FlowDefinition",
  "Flow",
  "CustomObject",
  "CustomField",
  "StaticResource",
  "EmailService",
  "EmailServicesAddress",
  // OmniStudio-on-core (industry cloud but commonly used)
  "OmniProcess",
  "OmniProcessElement",
  "OmniUiCard",
  "OmniDataTransform",
]);

interface EntityDefRow {
  QualifiedApiName?: string;
  IsCustomizable?: boolean;
  IsApexTriggerable?: boolean;
  IsDeprecatedAndHidden?: boolean;
  IsCustomSetting?: boolean;
}

/**
 * Fetch the `EntityDefinition` Tooling table to learn Salesforce's own
 * classification of each SObject. The two flags that matter:
 *
 *   IsCustomizable   — user can add custom fields / validation rules.
 *                      Strong signal that user code references it.
 *   IsApexTriggerable — user can write a trigger on it. Strong signal
 *                      that user code touches it from Apex.
 *
 * Either being true → keep. Both false → it's a platform-internal table
 * (audit log, auth config, schema introspection table, etc.) that user
 * code never references and never benefits from being in the graph.
 *
 * EntityDefinition pagination: a single Tooling query returns up to 2000
 * rows. Larger orgs need queryMore. We call conn.tooling.query repeatedly
 * via the nextRecordsUrl pattern.
 *
 * Returns null if EntityDefinition is unavailable (some scratch orgs and
 * specific Salesforce editions return empty here, which is the reason we
 * originally moved off this code path). Caller falls back to the static
 * whitelist when null.
 */
async function fetchEntityDefinitionClassification(
  conn: any,
): Promise<Set<string> | null> {
  const userRelevant = new Set<string>();
  const SOQL =
    "SELECT QualifiedApiName, IsCustomizable, IsApexTriggerable, IsDeprecatedAndHidden, IsCustomSetting FROM EntityDefinition";
  try {
    let res = (await scheduleQuery(() => conn.tooling.query(SOQL))) as {
      records?: EntityDefRow[];
      done?: boolean;
      nextRecordsUrl?: string;
    } | null;
    if (!res || !Array.isArray(res.records) || res.records.length === 0) {
      return null;
    }
    const collect = (recs: EntityDefRow[]): void => {
      for (const r of recs) {
        if (!r.QualifiedApiName) continue;
        if (r.IsDeprecatedAndHidden) continue;
        // Either flag → keep. Custom settings are usually user-facing
        // (people query them) even though IsApexTriggerable is false.
        if (r.IsCustomizable || r.IsApexTriggerable || r.IsCustomSetting) {
          userRelevant.add(r.QualifiedApiName);
        }
      }
    };
    collect(res.records);
    // Walk pagination — Tooling API returns nextRecordsUrl for large sets.
    while (res && res.done === false && res.nextRecordsUrl) {
      const url = res.nextRecordsUrl;
      try {
        res = (await scheduleQuery(() => conn.tooling.queryMore(url))) as {
          records?: EntityDefRow[];
          done?: boolean;
          nextRecordsUrl?: string;
        };
      } catch {
        break;
      }
      if (res?.records) collect(res.records);
    }
    return userRelevant.size > 0 ? userRelevant : null;
  } catch {
    return null;
  }
}

/** Build a shouldIncludeSObject predicate closed over the EntityDefinition
 *  probe result. Previously this state lived at module scope as a `let` —
 *  worked for single-org ingest but broke subtly under multi-org parallel
 *  ingest (org A's classification leaks into org B's filter). Closure-bound
 *  state has no such hazard. */
function makeShouldIncludeSObject(
  entityDefRelevant: Set<string> | null,
): (s: SObjectGlobal) => boolean {
  return function shouldIncludeSObject(s: SObjectGlobal): boolean {
  if (!s.name) return false;
  if (s.deprecatedAndHidden) return false;
  if (!s.queryable) return false;
  // Filter out auto-generated companion tables — works for BOTH the custom
  // form (`MyObj__c` → `MyObj__Feed`) AND the standard form (`Account` →
  // `AccountFeed`).
  if (isCompanionTable(s.name)) return false;
  for (const re of LEGACY_SKIP_PATTERNS) {
    if (re.test(s.name)) return false;
  }
  // Hardcoded skip list for known-useless / known-pathological system
  // tables (kept as a hard ceiling — even if EntityDefinition says
  // ApexLog is customizable, we still don't want it in the graph).
  const includeSystem = process.env.SFGRAPH_INCLUDE_SYSTEM_SOBJECTS === "1";
  if (!includeSystem && SYSTEM_SKIP_NAMES.has(s.name)) return false;
  // Custom SObjects (user or managed-package). describeGlobal lists every
  // SObject the managed-package metadata declared, including objects that
  // SOQL doesn't actually expose (`omnistudio__TestResult__c` etc.) and
  // whose describe() can wedge for minutes server-side. EntityDefinition
  // is the authoritative "actually exists + reachable" list — gate
  // namespaced custom SObjects through it. User-namespace custom SObjects
  // (no `__` namespace prefix) are always included.
  if (isCustomSObject(s.name)) {
    const isNamespaced = s.name.includes("__") && s.name.split("__").length >= 3;
    if (isNamespaced && entityDefRelevant && !entityDefRelevant.has(s.name)) {
      return false;
    }
    return true;
  }
  // Full-surface override.
  if (process.env.SFGRAPH_INCLUDE_ALL_SOBJECTS === "1") return true;
  // Primary path: ask Salesforce. EntityDefinition's IsCustomizable +
  // IsApexTriggerable flags tell us which standard SObjects are
  // user-relevant vs platform-internal. Industry-cloud SObjects
  // (AuthorizationFormConsent, AuthorizedInsuranceLine, etc.) come back
  // as customizable=true and get included; platform internals
  // (AuthConfig, ApexLog, EntityParticle, etc.) come back as false and
  // get skipped — exactly the right behavior, no hardcoded list needed.
  if (entityDefRelevant) {
    return entityDefRelevant.has(s.name);
  }
  // Fallback path: EntityDefinition unavailable / empty (some scratch
  // orgs return 0 rows here). Use the curated whitelist.
  return STANDARD_SOBJECT_WHITELIST.has(s.name);
  };
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
  const debug = process.env.SFGRAPH_DEBUG_INGEST === "1";
  // Probe EntityDefinition first so shouldIncludeSObject can rely on
  // Salesforce's own classification rather than a hardcoded list. If
  // this fails / returns 0 rows (some scratch orgs), the fallback is the
  // curated STANDARD_SOBJECT_WHITELIST. Hard 60s ceiling — on managed-
  // package-heavy orgs EntityDefinition pagination has been observed to
  // span minutes; that previously blocked iterObject's first yield long
  // enough to hold a sliding-window slot uselessly. Falling through to
  // the static whitelist costs us some long-tail standard SObjects but
  // unblocks the source promptly.
  let entityDefRelevant: Set<string> | null;
  try {
    entityDefRelevant = await withTimeout(
      fetchEntityDefinitionClassification(conn),
      60_000,
      "EntityDefinition probe",
    );
  } catch {
    entityDefRelevant = null;
  }
  const shouldIncludeSObject = makeShouldIncludeSObject(entityDefRelevant);
  if (debug) {
    if (entityDefRelevant) {
      console.log(
        `ingest: [debug] object EntityDefinition probe → ${entityDefRelevant.size} user-relevant SObjects classified`,
      );
    } else {
      console.log(
        "ingest: [debug] object EntityDefinition unavailable — falling back to static whitelist",
      );
    }
  }

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

  // Pre-filter the queue once (the previous chunked loop did this per slice).
  // Skipped SObjects are removed up-front so they don't consume queue slots.
  const queue = included.filter((s) => {
    if (skipSet.has(s.name)) {
      if (debug) console.log(`ingest: [debug] object skip ${s.name} (in SFGRAPH_SKIP_SOBJECT)`);
      return false;
    }
    return true;
  });

  // Sliding-window describe scheduler. Keeps exactly WINDOW describes in
  // flight at all times; when any one completes we yield it and immediately
  // launch the next queued SObject. Replaces a chunked Promise.all that
  // synchronised on the slowest member of each chunk — on managed-package-
  // heavy orgs (FinServ/Loyalty/Vlocity Insurance) where a handful of
  // SObjects describe in 8–15s while most return in 200–500ms, the chunk
  // barrier was leaving 9 slots idle waiting for the slow one. Sliding
  // window keeps the data pool saturated end-to-end.
  //
  // 12-second per-describe ceiling — empirically, anything past ~5s on
  // a healthy connection either is genuinely huge (and we want to give up
  // and parse what we have) or is a stuck jsforce response handler. The
  // parser handles `desc: null` fail-soft, so dropping a few stragglers
  // costs us less than the multi-minute tail of the old 45s ceiling.
  const WINDOW = 10;
  const DESCRIBE_TIMEOUT_MS = 12_000;
  const startedAt = Date.now();
  let completed = 0;
  let timedOut = 0;
  let nextIdx = 0;
  let lastProgressAt = Date.now();
  type Settled = { idx: number; s: SObjectGlobal; desc: any; elapsedMs: number };
  const inFlight = new Map<number, Promise<Settled>>();

  const launch = (idx: number): void => {
    const s = queue[idx];
    if (!s) return;
    const launchedAt = Date.now();
    if (debug) console.log(`ingest: [debug] object describe ← ${s.name}`);
    const p = (async (): Promise<Settled> => {
      try {
        const d = await scheduleData(() =>
          withTimeout(conn.sobject(s.name).describe(), DESCRIBE_TIMEOUT_MS, s.name),
        );
        return { idx, s, desc: d, elapsedMs: Date.now() - launchedAt };
      } catch (e) {
        const msg = (e as Error)?.message ?? "(unknown)";
        if (/describe timeout/.test(msg)) timedOut += 1;
        if (debug) console.log(`ingest: [debug] object describe ✗ ${s.name}: ${msg}`);
        return { idx, s, desc: null, elapsedMs: Date.now() - launchedAt };
      }
    })();
    inFlight.set(idx, p);
  };

  // Prime the window.
  while (inFlight.size < WINDOW && nextIdx < queue.length) {
    launch(nextIdx++);
  }

  while (inFlight.size > 0) {
    const settled = await Promise.race(inFlight.values());
    inFlight.delete(settled.idx);
    if (nextIdx < queue.length) launch(nextIdx++);
    completed += 1;
    // Progress one-liner every 25 completions OR every 5s, whichever
    // comes first. Visible without --debug so a slow phase is diagnosable
    // from normal output.
    const now = Date.now();
    if (completed % 25 === 0 || now - lastProgressAt > 5_000) {
      const elapsedSec = Math.round((now - startedAt) / 1000);
      console.log(
        `ingest:   object ${completed}/${queue.length} (${elapsedSec}s elapsed, ${timedOut} timed out, ${inFlight.size} in flight)`,
      );
      lastProgressAt = now;
    }
    if (debug && settled.desc) {
      console.log(
        `ingest: [debug] object describe ✓ ${settled.s.name} fields=${(settled.desc as { fields?: unknown[] })?.fields?.length ?? 0} (${settled.elapsedMs}ms)`,
      );
    }
    const { s, desc } = settled;
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
