/**
 * Map node label → Salesforce metadata API type used in package.xml.
 * Covers the ~30 most-common metadata types Phase 6 ships parsers for.
 */
export const LABEL_TO_METADATA_TYPE: Record<string, string> = {
  ApexClass: "ApexClass",
  ApexTrigger: "ApexTrigger",
  ApexPage: "ApexPage",
  ApexComponent: "ApexComponent",
  LightningComponentBundle: "LightningComponentBundle",
  // The LWC parser labels bundle nodes "LWC".
  LWC: "LightningComponentBundle",
  AuraDefinitionBundle: "AuraDefinitionBundle",
  Flow: "Flow",
  CustomObject: "CustomObject",
  CustomField: "CustomField",
  Profile: "Profile",
  PermissionSet: "PermissionSet",
  PermissionSetGroup: "PermissionSetGroup",
  SharingRule: "SharingRules",
  NamedCredential: "NamedCredential",
  ExternalServiceRegistration: "ExternalServiceRegistration",
  PlatformEventChannel: "PlatformEventChannel",
  CustomLabel: "CustomLabels",
  CustomMetadataType: "CustomObject",
  CustomMetadataRecord: "CustomMetadata",
  StaticResource: "StaticResource",
  Layout: "Layout",
  RecordType: "RecordType",
  ValidationRule: "ValidationRule",
  Workflow: "Workflow",
  WorkflowRule: "WorkflowRule",
  ApprovalProcess: "ApprovalProcess",
  Queue: "Queue",
  Group: "Group",
  Role: "Role",
  ConnectedApp: "ConnectedApp",
  RemoteSiteSetting: "RemoteSiteSetting",
  EmailTemplate: "EmailTemplate",
  Report: "Report",
  Dashboard: "Dashboard",
  FlexiPage: "FlexiPage",
  DuplicateRule: "DuplicateRule",
  MatchingRule: "MatchingRules",
  Network: "Network",
  GenAiPlanner: "GenAiPlanner",
  GenAiPlugin: "GenAiPlugin",
};

/** Metadata type names a GenAiPlanner node may carry as `metadataType`. */
const PLANNER_SOURCE_TYPES = new Set(["GenAiPlannerBundle"]);

/**
 * The package.xml type for a node. Planner nodes share one label whichever way
 * they were retrieved, so they carry the source type in `metadataType`
 * only when it differs from `GenAiPlanner` (GenAiPlannerBundle on API 64+).
 * Plain `GenAiPlanner` members and nodes ingested before the attribute
 * existed use `GenAiPlanner`.
 */
export function metadataTypeFor(
  label: string,
  attributes?: Record<string, unknown> | null,
): string | undefined {
  if (label === "GenAiPlanner") {
    const t = attributes?.metadataType;
    if (typeof t === "string" && PLANNER_SOURCE_TYPES.has(t)) return t;
  }
  return LABEL_TO_METADATA_TYPE[label];
}
