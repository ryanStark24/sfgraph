import { asOrgId, asQualifiedName } from "@ryanstark24/sfgraph-shared";
import type { OrgId, QualifiedName } from "@ryanstark24/sfgraph-shared";
import { type EdgeFact, REL_TYPES, type RelType } from "../domain/index.js";
import type { DanglingEdgeRow, GraphStore } from "../storage/interfaces.js";
import { AUDIT_PLATFORM_CORE } from "./apex-platform.js";

/**
 * Edges whose `dst` qualified name has no matching node row. Surfaced
 * post-ingest so the user can see what the parsers reference but the
 * extractors never materialized (managed-package methods, third-party
 * imports, dotted refs to fields whose CustomObject was filtered out).
 *
 * Counts are emitted in two histograms:
 *   - byRel: which relationship types are most affected (e.g. CALLS,
 *     GRANTS_APEX_ACCESS) — points at parsers that emit speculative targets.
 *   - byDstPrefix: which qname prefixes are most common (e.g. `ApexMethod:`,
 *     `Remote:`, `CustomField:`) — points at unparsed metadata categories.
 *
 * A bounded `sample` of the actual dangling edges is included so users can
 * eyeball whether they're "expected" (managed packages, ghost references)
 * or "fixable" (an extractor that should have emitted a target node).
 */
export interface DanglingEdgeSample {
  src: string;
  rel: string;
  dst: string;
}

export interface AuditResult {
  totalEdges: number;
  danglingCount: number;
  /** Dangling edges whose dst can never have a source in the org's own
   *  metadata (`isPlatformBuiltinRef`): standard tabs, standard objects and
   *  fields, managed-package metadata and Apex platform classes.
   *  These are *expected* — the reference data is real and useful (e.g.
   *  profile tab visibility), the target just isn't org metadata. Included
   *  in `danglingCount`; broken out so the headline number isn't dominated
   *  by ~60k standard-tab grants on a vanilla org. */
  platformRefCount: number;
  /** danglingCount - platformRefCount: the subset worth investigating. */
  unexpectedCount: number;
  byRel: Record<string, number>;
  byDstPrefix: Record<string, number>;
  sample: DanglingEdgeSample[];
}

export interface AuditOpts {
  /** How many dangling edges to keep in `sample`. Default 25. */
  sampleSize?: number;
  /** Hard upper bound on rows scanned per edge table. Default unlimited. */
  scanLimit?: number;
}

function prefix(qname: string): string {
  const idx = qname.indexOf(":");
  return idx > 0 ? qname.slice(0, idx) : "(unlabeled)";
}

const CUSTOM_SUFFIX_RE = /__(?:c|e|b|mdt|x|kav)$/i;

/** The DataPack namespace placeholder, in `__` and dotted form alike. */
const NS_PLACEHOLDER = "%vlocity_namespace%";

const NS_IDENT_RE = /^(?:%vlocity_namespace%|[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*)$/i;
const NAME_SEG_RE = /^[A-Za-z0-9]/;

/** Suffixes of a named member (`ns__Name__c`, `ns__Parent__r`, `ns__Ext__x`). */
const MEMBER_SUFFIXES: ReadonlySet<string> = new Set(["c", "r", "x", "mdt", "e", "b", "kav"]);

/** Tails that make a single-segment `X__tail` an unmanaged name: the member
 *  suffixes plus relationship, geolocation and derived-object tails
 *  (`CaseId__r`, `Loc__s`, `Foo__History`, `Foo__Share`, `City__cy`). */
const UNMANAGED_TAILS: ReadonlySet<string> = new Set([
  ...MEMBER_SUFFIXES,
  "s",
  "share",
  "history",
  "feed",
  "changeevent",
  "tag",
  "cy",
]);

/** `name` split at `__` when its head is a namespace-shaped identifier. */
function managedParts(name: string): string[] | null {
  const segs = name.split("__");
  if (segs.length < 2) return null;
  if (!NS_IDENT_RE.test(segs[0] ?? "")) return null;
  if (!segs.slice(1).every((x) => NAME_SEG_RE.test(x))) return null;
  return segs;
}

/** A managed-package name: `<ns>__Name`, or `<ns>__Name__<tail>`. Unmanaged
 *  API names carry `__` only before a suffix (Apex identifiers cannot contain
 *  `__` at all), so a single-segment `X__tail` is unmanaged when the tail is a
 *  member, relationship or derived-object suffix (`CaseId__r`, `Foo__History`).
 *  `%vlocity_namespace%` is the DataPack placeholder for the Vlocity one. */
function isNamespaced(name: string): boolean {
  const segs = managedParts(name);
  if (!segs) return false;
  if (segs.length >= 3) return true;
  if ((segs[0] ?? "").toLowerCase() === NS_PLACEHOLDER) return true;
  return !UNMANAGED_TAILS.has((segs[1] ?? "").toLowerCase());
}

/** The namespace a name proves, lower-cased, or null. Only the strict member
 *  form counts: `ns__Name__<suffix>` with a member suffix (`__c`, `__r`,
 *  `__x`, `__mdt`, ...), or the placeholder. */
function namespaceOf(name: string): string | null {
  const segs = managedParts(name);
  if (!segs) return null;
  const ns = (segs[0] ?? "").toLowerCase();
  if (ns === NS_PLACEHOLDER) return ns;
  if (segs.length !== 3) return null;
  return MEMBER_SUFFIXES.has((segs[2] ?? "").toLowerCase()) ? ns : null;
}

/**
 * Namespaces the refs themselves use in `<ns>__Name` form (any dotted
 * segment of the name). Apex writes a managed type as `ns.Type`
 * (`vlocity_cmt.VlocityOpenInterface`), which is not distinguishable from an
 * inner class `Outer.Inner` by syntax alone; a head the same org also uses as
 * `ns__` is a namespace.
 */
export function namespacesIn(dsts: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const dst of dsts) {
    const name = dst.slice(dst.indexOf(":") + 1);
    for (const seg of name.split(".")) {
      const ns = namespaceOf(seg);
      if (ns) out.add(ns);
    }
  }
  return out;
}

/** Standard fields every custom object has (`X__c.Name`); any other
 *  unsuffixed field on a custom object is a parser or source gap. */
const CUSTOM_OBJECT_STANDARD_FIELDS = [
  "id",
  "name",
  "ownerid",
  "createddate",
  "createdbyid",
  "lastmodifieddate",
  "lastmodifiedbyid",
  "systemmodstamp",
  "isdeleted",
  "recordtypeid",
  "currencyisocode",
];

/** Extra standard fields by custom suffix (custom metadata types, platform
 *  events, external objects). */
const STANDARD_FIELDS_BY_SUFFIX: Readonly<Record<string, ReadonlySet<string>>> = {
  c: new Set(CUSTOM_OBJECT_STANDARD_FIELDS),
  // Custom metadata types: their own fields plus the system audit fields; no
  // owner, record type or Name.
  mdt: new Set([
    "id",
    "createdbyid",
    "createddate",
    "lastmodifiedbyid",
    "lastmodifieddate",
    "systemmodstamp",
    "developername",
    "masterlabel",
    "label",
    "namespaceprefix",
    "qualifiedapiname",
    "language",
  ]),
  e: new Set([...CUSTOM_OBJECT_STANDARD_FIELDS, "replayid", "eventuuid"]),
  x: new Set([...CUSTOM_OBJECT_STANDARD_FIELDS, "externalid", "displayurl"]),
};

/** Standard DOM events (`onclick`, `addEventListener('change')`): they
 *  never have a source in the org. Custom event names stay unexpected. */
const DOM_EVENTS: ReadonlySet<string> = new Set([
  "click",
  "dblclick",
  "contextmenu",
  "mousedown",
  "mouseup",
  "mouseover",
  "mouseout",
  "mouseenter",
  "mouseleave",
  "mousemove",
  "wheel",
  "keydown",
  "keyup",
  "keypress",
  "focus",
  "blur",
  "focusin",
  "focusout",
  "input",
  "change",
  "submit",
  "reset",
  "select",
  "scroll",
  "resize",
  "load",
  "error",
  "abort",
  "drag",
  "dragstart",
  "dragend",
  "dragenter",
  "dragleave",
  "dragover",
  "drop",
  "touchstart",
  "touchend",
  "touchmove",
  "touchcancel",
  "pointerdown",
  "pointerup",
  "pointermove",
  "pointerover",
  "pointerout",
  "pointerenter",
  "pointerleave",
  "pointercancel",
  "copy",
  "cut",
  "paste",
  "animationstart",
  "animationend",
  "animationiteration",
  "transitionend",
  "invalid",
  "toggle",
  "beforeinput",
  "compositionstart",
  "compositionend",
]);

/** First dotted segment of a name (`System.assertEquals(3)` -> `System`). */
const headOf = (name: string): string => name.split(/[.(]/, 1)[0] ?? name;

/** True when a dangling dst names something no extractor of the org's own
 *  source can ever materialize:
 *   - standard tabs (`CustomTab:standard-*`);
 *   - standard-schema objects (no custom suffix) and their unsuffixed fields;
 *     on a custom object only its real standard fields (`X__c.Name`,
 *     `X__c.OwnerId`, `Y__mdt.DeveloperName`, ...);
 *   - managed-package metadata (`<ns>__Name`, `<ns>__Obj__c.<ns>__F__c`, and
 *     `ns.Type` for a namespace in `knownNamespaces` or the
 *     `%vlocity_namespace%` placeholder);
 *   - Apex platform classes and calls into them (`System.assertEquals`,
 *     `Assert.areEqual`);
 *   - standard DOM events (`LWCEvent:click`).
 *  Custom-suffixed, unnamespaced targets are NEVER platform refs — a missing
 *  `__c` target is a real gap worth surfacing — and neither is an empty
 *  object or field name, which is a parser bug (`CustomObject:`). */
export function isPlatformBuiltinRef(
  dst: string,
  knownNamespaces: ReadonlySet<string> = new Set(),
  customSettings: ReadonlySet<string> = new Set(),
): boolean {
  const i = dst.indexOf(":");
  if (i <= 0) return false;
  const label = dst.slice(0, i);
  const name = dst.slice(i + 1);
  if (name.length === 0) return false;
  const head = headOf(name);
  // `ns.Type`: a dotted head that is a namespace.
  const dottedNs =
    name.length > head.length &&
    (head.toLowerCase() === NS_PLACEHOLDER || knownNamespaces.has(head.toLowerCase()));
  if (label === "CustomTab" && name.startsWith("standard-")) return true;
  if (label === "LWCEvent") return DOM_EVENTS.has(name.toLowerCase());
  if (label === "CustomField") {
    const dot = name.indexOf(".");
    if (dot <= 0 || dot === name.length - 1) return false;
    const obj = name.slice(0, dot);
    const field = name.slice(dot + 1);
    if (isNamespaced(obj) || isNamespaced(field)) return true;
    // A custom, relationship or derived field (`X__c`, `CaseId__r`, `City__cy`).
    if (field.includes("__")) return false;
    const suffix = CUSTOM_SUFFIX_RE.exec(obj)?.[0].slice(2).toLowerCase();
    if (suffix === undefined && !obj.includes("__")) return true; // standard object
    if (field.toLowerCase() === "setupownerid") return customSettings.has(obj.toLowerCase());
    return (
      (STANDARD_FIELDS_BY_SUFFIX[suffix ?? "c"] ?? STANDARD_FIELDS_BY_SUFFIX.c)?.has(
        field.toLowerCase(),
      ) === true
    );
  }
  if (label === "CustomObject") {
    // Standard objects never contain `__` (`Foo__History` is derived from a custom one).
    return isNamespaced(name) || !name.includes("__");
  }
  if (label === "ApexClass" || label === "ApexInterface" || label === "ApexMethod") {
    // The narrow core set, not the parser superset (see AUDIT_PLATFORM_CORE).
    return AUDIT_PLATFORM_CORE.has(head.toLowerCase()) || isNamespaced(head) || dottedNs;
  }
  // Any other metadata named in a managed namespace (ApexPage, CustomTab,
  // CustomMetadataType, StaticResource, Remote, ...).
  return isNamespaced(head) || dottedNs;
}

/** Edge-level classification: `isPlatformBuiltinRef` on the target, plus
 *  what only the edge knows. A `lightning-*` tag is a base component
 *  (`LWC:button` from `<lightning-button>`); an `IS_TEST_FOR` target is
 *  always an org class, so a dangling one is a parser gap even when its name
 *  is a platform class (`ApexClass:Test` from `Test.startTest()`). */
export function isExpectedDanglingEdge(
  e: Pick<EdgeFact, "relType" | "dstQualifiedName" | "attributes">,
  knownNamespaces: ReadonlySet<string> = new Set(),
  customSettings: ReadonlySet<string> = new Set(),
): boolean {
  return (
    edgeVerdict(String(e.relType), () => e.attributes) ??
    isPlatformBuiltinRef(String(e.dstQualifiedName), knownNamespaces, customSettings)
  );
}

/** The part of `isExpectedDanglingEdge` only the edge decides: false for
 *  IS_TEST_FOR, true for a `lightning-*` tag, undefined when the target
 *  decides. `attrs` is called only when the tag matters. */
function edgeVerdict(relType: string, attrs: () => unknown): boolean | undefined {
  if (relType === REL_TYPES.IS_TEST_FOR) return false;
  const tag = (attrs() as Record<string, unknown> | undefined)?.tag;
  if (typeof tag === "string" && tag.toLowerCase().startsWith("lightning-")) return true;
  return undefined;
}

/** Parsed attributes of a stored edge row, skipping the parse when the JSON
 *  cannot hold a top-level `tag` key (the only key the classifier reads). */
function rowAttrs(json: string): unknown {
  return json.includes('"tag"') ? JSON.parse(json) : undefined;
}

/** Classification key of a dangling edge: its edge verdict plus its target.
 *  Edges with the same key are classified alike, so the audit classifies
 *  each distinct key once. */
function verdictKey(e: DanglingEdgeRow): string {
  const v = edgeVerdict(e.relType, () => rowAttrs(e.attributes));
  return `${v === undefined ? "P" : v ? "E" : "U"}${e.dst}`;
}

function keyIsExpected(
  key: string,
  knownNamespaces: ReadonlySet<string>,
  customSettings: ReadonlySet<string>,
): boolean {
  const v = key[0];
  if (v === "E") return true;
  if (v === "U") return false;
  return isPlatformBuiltinRef(key.slice(1), knownNamespaces, customSettings);
}

/** Lower-cased objects, among those with a dangling `SetupOwnerId` ref, that
 *  the graph knows to be custom settings: the object node carries
 *  `customSettingsType`, or a `CustomSetting:<obj>` node exists. */
function customSettingsIn(store: GraphStore, orgId: OrgId, dsts: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>();
  for (const dst of dsts) {
    if (!dst.startsWith("CustomField:") || !/\.setupownerid$/i.test(dst)) continue;
    const obj = dst.slice("CustomField:".length, dst.lastIndexOf("."));
    if (seen.has(obj)) continue;
    seen.add(obj);
    const node = store.getNode(orgId, asQualifiedName(`CustomObject:${obj}`));
    const type = (node?.attributes as Record<string, unknown> | undefined)?.customSettingsType;
    const known =
      (typeof type === "string" && type.length > 0) ||
      store.getNode(orgId, asQualifiedName(`CustomSetting:${obj}`)) !== null;
    if (known) out.add(obj.toLowerCase());
  }
  return out;
}

export function auditDanglingEdges(
  store: GraphStore,
  orgIdIn: OrgId | string,
  opts: AuditOpts = {},
): AuditResult {
  const orgId = typeof orgIdIn === "string" ? asOrgId(orgIdIn) : orgIdIn;
  // Clamp to ≥0; a negative slice index would silently return a tail of the
  // dangling array rather than an empty sample. Truncate as slice() did
  // (2.5 -> 2; NaN stays NaN and, like slice(0, NaN), yields no sample).
  const sampleSize = Math.trunc(Math.max(0, opts.sampleSize ?? 25));

  const totalEdges = store.countEdges(orgId);

  // Streamed: a large org has ~1M dangling edges (645k of them
  // GRANTS_APEX_ACCESS), so they are never held at once. Pass 1 counts, and keeps each
  // distinct classification key once plus the first `sampleSize` edges.
  const byRel: Record<string, number> = {};
  const byDstPrefix: Record<string, number> = {};
  let danglingCount = 0;
  const keyCounts = new Map<string, number>();
  const head: DanglingEdgeRow[] = [];
  for (const e of store.iterateDanglingEdges(orgId, opts.scanLimit)) {
    danglingCount += 1;
    byRel[e.relType] = (byRel[e.relType] ?? 0) + 1;
    const p = prefix(e.dst);
    byDstPrefix[p] = (byDstPrefix[p] ?? 0) + 1;
    const k = verdictKey(e);
    keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1);
    if (head.length < sampleSize) head.push(e);
  }

  // Both sets depend only on the distinct targets.
  const dsts = new Set<string>();
  for (const k of keyCounts.keys()) dsts.add(k.slice(1));
  const namespaces = namespacesIn(dsts);
  const customSettings = customSettingsIn(store, orgId, dsts);
  const expectedKeys = new Set<string>();
  let platformRefCount = 0;
  for (const [k, n] of keyCounts) {
    if (!keyIsExpected(k, namespaces, customSettings)) continue;
    expectedKeys.add(k);
    platformRefCount += n;
  }
  const unexpectedCount = danglingCount - platformRefCount;

  // Sample the *unexpected* dangling edges first — those are the ones a
  // user can act on; platform refs only pad the sample once the unexpected
  // set is smaller than sampleSize. Same result as a stable sort of every
  // edge, unexpected first: the first unexpected edges in scan order (pass 2,
  // stopped as soon as enough are found), then the first expected ones, which
  // all lie within the first `sampleSize` edges (`head`).
  const picked: DanglingEdgeRow[] = [];
  const wantUnexpected = Math.min(sampleSize, unexpectedCount);
  if (wantUnexpected > 0) {
    for (const e of store.iterateDanglingEdges(orgId, opts.scanLimit)) {
      if (expectedKeys.has(verdictKey(e))) continue;
      picked.push(e);
      if (picked.length >= wantUnexpected) break;
    }
  }
  for (const e of head) {
    if (picked.length >= sampleSize) break;
    if (expectedKeys.has(verdictKey(e))) picked.push(e);
  }
  const sample: DanglingEdgeSample[] = picked.map((e) => ({
    src: e.src,
    rel: e.relType,
    dst: e.dst,
  }));

  return {
    totalEdges,
    danglingCount,
    platformRefCount,
    unexpectedCount,
    byRel,
    byDstPrefix,
    sample,
  };
}

/**
 * Destructive companion to `auditDanglingEdges`: deletes dangling edges.
 * Reserved for the CLI `--delete-dangling --yes` flag; callers must own the
 * authorization decision (we just do the work).
 *
 * Platform-builtin references (standard-tab grants, standard-schema field
 * grants) are KEPT by default — they're real, queryable security data whose
 * target simply has no metadata source. Pass `includePlatformRefs: true` to
 * delete those too.
 */
export function deleteDanglingEdges(
  store: GraphStore,
  orgIdIn: OrgId | string,
  opts: { includePlatformRefs?: boolean } = {},
): { deleted: number; keptPlatformRefs: number } {
  const orgId = typeof orgIdIn === "string" ? asOrgId(orgIdIn) : orgIdIn;
  const dangling = store.listDanglingEdges(orgId);
  let deleted = 0;
  let keptPlatformRefs = 0;
  store.transaction(() => {
    for (const e of dangling) {
      if (!opts.includePlatformRefs && isPlatformBuiltinRef(String(e.dstQualifiedName))) {
        keptPlatformRefs += 1;
        continue;
      }
      store.deleteEdge(
        orgId,
        e.srcQualifiedName as QualifiedName,
        e.dstQualifiedName as QualifiedName,
        e.relType as RelType,
      );
      deleted += 1;
    }
  });
  return { deleted, keptPlatformRefs };
}

export type { EdgeFact };
