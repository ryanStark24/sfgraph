import type { OrgId, QualifiedName } from "@ryanstark24/sfgraph-shared";
import { type NodeFact, REL_TYPES } from "../domain/index.js";
import type { GraphStore } from "../storage/interfaces.js";

/**
 * Known external entry points of an Apex class: ways code runs without any
 * other node in the graph calling it. Integrations, the UI, schedules and the
 * platform reach these from outside the org's metadata, so "no captured
 * incoming references" proves nothing about them.
 */
export type ExternalEntryPoint =
  | "rest_resource"
  | "global"
  | "webservice"
  | "invocable_method"
  | "aura_enabled"
  | "remote_action"
  | "schedulable"
  | "batchable"
  | "queueable"
  | "inbound_email_handler"
  | "event_subscriber";

/** Plain words for each kind (tool text). */
export const ENTRY_POINT_PLAIN: Readonly<Record<ExternalEntryPoint, string>> = {
  rest_resource: "a REST endpoint (an @Http method)",
  global: "global (callable from other packages and orgs)",
  webservice: "a webservice method",
  invocable_method: "an invocable method (Flow, Process Builder, REST)",
  aura_enabled: "an @AuraEnabled method (called from the UI)",
  remote_action: "a @RemoteAction method (called from Visualforce)",
  schedulable: "a Schedulable class (run by a schedule)",
  batchable: "a Batchable class (run as a batch job)",
  queueable: "a Queueable class (run as a queued job)",
  inbound_email_handler: "an inbound email handler",
  event_subscriber: "a platform event subscriber (an Apex trigger on a __e object)",
};

/** Reason-token prefix the score cache stores an entry point under. */
export const ENTRY_POINT_REASON_PREFIX = "entry_point:";
/** Reason token present when any entry point is. */
export const EXTERNAL_ENTRY_POINT_REASON = "external_entry_point";

const INTERFACE_KINDS: ReadonlyArray<[RegExp, ExternalEntryPoint]> = [
  [/^(?:system\.)?schedulable$/, "schedulable"],
  [/^(?:database\.)?batchable$/, "batchable"],
  [/^(?:system\.)?queueable$/, "queueable"],
  [/^messaging\.inboundemailhandler$/, "inbound_email_handler"],
];

const ORDER: readonly ExternalEntryPoint[] = [
  "rest_resource",
  "webservice",
  "invocable_method",
  "aura_enabled",
  "remote_action",
  "schedulable",
  "batchable",
  "queueable",
  "inbound_email_handler",
  "event_subscriber",
  "global",
];

const modifiersOf = (n: NodeFact | null): string[] => {
  const m = (n?.attributes as Record<string, unknown> | undefined)?.modifiers;
  return Array.isArray(m) ? m.map((x) => String(x).toLowerCase()) : [];
};

/**
 * The external entry points of one ApexClass node, from parser facts the
 * graph keeps: member methods' `httpVerbs` (`@HttpGet` ... mean the class is a
 * `@RestResource`; the class annotation itself is not stored), `isInvocable`,
 * `auraEnabled`, `isRemote`, `webservice` / `global` modifiers (class and
 * methods), and IMPLEMENTS edges to Schedulable, Database.Batchable,
 * Queueable and Messaging.InboundEmailHandler. An ApexTrigger whose
 * TRIGGERS_ON target is a platform event (`__e`) is an event subscriber:
 * the platform fires it when the event is published. Triggers are not in the
 * scored dead-code labels, so this matters when `dead_code_audit` is asked for
 * `label: ApexTrigger`. Other labels have none.
 */
export function externalEntryPoints(
  store: GraphStore,
  orgId: OrgId,
  node: NodeFact,
  members: readonly QualifiedName[],
): ExternalEntryPoint[] {
  if (node.label === "ApexTrigger") {
    // The Apex parser stores TRIGGERS_ON (trigger -> object); TRIGGER_FIRES_ON is the
    // name other graphs use for the same fact.
    for (const rel of [REL_TYPES.TRIGGERS_ON, REL_TYPES.TRIGGER_FIRES_ON]) {
      for (const e of store.listEdgesFrom(orgId, node.qualifiedName, rel)) {
        if (/__e$/i.test(String(e.dstQualifiedName))) return ["event_subscriber"];
      }
    }
    return [];
  }
  if (node.label !== "ApexClass") return [];
  const found = new Set<ExternalEntryPoint>();
  if (modifiersOf(node).includes("global")) found.add("global");
  for (const q of members) {
    const m = store.getNode(orgId, q);
    if (!m) continue;
    const a = m.attributes as Record<string, unknown>;
    if (Array.isArray(a.httpVerbs) && a.httpVerbs.length > 0) found.add("rest_resource");
    if (a.isInvocable === true) found.add("invocable_method");
    if (a.auraEnabled === true) found.add("aura_enabled");
    if (a.isRemote === true) found.add("remote_action");
    const mods = modifiersOf(m);
    if (mods.includes("webservice")) found.add("webservice");
    if (mods.includes("global")) found.add("global");
  }
  for (const e of store.listEdgesFrom(orgId, node.qualifiedName, REL_TYPES.IMPLEMENTS)) {
    const dst = String(e.dstQualifiedName);
    const name = dst.slice(dst.indexOf(":") + 1).toLowerCase();
    for (const [re, kind] of INTERFACE_KINDS) if (re.test(name)) found.add(kind);
  }
  return ORDER.filter((k) => found.has(k));
}

/** The entry points named in a score row's reasons. */
export function entryPointsFromReasons(reasons: readonly string[]): ExternalEntryPoint[] {
  return reasons
    .filter((r) => r.startsWith(ENTRY_POINT_REASON_PREFIX))
    .map((r) => r.slice(ENTRY_POINT_REASON_PREFIX.length) as ExternalEntryPoint);
}
