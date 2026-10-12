/**
 * Cycle 3 T2: the one plain-word dictionary of the server. Every graph label and relationship type
 * core defines has an entry (a vitest enumerates them from core); an unknown value falls back to a
 * spaced, lowercase form, never the raw constant.
 *
 * KIND_SHORT is the short kind a diagram node shows (`Apex class: CaseService`). Each short is
 * unique per label, except where the labels mean the same component to the diagram scorer (the
 * Lightning web component family), so bench/lib/normalise.mjs can map it back to the label.
 */

/** The layer of an app a kind belongs to, for the picture rule ("more than one layer"). */
export type Layer = "screen" | "logic" | "data" | "access" | "integration" | "setup";

interface KindEntry {
  /** Short kind, singular, sentence case. */
  short: string;
  /** A plain gloss shown in brackets after the short kind, when the short kind is a product term. */
  gloss?: string;
  /** Plural of the short kind, when adding "s" is wrong. */
  plural?: string;
  layer: Layer;
}

const K = (short: string, layer: Layer, gloss?: string, plural?: string): KindEntry => ({
  short,
  layer,
  ...(gloss !== undefined ? { gloss } : {}),
  ...(plural !== undefined ? { plural } : {}),
});

/** Every node label core defines, in plain words. */
export const PLAIN_KINDS: Readonly<Record<string, KindEntry>> = {
  // Code.
  ApexClass: K("Apex class", "logic", "server code", "Apex classes"),
  ApexTrigger: K("Apex trigger", "logic", "code that runs when records change"),
  ApexInterface: K("Apex interface", "logic", "a contract other server code follows"),
  ApexMethod: K("Apex method", "logic", "one routine inside server code"),
  TestMethod: K("Test method", "logic", "an automated check of server code"),
  ApexPage: K("Visualforce page", "screen", "an older-style page"),
  ApexComponent: K("Visualforce component", "screen", "a part of an older-style page"),
  LWC: K("Lightning web component", "screen", "a screen part"),
  LWCBundle: K("Lightning web component", "screen", "a screen part"),
  LightningComponentBundle: K("Lightning web component", "screen", "a screen part"),
  AuraComponent: K("Aura component", "screen", "an older-style screen part"),
  AuraDefinitionBundle: K("Aura bundle", "screen", "an older-style screen part"),
  // Declarative logic.
  Flow: K("Flow", "logic", "point-and-click automation"),
  FlowVersion: K("Flow version", "logic", "one saved version of a flow"),
  Workflow: K("Workflow", "logic", "older point-and-click automation"),
  WorkflowRule: K("Workflow rule", "logic", "older point-and-click automation"),
  WorkflowAlert: K("Workflow email alert", "logic", "an email sent by older automation"),
  ApprovalProcess: K(
    "Approval process",
    "logic",
    "steps for signing off a record",
    "Approval processes",
  ),
  ValidationRule: K("Validation rule", "logic", "a check that blocks bad data on save"),
  DuplicateRule: K("Duplicate rule", "logic", "a check for duplicate records"),
  MatchingRule: K("Matching rule", "logic", "how duplicate records are spotted"),
  GenAiPlanner: K("Agent planner", "logic", "how an AI agent picks its steps"),
  GenAiPlugin: K("Agent topic", "logic", "a group of AI agent actions"),
  // OmniStudio / Vlocity.
  OmniScript: K("OmniScript", "screen", "guided screen flow"),
  IntegrationProcedure: K("Integration Procedure", "logic", "server-side data steps"),
  DataRaptor: K("DataRaptor", "data", "a data mapper that reads or writes records"),
  VlocityCard: K("FlexCard", "screen", "a summary card on a page"),
  OmniProcess: K(
    "Omni process",
    "logic",
    "a standard-runtime OmniScript or Integration Procedure",
    "Omni processes",
  ),
  OmniIntegrationProcedure: K(
    "Omni integration procedure",
    "logic",
    "standard-runtime server-side data steps",
  ),
  OmniDataTransform: K("Omni data mapper", "data", "standard-runtime DataRaptor"),
  OmniUiCard: K("Omni FlexCard", "screen", "standard-runtime summary card"),
  Remote: K("Remote action", "integration", "server code called from OmniStudio"),
  // Schema.
  CustomObject: K("Object", "data", "a table of records"),
  CustomField: K("Field", "data"),
  CustomSetting: K("Custom setting", "setup", "app settings stored in the org"),
  CustomMetadataType: K("Custom metadata type", "setup", "a table of deployable settings"),
  CustomMetadataRecord: K("Custom metadata record", "setup", "one deployable setting"),
  PlatformEvent: K("Platform event", "integration", "a message other parts can listen for"),
  PlatformEventChannel: K("Event channel", "integration", "a stream of change messages"),
  // Integration endpoints.
  NamedCredential: K("Named credential", "integration", "a saved login for an outside system"),
  ExternalCredential: K("External credential", "integration", "how a saved login authenticates"),
  ExternalServiceRegistration: K(
    "External service",
    "integration",
    "an outside system's API described for Salesforce",
  ),
  ConnectedApp: K("Connected app", "integration", "an outside app allowed to sign in"),
  RemoteSiteSetting: K("Remote site setting", "integration", "an outside address the org may call"),
  // Access configuration.
  Profile: K("Profile", "access", "a user's base permissions"),
  PermissionSet: K("Permission set", "access", "extra permissions given to users"),
  PermissionSetGroup: K("Permission set group", "access", "a bundle of permission sets"),
  SharingRule: K("Sharing rule", "access", "who else can see records"),
  Role: K("Role", "access", "a place in the record-visibility hierarchy"),
  Group: K("Group", "access", "a named set of users"),
  Queue: K("Queue", "access", "a shared inbox for records"),
  // UI configuration.
  Layout: K("Page layout", "screen", "which fields a record page shows"),
  FlexiPage: K("Lightning page", "screen", "a page built in the page builder"),
  CustomTab: K("Tab", "screen"),
  RecordType: K("Record type", "data", "a variant of a record with its own picklists and layout"),
  Network: K("Experience site", "screen", "a portal or community site"),
  // Content, analytics and setup.
  CustomLabel: K("Custom label", "setup", "translatable text"),
  StaticResource: K("Static resource", "setup", "an uploaded file such as a script or image"),
  EmailTemplate: K("Email template", "setup"),
  Report: K("Report", "data"),
  Dashboard: K("Dashboard", "data"),
  // Diagnostics.
  ParseError: K("Unreadable file", "setup", "a file sfgraph could not read"),
  OpaqueMetadata: K("Other setup item", "setup", "metadata sfgraph lists but does not read inside"),
};

/** The diagram node prefix of each label: the short kind with no gloss. */
export const KIND_SHORT: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(PLAIN_KINDS).map(([label, e]) => [label, e.short]),
);

/** Every relationship type core defines, as a verb phrase read from source to target. */
export const PLAIN_RELS: Readonly<Record<string, string>> = {
  READS_FIELD: "reads the field",
  WRITES_FIELD: "writes the field",
  CALLS: "calls",
  CALLS_DR: "calls the DataRaptor",
  EXTENDS: "extends",
  IMPLEMENTS: "implements",
  REFERENCES: "refers to",
  CONTAINS: "contains",
  USES_LWC: "uses the Lightning web component",
  TRIGGERS_ON: "runs when records change on",
  GRANTS: "gives access to",
  QUERIES: "looks up records of",
  OVERRIDES: "overrides",
  CONTAINS_METHOD: "has the method",
  EXECUTES_SOQL: "looks up records of",
  EXECUTES_DML: "saves records of",
  EXECUTES_SOSL: "searches records of",
  INVOKES_REMOTE_ACTION: "calls the remote action",
  CALLS_NAMED_CREDENTIAL: "calls out through",
  IS_TEST_FOR: "tests",
  IMPORTS_APEX: "imports the Apex method",
  USES_WIRE: "loads data with",
  CALLS_APEX_FROM_LWC: "calls the Apex method",
  IMPORTS_STATIC_RESOURCE: "loads the static resource",
  IMPORTS_CUSTOM_LABEL: "uses the custom label",
  DISPATCHES_EVENT: "sends the event",
  LISTENS_TO_EVENT: "listens for the event",
  EMBEDS_LWC: "shows the Lightning web component",
  EMBEDS_AURA: "shows the Aura component",
  CONTAINS_COMPONENT: "contains the component",
  LWC_BINDS_FIELD: "shows the field",
  LWC_BINDS_PROPERTY: "shows the value",
  FLOW_INVOKES_APEX: "runs the Apex class",
  FLOW_INVOKES_APEX_METHOD: "runs the Apex method",
  FLOW_INVOKES_SUBFLOW: "runs the subflow",
  FLOW_INVOKES_ACTION: "runs the action",
  REFERENCES_OBJECT: "uses the object",
  TRIGGER_FIRES_ON: "runs when records change on",
  DEFINES_FIELD: "has the field",
  HAS_RECORD_TYPE: "has the record type",
  HAS_VALIDATION_RULE: "has the validation rule",
  DR_READS_FIELD: "reads the field",
  DR_WRITES_FIELD: "writes the field",
  DR_TRANSFORMS: "reshapes data for",
  IP_CALLS_DR: "calls the DataRaptor",
  IP_CALLS_IP: "calls the Integration Procedure",
  IP_INVOKES_REMOTE: "calls the remote action",
  OS_USES_DR: "uses the DataRaptor",
  OS_CALLS_IP: "calls the Integration Procedure",
  OS_EMBEDS_VC: "shows the FlexCard",
  OS_INVOKES_REMOTE: "calls the remote action",
  VC_USES_DR: "uses the DataRaptor",
  VC_CALLS_IP: "calls the Integration Procedure",
  EMBEDS_VC: "shows the FlexCard",
  VC_EMBEDS_LWC: "shows the Lightning web component",
  VC_INVOKES_REMOTE: "calls the remote action",
  OS_EMBEDS_OS: "includes the OmniScript",
  OS_EMBEDS_LWC: "shows the Lightning web component",
  APEX_CALLS_IP: "calls the Integration Procedure",
  APEX_CALLS_DR: "calls the DataRaptor",
  LWC_CALLS_IP: "calls the Integration Procedure",
  VLOCITY_INVOKES_APEX: "calls the Apex class",
  VLOCITY_INVOKES_APEX_METHOD: "calls the Apex method",
  OMNI_CALLS_DATA_TRANSFORM: "calls the data mapper",
  OMNI_CALLS_INTEGRATION_PROCEDURE: "calls the Integration Procedure",
  OMNI_EMBEDS_UI_CARD: "shows the FlexCard",
  OMNI_INVOKES_REMOTE: "calls the remote action",
  OMNI_USES_DATA_TRANSFORM: "uses the data mapper",
  GRANTS_OBJECT_ACCESS: "gives access to the object",
  GRANTS_FIELD_ACCESS: "gives access to the field",
  GRANTS_APEX_ACCESS: "gives access to the Apex class",
  GRANTS_PAGE_ACCESS: "gives access to the page",
  GRANTS_TAB_ACCESS: "gives access to the tab",
  SHARING_GRANTS: "shares records of",
  SHARING_TO_GROUP: "shares records with the group",
  SHARING_TO_ROLE: "shares records with the role",
  SHARING_FROM_OWNER_GROUP: "shares records owned by",
  ESR_USES_NAMED_CREDENTIAL: "connects through",
  PUBLISHES_EVENT: "publishes the event",
  SUBSCRIBES_TO_EVENT: "listens for the event",
  CANONICAL_OF: "is the same component as",
  CONTROLLED_BY: "is driven by the controller",
  EXTENDS_CONTROLLER: "extends the controller",
  RENDERS_FIELD: "shows the field",
  REPORTS_ON: "reports on",
  DASHBOARD_USES_REPORT: "shows the report",
  PLANNER_USES_PLUGIN: "uses the agent topic",
  PLUGIN_INVOKES_FUNCTION: "runs the agent action",
  NETWORK_USES_BUNDLE: "uses the site component",
  WORKFLOW_TRIGGERS: "runs",
  WORKFLOW_UPDATES_FIELD: "updates the field",
  APPROVAL_USES_FORMULA: "uses the formula",
  INSTANCE_OF: "is a record of",
  REFERENCES_LABEL: "uses the custom label",
  GRANTS_USER_PERMISSION: "gives the user permission",
  USES_GLOBAL_VALUE_SET: "takes its picklist values from",
  DEPENDS_ON_FIELD: "depends on the field",
};

/** `FooBarBaz` / `SOME_REL` / `XMLThing` -> `foo bar baz` / `some rel` / `xml thing`. */
export function spacedLower(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_\s]+/g, " ")
    .trim()
    .toLowerCase();
}

function pluralWord(w: string): string {
  if (/(s|x|z|ch|sh)$/i.test(w)) return `${w}es`;
  if (/[^aeiou]y$/i.test(w)) return `${w.slice(0, -1)}ies`;
  return `${w}s`;
}

/** The plural of a phrase: its last word made plural. */
function pluralPhrase(p: string): string {
  const i = p.lastIndexOf(" ");
  return i < 0 ? pluralWord(p) : `${p.slice(0, i + 1)}${pluralWord(p.slice(i + 1))}`;
}

/** Words that follow the head noun of a gloss ("a table *of* records", "a check *that* blocks"). */
const AFTER_HEAD = new Set(
  "of for inside that on in sent other allowed such built sfgraph described the can may could follows".split(
    " ",
  ),
);

/**
 * The plural of a gloss that starts with an article: "a table of records" -> "tables of records",
 * "a screen part" -> "screen parts". A gloss with no article ("server code") is kept, and so is
 * one whose head noun is already plural ("a user's base permissions").
 */
export function pluralGloss(gloss: string): string {
  const m = /^(?:a|an|one) (.+)$/.exec(gloss);
  if (!m) return gloss;
  const words = m[1]!.split(" ");
  let head = words.findIndex((_, i) => i + 1 < words.length && AFTER_HEAD.has(words[i + 1]!));
  if (head < 0) {
    head = words.length - 1;
    if (/s$/.test(words[head]!)) return gloss;
  }
  words[head] = pluralWord(words[head]!);
  return words.join(" ");
}

/** A label in plain words: "Apex class (server code)"; the plural form on request. */
export function plainKind(label: string, opts: { plural?: boolean } = {}): string {
  const e = PLAIN_KINDS[label];
  if (!e) {
    const s = spacedLower(label) || "component";
    return opts.plural ? pluralPhrase(s) : s;
  }
  const short = opts.plural ? (e.plural ?? pluralPhrase(e.short)) : e.short;
  if (!e.gloss) return short;
  return `${short} (${opts.plural ? pluralGloss(e.gloss) : e.gloss})`;
}

/** A relationship type in plain words: "calls", "reads the field". */
export function plainRel(relType: string): string {
  return PLAIN_RELS[relType] ?? (spacedLower(relType) || "is linked to");
}

/** The layer of a label; an unknown label is setup. */
export function layerOfKind(label: string): Layer {
  return PLAIN_KINDS[label]?.layer ?? "setup";
}
