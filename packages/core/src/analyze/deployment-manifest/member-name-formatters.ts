/**
 * Convert a sfgraph qualifiedName ("Label:Name" or "Label:Object.Field") into
 * a package.xml member name (just the name portion, sometimes Object.Field).
 */
export type MemberNameFormatter = (qname: string) => string;

const STRIP_LABEL: MemberNameFormatter = (q) => {
  const idx = q.indexOf(":");
  return idx === -1 ? q : q.slice(idx + 1);
};

const OBJECT_DOT_FIELD: MemberNameFormatter = (q) => STRIP_LABEL(q); // "Account.Foo__c"

const SHARING_RULES: MemberNameFormatter = (q) => {
  // SharingRule:Account.Rule1 → Account
  const after = STRIP_LABEL(q);
  return after.split(".")[0] ?? after;
};

export const FORMATTERS: Record<string, MemberNameFormatter> = {
  ApexClass: STRIP_LABEL,
  ApexTrigger: STRIP_LABEL,
  ApexPage: STRIP_LABEL,
  ApexComponent: STRIP_LABEL,
  LightningComponentBundle: STRIP_LABEL,
  AuraDefinitionBundle: STRIP_LABEL,
  Flow: STRIP_LABEL,
  CustomObject: STRIP_LABEL,
  CustomField: OBJECT_DOT_FIELD,
  Profile: STRIP_LABEL,
  PermissionSet: STRIP_LABEL,
  PermissionSetGroup: STRIP_LABEL,
  SharingRule: SHARING_RULES,
  NamedCredential: STRIP_LABEL,
  ExternalServiceRegistration: STRIP_LABEL,
  PlatformEventChannel: STRIP_LABEL,
  CustomLabel: STRIP_LABEL,
  CustomMetadataType: STRIP_LABEL,
  CustomMetadataRecord: STRIP_LABEL,
  StaticResource: STRIP_LABEL,
  Layout: STRIP_LABEL,
  RecordType: OBJECT_DOT_FIELD,
  ValidationRule: OBJECT_DOT_FIELD,
  Workflow: STRIP_LABEL,
  WorkflowRule: OBJECT_DOT_FIELD,
  ApprovalProcess: STRIP_LABEL,
  Queue: STRIP_LABEL,
  Group: STRIP_LABEL,
  Role: STRIP_LABEL,
  ConnectedApp: STRIP_LABEL,
  RemoteSiteSetting: STRIP_LABEL,
  EmailTemplate: STRIP_LABEL,
  Report: STRIP_LABEL,
  Dashboard: STRIP_LABEL,
  FlexiPage: STRIP_LABEL,
  DuplicateRule: STRIP_LABEL,
  MatchingRule: STRIP_LABEL,
  Network: STRIP_LABEL,
  GenAiPlanner: STRIP_LABEL,
  GenAiPlugin: STRIP_LABEL,
};

export function formatMemberName(label: string, qname: string): string {
  const f = FORMATTERS[label] ?? STRIP_LABEL;
  return f(qname);
}
