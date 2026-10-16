import type { OrgId, QualifiedName } from "@ryanstark24/sfgraph-shared";
import type { GraphStore } from "../storage/interfaces.js";
import { TRAVERSAL_CONTAINMENT_RULES, componentOf } from "./containment.js";
import { codePointCompare } from "./pseudo-endpoints.js";

/**
 * Change scoping for the change tools (point_in_time_diff, what_broke): which
 * node labels are *components* (units of code, declarative logic, schema or
 * integration endpoints that a change can break or be broken by) and which are
 * *records / configuration* (data rows, access and UI configuration, labels,
 * diagnostics). Record/config rows are never dropped: the tools return them in
 * a separate `nonComponent*` bucket and list them under their own heading.
 *
 * The split follows the label taxonomy of the parsers, not any case data:
 *  - every label a dedicated parser emits is listed below on one side, with
 *    the reason it is on that side;
 *  - every other label comes from the opaque fallback (`OpaqueNodeParser`),
 *    which labels a long-tail metadata member or a Vlocity DataPack record
 *    with its raw type name (EntityFilter, VlocityPicklist, ...). No such type
 *    has a parser of its own, so none is a parsed component: unknown labels are
 *    record/config (`changeScopeOfLabel`).
 *
 * Member labels (ApexMethod, FlowVersion, LWCBundle's LWC pairing) are
 * components; they roll up to their owner (`changeUnitOf`).
 */
export const COMPONENT_LABEL_REASONS: Readonly<Record<string, string>> = {
  // Code.
  ApexClass: "Apex source code",
  ApexTrigger: "Apex source code",
  ApexInterface: "Apex source code (an interface type)",
  ApexMethod: "member of an ApexClass (rolls up to the class)",
  TestMethod: "member of a test ApexClass (rolls up to the class)",
  ApexPage: "Visualforce page markup and controller binding",
  ApexComponent: "Visualforce component markup",
  LWC: "Lightning web component source",
  LWCBundle: "the LWC's own bundle (folds into its same-name LWC)",
  AuraComponent: "Aura component source",
  // Declarative logic.
  Flow: "declarative automation",
  FlowVersion: "member of a Flow (rolls up to the Flow)",
  Workflow: "declarative automation (workflow rules container)",
  WorkflowRule: "declarative automation",
  WorkflowAlert: "declarative automation action of a Workflow",
  ApprovalProcess: "declarative automation",
  ValidationRule: "declarative logic on an object (a formula)",
  DuplicateRule: "declarative logic on an object",
  MatchingRule: "declarative logic on an object",
  GenAiPlanner: "agent logic definition",
  GenAiPlugin: "agent logic definition",
  // OmniStudio / Vlocity components (dedicated parsers).
  OmniScript: "OmniStudio script (dedicated parser)",
  IntegrationProcedure: "OmniStudio integration procedure (dedicated parser)",
  DataRaptor: "OmniStudio data mapper (dedicated parser)",
  VlocityCard: "OmniStudio card (dedicated parser)",
  OmniProcess: "OmniStudio standard-runtime script/procedure (dedicated parser)",
  OmniIntegrationProcedure: "OmniStudio standard-runtime procedure (dedicated parser)",
  OmniDataTransform: "OmniStudio standard-runtime data mapper (dedicated parser)",
  OmniUiCard: "OmniStudio standard-runtime card (dedicated parser)",
  // Schema.
  CustomObject: "schema: an object definition",
  CustomField: "schema: a field definition",
  CustomSetting: "schema: a custom setting type definition (not its records)",
  CustomMetadataType: "schema: a custom metadata type definition (not its records)",
  PlatformEvent: "schema: a platform event definition",
  // Integration endpoints.
  NamedCredential: "integration endpoint definition",
  ExternalCredential: "integration endpoint authentication definition",
  ExternalServiceRegistration: "integration endpoint (OpenAPI) definition",
};

export const RECORD_CONFIG_LABEL_REASONS: Readonly<Record<string, string>> = {
  // Records (data rows, not definitions).
  CustomMetadataRecord: "a record of a custom metadata type (data)",
  // Access configuration.
  Profile: "access configuration",
  PermissionSet: "access configuration",
  PermissionSetGroup: "access configuration",
  SharingRule: "access configuration",
  Role: "access configuration",
  Group: "access configuration",
  Queue: "access / routing configuration",
  // UI configuration.
  Layout: "UI configuration",
  FlexiPage: "UI configuration",
  CustomTab: "UI configuration",
  RecordType: "UI / picklist configuration of an object (no logic, no schema of its own)",
  Network: "site configuration",
  // Content, analytics and setup.
  CustomLabel: "translatable text",
  StaticResource: "file asset (no parsed logic)",
  EmailTemplate: "content",
  Report: "analytics configuration",
  Dashboard: "analytics configuration",
  ConnectedApp: "authentication configuration",
  RemoteSiteSetting: "endpoint allowlist entry",
  // Diagnostics.
  ParseError: "parser diagnostic, not metadata",
  OpaqueMetadata: "opaque fallback node (no dedicated parser)",
};

export const COMPONENT_LABELS: ReadonlySet<string> = new Set(Object.keys(COMPONENT_LABEL_REASONS));

/** Labels listed as record/config; any label not in COMPONENT_LABELS is too. */
export const RECORD_CONFIG_LABELS: ReadonlySet<string> = new Set(
  Object.keys(RECORD_CONFIG_LABEL_REASONS),
);

export type ChangeScope = "component" | "record-config";

/** `component` for a COMPONENT_LABELS label, else `record-config` (listed
 *  record/config labels and every opaque-fallback label). */
export function changeScopeOfLabel(label: string): ChangeScope {
  return COMPONENT_LABELS.has(label) ? "component" : "record-config";
}

const labelOfQ = (q: string): string => {
  const i = q.indexOf(":");
  return i > 0 ? q.slice(0, i) : "";
};

/** Owner name of a member name, by the member's qualified-name grammar. */
const OWNER_NAME_OF: Readonly<Record<string, (memberName: string) => string | null>> = {
  // `ApexMethod:Cls.method(2)` (TestMethod nodes use the same qname form).
  ApexMethod: (n) => {
    const m = /^(.+)\.[^.()]+\(\d*\)$/.exec(n);
    return m?.[1] ?? null;
  },
  // `FlowVersion:My_Flow.v12`.
  FlowVersion: (n) => {
    const m = /^(.+)\.v\d+$/.exec(n);
    return m?.[1] ?? null;
  },
};

/**
 * The component a qname folds into by name grammar alone, for rows that have
 * no live containment edge (a removed member): an ApexMethod into its
 * ApexClass, a FlowVersion into its Flow, an LWCBundle into its same-name
 * LWC (the traversal rules of containment.ts). Else `qname` itself.
 */
export function componentByName(qname: string): string {
  const label = labelOfQ(qname);
  const name = qname.slice(qname.indexOf(":") + 1);
  for (const r of TRAVERSAL_CONTAINMENT_RULES) {
    if (r.row !== "member" && r.memberLabel === label) {
      const owner = OWNER_NAME_OF[label]?.(name);
      if (owner) return `${r.ownerLabel}:${owner}`;
    }
    if (r.row === "member" && r.sameName && r.ownerLabel === label) {
      return `${r.memberLabel}:${name}`;
    }
  }
  return qname;
}

/**
 * The component unit of a changed row: containment edges first
 * (`componentOf`), then the name grammar (`componentByName`) for a row with
 * no live edge (removed) and for a bundle folding into its LWC.
 */
export function changeUnitOf(store: GraphStore, orgId: OrgId, qname: string): string {
  const viaEdges = String(componentOf(store, orgId, qname as QualifiedName));
  return viaEdges !== qname ? viaEdges : componentByName(qname);
}

/** The change scope of a unit qname (by its label prefix). */
export function changeScopeOf(unit: string, fallbackLabel?: string): ChangeScope {
  return changeScopeOfLabel(labelOfQ(unit) || fallbackLabel || "");
}

export interface ChangeBuckets {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface ScopedNodeDiff {
  /** Component units (members rolled up), each list sorted by code point. */
  component: ChangeBuckets;
  /** Record/config units, same shape. */
  nonComponent: ChangeBuckets;
}

type Bucket = keyof ChangeBuckets;

/**
 * A node-level diff folded to change units and split by change scope.
 * A unit takes the bucket of its own row when that row is in the diff (a new
 * class with its methods is `added`); a unit reached only through members (a
 * method body or a FlowVersion changed, a method removed) existed before and
 * after, so it is `changed`. Units are compared without case (qnames are
 * NOCASE in the store) and keep the first spelling seen.
 */
export function scopeNodeDiff(
  store: GraphStore,
  orgId: OrgId,
  diff: {
    added: ReadonlyArray<{ qualifiedName: string; label?: string }>;
    removed: ReadonlyArray<{ qualifiedName: string; label?: string }>;
    changed: ReadonlyArray<{ after: { qualifiedName: string; label?: string } }>;
  },
): ScopedNodeDiff {
  const rows: Array<{ q: string; label: string | undefined; bucket: Bucket }> = [
    ...diff.added.map((x) => ({
      q: String(x.qualifiedName),
      label: x.label,
      bucket: "added" as const,
    })),
    ...diff.removed.map((x) => ({
      q: String(x.qualifiedName),
      label: x.label,
      bucket: "removed" as const,
    })),
    ...diff.changed.map((c) => ({
      q: String(c.after.qualifiedName),
      label: c.after.label,
      bucket: "changed" as const,
    })),
  ];
  const ownBucket = new Map<string, Bucket>();
  for (const r of rows) ownBucket.set(r.q.toLowerCase(), r.bucket);
  const units = new Map<string, { unit: string; label: string | undefined }>();
  for (const r of rows) {
    const unit = changeUnitOf(store, orgId, r.q);
    const key = unit.toLowerCase();
    if (!units.has(key)) units.set(key, { unit, label: unit === r.q ? r.label : undefined });
  }
  const out: ScopedNodeDiff = {
    component: { added: [], removed: [], changed: [] },
    nonComponent: { added: [], removed: [], changed: [] },
  };
  for (const [key, { unit, label }] of units) {
    const bucket = ownBucket.get(key) ?? "changed";
    const side = changeScopeOf(unit, label) === "component" ? out.component : out.nonComponent;
    side[bucket].push(unit);
  }
  for (const side of [out.component, out.nonComponent]) {
    side.added.sort(codePointCompare);
    side.removed.sort(codePointCompare);
    side.changed.sort(codePointCompare);
  }
  return out;
}
