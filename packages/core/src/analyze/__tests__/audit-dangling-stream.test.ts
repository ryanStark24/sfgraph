import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import type { OrgId } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type EdgeFact, type NodeFact, REL_TYPES } from "../../domain/index.js";
import type { GraphStore } from "../../storage/interfaces.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import {
  type AuditOpts,
  type AuditResult,
  type DanglingEdgeSample,
  auditDanglingEdges,
} from "../audit-graph.js";

/**
 * The dangling-edge audit streams the edges instead of loading every one
 * (830k on a large org). Its output must stay exactly what the in-memory
 * implementation returned. The oracle below is a FROZEN copy of
 * analyze/audit-graph.ts at b557be7 (classifier, namespace and custom-setting
 * logic included); it must not import anything from audit-graph.ts, so a
 * change to the live classifier is caught here. Do not edit it to match.
 */

// ─── frozen oracle: audit-graph.ts @ b557be7, lines 53-482 ─────────────────
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
function namespacesIn(dsts: Iterable<string>): Set<string> {
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

/** Apex platform classes / namespaces (System and friends): calls into them
 *  (`ApexMethod:System.assertEquals(3)`) never have a source in the org. */
const PLATFORM_APEX_CLASSES: ReadonlySet<string> = new Set(
  [
    "System",
    "Assert",
    "Database",
    "Schema",
    "Test",
    "Limits",
    "UserInfo",
    "Math",
    "String",
    "Integer",
    "Long",
    "Decimal",
    "Double",
    "Boolean",
    "Date",
    "Datetime",
    "Time",
    "TimeZone",
    "Blob",
    "Id",
    "Object",
    "List",
    "Map",
    "Set",
    "JSON",
    "JSONParser",
    "JSONGenerator",
    "Type",
    "Url",
    "Pattern",
    "Matcher",
    "Crypto",
    "EncodingUtil",
    "Http",
    "HttpRequest",
    "HttpResponse",
    "Messaging",
    "ApexPages",
    "PageReference",
    "Site",
    "Network",
    "Label",
    "Approval",
    "Auth",
    "Cache",
    "ConnectApi",
    "EventBus",
    "Flow",
    "Process",
    "QuickAction",
    "Search",
    "Security",
    "Trigger",
    "Exception",
    "DmlException",
    "QueryException",
    "Dom",
    "XmlStreamReader",
    "XmlStreamWriter",
    "SObject",
    "SObjectType",
    "SObjectField",
    "DescribeSObjectResult",
    "DescribeFieldResult",
    "Queueable",
    "Schedulable",
    "Batchable",
    "Iterable",
    "Iterator",
    "Comparable",
    "Callable",
    "Savepoint",
    "Reports",
    "Metadata",
    "Canvas",
    "Invocable",
  ].map((c) => c.toLowerCase()),
);

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
function isPlatformBuiltinRef(
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
    return PLATFORM_APEX_CLASSES.has(head.toLowerCase()) || isNamespaced(head) || dottedNs;
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
function isExpectedDanglingEdge(
  e: Pick<EdgeFact, "relType" | "dstQualifiedName" | "attributes">,
  knownNamespaces: ReadonlySet<string> = new Set(),
  customSettings: ReadonlySet<string> = new Set(),
): boolean {
  if (String(e.relType) === REL_TYPES.IS_TEST_FOR) return false;
  const tag = (e.attributes as Record<string, unknown> | undefined)?.tag;
  if (typeof tag === "string" && tag.toLowerCase().startsWith("lightning-")) return true;
  return isPlatformBuiltinRef(String(e.dstQualifiedName), knownNamespaces, customSettings);
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

function legacyAuditDanglingEdges(
  store: GraphStore,
  orgIdIn: OrgId | string,
  opts: AuditOpts = {},
): AuditResult {
  const orgId = typeof orgIdIn === "string" ? asOrgId(orgIdIn) : orgIdIn;
  // Clamp to ≥0; a negative slice index would silently return a tail of the
  // dangling array rather than an empty sample.
  const sampleSize = Math.max(0, opts.sampleSize ?? 25);

  const totalEdges = store.countEdges(orgId);
  const dangling = store.listDanglingEdges(orgId, opts.scanLimit);

  const byRel: Record<string, number> = {};
  const byDstPrefix: Record<string, number> = {};
  let platformRefCount = 0;
  const namespaces = namespacesIn(dangling.map((e) => String(e.dstQualifiedName)));
  const customSettings = customSettingsIn(
    store,
    orgId,
    dangling.map((e) => String(e.dstQualifiedName)),
  );
  const expected = new Set<(typeof dangling)[number]>();
  for (const e of dangling) {
    byRel[e.relType] = (byRel[e.relType] ?? 0) + 1;
    const dst = String(e.dstQualifiedName);
    const p = prefix(dst);
    byDstPrefix[p] = (byDstPrefix[p] ?? 0) + 1;
    if (isExpectedDanglingEdge(e, namespaces, customSettings)) {
      platformRefCount += 1;
      expected.add(e);
    }
  }

  // Sample the *unexpected* dangling edges first — those are the ones a
  // user can act on; platform refs only pad the sample once the unexpected
  // set is smaller than sampleSize.
  const unexpectedFirst = [...dangling].sort((a, b) => {
    const ap = expected.has(a) ? 1 : 0;
    const bp = expected.has(b) ? 1 : 0;
    return ap - bp;
  });
  const sample: DanglingEdgeSample[] = unexpectedFirst.slice(0, sampleSize).map((e) => ({
    src: String(e.srcQualifiedName),
    rel: String(e.relType),
    dst: String(e.dstQualifiedName),
  }));

  return {
    totalEdges,
    danglingCount: dangling.length,
    platformRefCount,
    unexpectedCount: dangling.length - platformRefCount,
    byRel,
    byDstPrefix,
    sample,
  };
}

// ─── end of frozen oracle ──────────────────────────────────────────────────

const ORG = asOrgId("org_stream");
const OTHER = asOrgId("org_other");

function node(qname: string, attributes: Record<string, unknown> = {}, orgId = ORG): NodeFact {
  return {
    orgId,
    qualifiedName: asQualifiedName(qname),
    label: qname.slice(0, qname.indexOf(":")),
    attributes,
    sourceHash: asSha256("h"),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
}

function edge(
  rel: string,
  src: string,
  dst: string,
  attributes: Record<string, unknown> = {},
  orgId = ORG,
): EdgeFact {
  return {
    orgId,
    srcQualifiedName: asQualifiedName(src),
    dstQualifiedName: asQualifiedName(dst),
    relType: rel as EdgeFact["relType"],
    attributes,
    firstSeenAt: 1,
    lastSeenAt: 1,
  };
}

// Dangling targets covering every classifier branch; a few exist as nodes.
const DSTS = [
  "ApexClass:vlocity_cmt__DRGlobal",
  "ApexInterface:vlocity_cmt.VlocityOpenInterface",
  "ApexClass:%vlocity_namespace%.Thing",
  "ApexClass:Missing",
  "ApexClass:Test",
  "ApexMethod:System.assertEquals(3)",
  "ApexMethod:Ghost.run(?)",
  "ApexMethod:CaseId.add(1)",
  "CustomObject:Account",
  "CustomObject:Missing__c",
  "CustomObject:acme__Widget__c",
  "CustomObject:",
  "CustomField:Account.Name",
  "CustomField:Account.My_Field__c",
  "CustomField:Quote.CaseId__r",
  "CustomField:My_Obj__c.Name",
  "CustomField:My_Obj__c.Score",
  "CustomField:Cfg__mdt.DeveloperName",
  "CustomField:Settings__c.SetupOwnerId",
  "CustomField:Plain__c.SetupOwnerId",
  "CustomField:Tagged__c.SetupOwnerId",
  "CustomField:vlocity_cmt__Party__c.vlocity_cmt__Status__c",
  "CustomTab:standard-Account",
  "CustomTab:My_Tab",
  "LWCEvent:click",
  "LWCEvent:myevent",
  "LWC:button",
  "LWC:panel",
  "ApexPage:acme__Console",
  "Remote:unknown",
  "nolabel",
  "ApexClass:Real",
];

const RELS = [
  "CALLS",
  "READS_FIELD",
  "GRANTS_APEX_ACCESS",
  "EMBEDS_LWC",
  "IS_TEST_FOR",
  "GRANTS_TAB_ACCESS",
  "LISTENS_TO_EVENT",
  "IMPLEMENTS",
];

/** Deterministic PRNG so the fixture is stable. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

async function fixture(seed: number, n: number, dbPath = ":memory:"): Promise<SqliteGraphStore> {
  const store = new SqliteGraphStore({ dbPath, fileCheckIntervalMs: 0 });
  await store.init();
  store.mergeNodes([
    node("ApexClass:Real"),
    node("CustomObject:Settings__c", { customSettingsType: "Hierarchy" }),
    node("CustomSetting:Tagged__c"),
    node("CustomObject:Plain__c"),
  ]);
  // Another org's rows must never leak into this org's audit.
  store.mergeNodes([node("ApexClass:Missing", {}, OTHER)]);
  store.mergeEdges([edge("CALLS", "ApexClass:X", "ApexClass:Nowhere", {}, OTHER)]);
  const r = rng(seed);
  const facts: EdgeFact[] = [];
  for (let i = 0; i < n; i++) {
    const rel = RELS[Math.floor(r() * RELS.length)] as string;
    const dst = DSTS[Math.floor(r() * DSTS.length)] as string;
    const roll = r();
    const attrs: Record<string, unknown> =
      roll < 0.15
        ? { tag: "lightning-button" }
        : roll < 0.25
          ? { tag: "c-panel", line: i }
          : roll < 0.3
            ? { note: "tag", nested: { tag: "lightning-x" } }
            : {};
    facts.push(edge(rel, `ApexClass:Src${i}`, dst, attrs));
  }
  store.mergeEdges(facts);
  return store;
}

function expectSame(store: SqliteGraphStore, opts?: AuditOpts): void {
  const want = legacyAuditDanglingEdges(store, ORG, opts);
  const got = auditDanglingEdges(store, ORG, opts);
  expect(got).toStrictEqual(want);
  // Key order of byRel/byDstPrefix shows in the ingest log line.
  expect(JSON.stringify(got)).toBe(JSON.stringify(want));
}

describe("auditDanglingEdges: streaming output equals the in-memory implementation", () => {
  let store: SqliteGraphStore;
  afterEach(async () => {
    await store.close();
  });

  for (const seed of [1, 7, 42]) {
    it(`seed ${seed}: default options and every sample size`, async () => {
      store = await fixture(seed, 600);
      // The fixture exercises both classes and the custom-setting lookup.
      const r = auditDanglingEdges(store, ORG, { sampleSize: 600 });
      expect(r.platformRefCount).toBeGreaterThan(50);
      expect(r.unexpectedCount).toBeGreaterThan(50);
      expect(r.sample.some((s) => s.dst === "CustomField:Settings__c.SetupOwnerId")).toBe(true);
      expectSame(store);
      for (const sampleSize of [0, 1, 5, 25, 200, 10_000, -3]) expectSame(store, { sampleSize });
    });

    it(`seed ${seed}: scanLimit caps the scan the same way`, async () => {
      store = await fixture(seed, 600);
      for (const scanLimit of [1, 7, 50, 333, 599, 600, 5000, 0]) {
        expectSame(store, { scanLimit });
        expectSame(store, { scanLimit, sampleSize: 3 });
      }
    });
  }

  it("pads the sample with platform refs when few edges are unexpected", async () => {
    store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    const facts: EdgeFact[] = [];
    for (let i = 0; i < 40; i++)
      facts.push(edge("CALLS", `ApexClass:S${i}`, "ApexMethod:System.debug(1)"));
    facts.push(edge("CALLS", "ApexClass:Late", "ApexMethod:Ghost.run(?)"));
    facts.push(edge("READS_FIELD", "ApexClass:Late2", "CustomField:Account.Gap__c"));
    store.mergeEdges(facts);
    expectSame(store);
    expectSame(store, { sampleSize: 41 });
    expect(
      auditDanglingEdges(store, ORG, { sampleSize: 3 })
        .sample.slice(0, 2)
        .map((s) => s.dst),
    ).toEqual(["ApexMethod:Ghost.run(?)", "CustomField:Account.Gap__c"]);
  });

  it("non-integer sample sizes truncate like the old slice()", async () => {
    store = await fixture(13, 300);
    for (const sampleSize of [2.5, 0.4, 24.99, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectSame(store, { sampleSize });
    }
  });

  it("an org with no dangling edges", async () => {
    store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    store.mergeNodes([node("ApexClass:A"), node("ApexClass:B")]);
    store.mergeEdges([edge("CALLS", "ApexClass:A", "ApexClass:B")]);
    expectSame(store);
  });
});

describe("auditDanglingEdges: memory shape", () => {
  let store: SqliteGraphStore;
  beforeEach(async () => {
    store = await fixture(3, 300);
  });
  afterEach(async () => {
    await store.close();
  });

  it("never materialises the full dangling-edge list", () => {
    const spy = vi.spyOn(store, "listDanglingEdges");
    auditDanglingEdges(store, ORG);
    expect(spy).not.toHaveBeenCalled();
  });

  it("iterateDanglingEdges yields the same edges, in order, as listDanglingEdges", () => {
    for (const limit of [undefined, 0, 1, 17, 299, 300, 1000]) {
      const listed = store.listDanglingEdges(ORG, limit).map((e) => ({
        relType: String(e.relType),
        src: String(e.srcQualifiedName),
        dst: String(e.dstQualifiedName),
        attributes: e.attributes,
      }));
      const streamed = [...store.iterateDanglingEdges(ORG, limit)].map((e) => ({
        relType: e.relType,
        src: e.src,
        dst: e.dst,
        attributes: JSON.parse(e.attributes) as Record<string, unknown>,
      }));
      expect(streamed).toStrictEqual(listed);
    }
  });
});

describe("auditDanglingEdges: file-backed store", () => {
  let dir: string;
  let store: SqliteGraphStore;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sfg-audit-stream-"));
  });
  afterEach(async () => {
    await store?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("matches the oracle on a file-backed DB", async () => {
    store = await fixture(11, 600, path.join(dir, "g.sqlite"));
    expectSame(store);
    expectSame(store, { sampleSize: 3 });
    expectSame(store, { scanLimit: 101, sampleSize: 200 });
  });

  it("sees an edge table another connection created (syncCaches)", async () => {
    const dbPath = path.join(dir, "g.sqlite");
    store = await fixture(5, 100, dbPath);
    const before = auditDanglingEdges(store, ORG);
    expect(before.byRel.WRITES_FIELD).toBeUndefined();
    const other = new SqliteGraphStore({ dbPath, fileCheckIntervalMs: 0 });
    await other.init();
    other.mergeEdges([edge("WRITES_FIELD", "ApexClass:W", "CustomField:Gap__c.X__c")]);
    await other.close();
    const sync = vi.spyOn(store as unknown as { syncCaches: () => void }, "syncCaches");
    const after = auditDanglingEdges(store, ORG);
    expect(sync).toHaveBeenCalled();
    expect(after.byRel.WRITES_FIELD).toBe(1);
    expect(after.danglingCount).toBe(before.danglingCount + 1);
    expectSame(store);
  });
});

describe("iterateDanglingEdges: statement lifecycle", () => {
  let store: SqliteGraphStore;
  beforeEach(async () => {
    store = await fixture(9, 200);
  });
  afterEach(async () => {
    await store.close();
  });

  /** Fails with "connection is busy" if a statement iterator is still open. */
  function writeWorks(): void {
    store.mergeEdges([edge("CALLS", "ApexClass:After", "ApexClass:Nowhere")]);
  }

  it("calls syncCaches before reading", () => {
    const sync = vi.spyOn(store as unknown as { syncCaches: () => void }, "syncCaches");
    const it = store.iterateDanglingEdges(ORG);
    expect(sync).not.toHaveBeenCalled(); // generators are lazy
    it.next();
    expect(sync).toHaveBeenCalledTimes(1);
    it.return?.(undefined);
  });

  it("releases the statement on an early break", () => {
    let n = 0;
    for (const _ of store.iterateDanglingEdges(ORG)) {
      if (++n === 3) break;
    }
    expect(n).toBe(3);
    expect(() => writeWorks()).not.toThrow();
  });

  it("releases the statement when the loop body throws", () => {
    expect(() => {
      for (const _ of store.iterateDanglingEdges(ORG)) throw new Error("boom");
    }).toThrow("boom");
    expect(() => writeWorks()).not.toThrow();
  });

  it("an open iterator does block writes (the check above is meaningful)", () => {
    const it = store.iterateDanglingEdges(ORG);
    it.next();
    expect(() => writeWorks()).toThrow(/busy/i);
    it.return?.(undefined);
    expect(() => writeWorks()).not.toThrow();
  });

  it("the audit leaves no statement open (pass 2 stops early)", () => {
    const r = auditDanglingEdges(store, ORG, { sampleSize: 2 });
    expect(r.unexpectedCount).toBeGreaterThan(2);
    expect(() => writeWorks()).not.toThrow();
  });
});
